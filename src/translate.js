/**
 * Anthropic Messages API <-> OpenAI chat/completions translation.
 * Claude Code only ever speaks Anthropic; NIM only ever speaks OpenAI.
 */

let counter = 0;
export function newId(prefix) {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}`;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && (b.type === 'text' || typeof b.text === 'string'))
    .map((b) => b.text || '')
    .join('\n');
}

/** Some NIM backends reject JSON Schema keywords they do not implement. */
function sanitizeSchema(node, depth = 0) {
  if (Array.isArray(node)) return node.map((n) => sanitizeSchema(n, depth + 1));
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === '$schema' || key === '$id' || key === 'additionalProperties') continue;
    if (key === 'format' && depth > 0 && !['date-time', 'date', 'time'].includes(value)) continue;
    out[key] = sanitizeSchema(value, depth + 1);
  }
  return out;
}

function imagePart(block) {
  const src = block.source || {};
  if (src.type === 'base64') {
    return { type: 'image_url', image_url: { url: `data:${src.media_type};base64,${src.data}` } };
  }
  if (src.type === 'url') return { type: 'image_url', image_url: { url: src.url } };
  return null;
}

/**
 * Anthropic puts tool results inside the *user* turn; OpenAI wants them as
 * standalone `tool` messages that come first. We split accordingly.
 */
function pushUser(out, content) {
  if (typeof content === 'string') {
    if (content.trim()) out.push({ role: 'user', content });
    return;
  }
  const blocks = Array.isArray(content) ? content : [];
  const toolResults = blocks.filter((b) => b?.type === 'tool_result');
  const rest = blocks.filter((b) => b?.type !== 'tool_result');

  for (const tr of toolResults) {
    let body = typeof tr.content === 'string' ? tr.content : textOf(tr.content);
    if (!body) body = tr.is_error ? 'Error' : '';
    out.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: body });
  }

  const parts = [];
  for (const b of rest) {
    if (b.type === 'text') parts.push({ type: 'text', text: b.text || '' });
    else if (b.type === 'image') {
      const img = imagePart(b);
      if (img) parts.push(img);
    }
  }
  if (!parts.length) return;
  const onlyText = parts.every((p) => p.type === 'text');
  out.push({ role: 'user', content: onlyText ? parts.map((p) => p.text).join('\n') : parts });
}

function pushAssistant(out, content) {
  if (typeof content === 'string') {
    out.push({ role: 'assistant', content });
    return;
  }
  const blocks = Array.isArray(content) ? content : [];
  const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text || '').join('\n');
  const toolCalls = blocks
    .filter((b) => b?.type === 'tool_use')
    .map((b) => ({
      id: b.id,
      type: 'function',
      function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
    }));

  const msg = { role: 'assistant', content: text || null };
  if (toolCalls.length) msg.tool_calls = toolCalls;
  if (msg.content === null && !toolCalls.length) return;
  out.push(msg);
}

export function anthropicToOpenAI(body, { model, maxTokens }) {
  const messages = [];

  const system = typeof body.system === 'string' ? body.system : textOf(body.system);
  if (system && system.trim()) messages.push({ role: 'system', content: system });

  for (const m of body.messages || []) {
    if (m.role === 'assistant') pushAssistant(messages, m.content);
    else pushUser(messages, m.content);
  }

  const req = {
    model,
    messages,
    stream: Boolean(body.stream),
  };

  const limit = maxTokens || body.max_tokens;
  if (limit) req.max_tokens = limit;
  if (typeof body.temperature === 'number') req.temperature = body.temperature;
  if (typeof body.top_p === 'number') req.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) req.stop = body.stop_sequences;
  if (req.stream) req.stream_options = { include_usage: true };

  if (Array.isArray(body.tools) && body.tools.length) {
    req.tools = body.tools
      .filter((t) => t && t.name && !String(t.type || '').startsWith('computer_'))
      .map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description || '',
          parameters: sanitizeSchema(t.input_schema || { type: 'object', properties: {} }),
        },
      }));
    if (!req.tools.length) delete req.tools;
  }

  if (req.tools && body.tool_choice) {
    const tc = body.tool_choice;
    if (tc.type === 'auto') req.tool_choice = 'auto';
    else if (tc.type === 'any') req.tool_choice = 'required';
    else if (tc.type === 'none') req.tool_choice = 'none';
    else if (tc.type === 'tool' && tc.name) {
      req.tool_choice = { type: 'function', function: { name: tc.name } };
    }
  }

  return req;
}

export function mapStopReason(reason, hadToolCall) {
  if (hadToolCall) return 'tool_use';
  switch (reason) {
    case 'length': return 'max_tokens';
    case 'tool_calls':
    case 'function_call': return 'tool_use';
    case 'content_filter': return 'end_turn';
    case 'stop': return 'end_turn';
    default: return 'end_turn';
  }
}

/** Reasoning models leak their scratchpad into the reply; Claude Code has no place to put it. */
export function stripThinkTags(text) {
  if (!text) return text;
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^\s*<\/think>/, '');
}

export function openAIToAnthropic(resp, model) {
  const choice = resp?.choices?.[0] || {};
  const msg = choice.message || {};
  const content = [];

  const text = stripThinkTags(msg.content || '');
  if (text.trim()) content.push({ type: 'text', text });

  for (const call of msg.tool_calls || []) {
    let input = {};
    try {
      input = JSON.parse(call.function?.arguments || '{}');
    } catch {
      input = { _raw: call.function?.arguments || '' };
    }
    content.push({ type: 'tool_use', id: call.id || newId('toolu'), name: call.function?.name, input });
  }

  if (!content.length) content.push({ type: 'text', text: '' });

  return {
    id: resp?.id || newId('msg'),
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: mapStopReason(choice.finish_reason, (msg.tool_calls || []).length > 0),
    stop_sequence: null,
    usage: {
      input_tokens: resp?.usage?.prompt_tokens ?? 0,
      output_tokens: resp?.usage?.completion_tokens ?? 0,
    },
  };
}

/** Rough char-based estimate — NIM exposes no token counting endpoint. */
export function estimateTokens(body) {
  let chars = 0;
  const walk = (v) => {
    if (typeof v === 'string') chars += v.length;
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(body.system);
  walk(body.messages);
  walk(body.tools);
  return Math.max(1, Math.ceil(chars / 4));
}
