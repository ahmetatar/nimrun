import { newId, mapStopReason, stripThinkTags } from './translate.js';

/**
 * Turns an OpenAI delta stream into the Anthropic SSE event sequence Claude Code
 * expects. Anthropic indexes content blocks, so we open/close blocks as the
 * upstream switches between prose and tool arguments.
 */
export class AnthropicStreamWriter {
  constructor(res, model, { onLog } = {}) {
    this.res = res;
    this.model = model;
    this.onLog = onLog;
    this.messageId = newId('msg');
    this.index = -1;
    this.openBlock = null; // 'text' | 'tool'
    this.toolSlots = new Map(); // upstream tool_call index -> our block index
    this.hadToolCall = false;
    this.finishReason = null;
    this.usage = { input_tokens: 0, output_tokens: 0 };
    this.started = false;
    this.ended = false;
    this.insideThink = false;
  }

  #send(event, data) {
    if (this.res.writableEnded) return;
    this.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    this.#send('message_start', {
      type: 'message_start',
      message: {
        id: this.messageId,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: this.usage,
      },
    });
  }

  /** Keeps the connection warm while a cold model spins up. */
  ping() {
    if (this.ended) return;
    this.#send('ping', { type: 'ping' });
  }

  #closeBlock() {
    if (this.openBlock === null) return;
    this.#send('content_block_stop', { type: 'content_block_stop', index: this.index });
    this.openBlock = null;
  }

  #openText() {
    if (this.openBlock === 'text') return;
    this.#closeBlock();
    this.index += 1;
    this.openBlock = 'text';
    this.#send('content_block_start', {
      type: 'content_block_start',
      index: this.index,
      content_block: { type: 'text', text: '' },
    });
  }

  text(chunk) {
    if (!chunk) return;
    // Some reasoning models emit their scratchpad inline rather than in
    // reasoning_content; swallow it rather than showing it as an answer.
    let out = '';
    let rest = chunk;
    while (rest) {
      if (this.insideThink) {
        const close = rest.indexOf('</think>');
        if (close === -1) return;
        this.insideThink = false;
        rest = rest.slice(close + 8);
        continue;
      }
      const open = rest.indexOf('<think>');
      if (open === -1) { out += rest; break; }
      out += rest.slice(0, open);
      this.insideThink = true;
      rest = rest.slice(open + 7);
    }
    if (!out) return;
    this.#openText();
    this.#send('content_block_delta', {
      type: 'content_block_delta',
      index: this.index,
      delta: { type: 'text_delta', text: out },
    });
  }

  toolCall(call) {
    const slot = call.index ?? 0;
    if (!this.toolSlots.has(slot)) {
      this.#closeBlock();
      this.index += 1;
      this.toolSlots.set(slot, this.index);
      this.openBlock = 'tool';
      this.hadToolCall = true;
      this.#send('content_block_start', {
        type: 'content_block_start',
        index: this.index,
        content_block: {
          type: 'tool_use',
          id: call.id || newId('toolu'),
          name: call.function?.name || 'unknown',
          input: {},
        },
      });
    }
    const partial = call.function?.arguments;
    if (partial) {
      this.#send('content_block_delta', {
        type: 'content_block_delta',
        index: this.toolSlots.get(slot),
        delta: { type: 'input_json_delta', partial_json: partial },
      });
    }
  }

  chunk(payload) {
    this.start();
    if (payload.usage) {
      this.usage.input_tokens = payload.usage.prompt_tokens ?? this.usage.input_tokens;
      this.usage.output_tokens = payload.usage.completion_tokens ?? this.usage.output_tokens;
    }
    const choice = payload.choices?.[0];
    if (!choice) return;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string') this.text(delta.content);
    for (const call of delta.tool_calls || []) this.toolCall(call);
    if (choice.finish_reason) this.finishReason = choice.finish_reason;
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    this.start();
    if (this.openBlock === null && this.index === -1) this.#openText();
    this.#closeBlock();
    this.#send('message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: mapStopReason(this.finishReason, this.hadToolCall),
        stop_sequence: null,
      },
      usage: { output_tokens: this.usage.output_tokens },
    });
    this.#send('message_stop', { type: 'message_stop' });
    this.res.end();
  }

  fail(message) {
    if (this.started) {
      this.text(`\n[nimrun] upstream error: ${message}`);
      this.end();
      return;
    }
    this.res.writeHead(502, { 'Content-Type': 'application/json' });
    this.res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message } }));
  }
}

/** Incremental SSE line parser for the upstream OpenAI stream. */
export function createSSEParser(onEvent) {
  let buffer = '';
  return {
    push(text) {
      buffer += text;
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          onEvent(JSON.parse(data));
        } catch {
          /* keep-alive or partial frame; ignore */
        }
      }
    },
  };
}

export { stripThinkTags };
