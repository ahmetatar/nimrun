import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { createProxy, listen } from './proxy.js';
import { PROVIDERS } from './config.js';
import * as ui from './ui.js';

const { glyph: g } = ui;

/**
 * Claude Code inherits its provider config purely from the environment, so we
 * never touch the user's settings files. When this process exits the child dies
 * with it, the proxy closes, and the machine is back to its previous state.
 */
export async function runClaude({
  apiKey, model, smallModel, maxTokens,
  baseUrl, provider = 'nvidia',
  claudeArgs = [], debug = false, bin = 'claude', port: fixedPort = 0, contextTokens = null,
  concurrency = 1,
}) {
  const token = crypto.randomBytes(24).toString('hex');
  const stats = { requests: 0, inputTokens: 0, outputTokens: 0, errors: 0 };
  const server = createProxy({ apiKey, model, smallModel, maxTokens, token, baseUrl, provider, debug, stats, concurrency });
  const port = await listen(server, { host: '127.0.0.1', port: fixedPort || 0 });

  const env = {
    ...process.env,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_AUTH_TOKEN: token,
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_SMALL_FAST_MODEL: smallModel || model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: smallModel || model,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    PALIMORPH_ACTIVE: '1',
    PALIMORPH_MODEL: model,
  };
  // A stale credential in the ambient environment would outrank our local token.
  // ANTHROPIC_API_KEY in particular makes Claude Code disable claude.ai connectors,
  // so the auth token is the only credential we set.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN_FILE;
  if (maxTokens) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(maxTokens);
  // Claude Code does not know NIM model ids, so it assumes a 200k window unless told.
  if (contextTokens) env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(contextTokens);

  // Always show the background model: when it is the main model, Claude Code's
  // background calls spend that model's per-model quota, which is the usual cause
  // of a 429 on the very first turn.
  const rows = [['provider', PROVIDERS[provider]?.label || provider], ['model', ui.fg(ui.GLOW, model)]];
  rows.push(['fast', smallModel && smallModel !== model
    ? smallModel
    : `${ui.faint('same as model')} ${ui.faint(`${g.dot} --small <id> spares its quota`)}`]);
  rows.push(['proxy', `127.0.0.1:${port}  ${ui.faint(`anthropic ${g.swap} openai`)}`]);
  if (maxTokens) rows.push(['max out', String(maxTokens)]);
  if (contextTokens) rows.push(['context', contextTokens.toLocaleString('en-US')]);
  if (concurrency > 1) rows.push(['parallel', `${concurrency} upstream requests`]);
  ui.write(ui.card(rows, { title: `${g.bullet} session` }));
  ui.write(`  ${ui.faint(`starting ${bin} ${g.dot} settings restored on exit`)}\n\n`);

  const child = spawn(bin, claudeArgs, { stdio: 'inherit', env });

  const forward = (sig) => () => { if (!child.killed) child.kill(sig); };
  const onInt = forward('SIGINT');
  const onTerm = forward('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);

  const code = await new Promise((resolve) => {
    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        ui.write('\n' + ui.fail(`${ui.bold(bin)} is not on your PATH.`));
        ui.write(`  ${ui.faint('install it with')} ${ui.cyan('npm i -g @anthropic-ai/claude-code')}\n`);
        resolve(127);
      } else {
        ui.write('\n' + ui.fail(`could not start ${ui.bold(bin)}: ${err.message}`));
        resolve(1);
      }
    });
    child.on('exit', (c, signal) => resolve(signal ? 129 : (c ?? 0)));
  });

  process.off('SIGINT', onInt);
  process.off('SIGTERM', onTerm);
  await new Promise((r) => server.close(r));

  if (stats.requests) {
    const n = (v) => v.toLocaleString('en-US');
    ui.write(ui.card([
      ['model', model],
      ['requests', `${n(stats.requests)}${stats.errors ? `  ${ui.red(`${stats.errors} failed`)}` : ''}`],
      ['tokens', `${ui.faint('in')} ${n(stats.inputTokens)}   ${ui.faint('out')} ${n(stats.outputTokens)}`],
    ], { title: 'session ended', accent: ui.FAINT }));
    ui.write(`  ${ui.faint('proxy closed · environment restored')}\n\n`);
  }
  return code;
}
