import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { createProxy, listen } from './proxy.js';
import { color as c } from './picker.js';

/**
 * Claude Code inherits its provider config purely from the environment, so we
 * never touch the user's settings files. When this process exits the child dies
 * with it, the proxy closes, and the machine is back to its previous state.
 */
export async function runClaude({ apiKey, model, smallModel, maxTokens, claudeArgs = [], debug = false, bin = 'claude', port: fixedPort = 0 }) {
  const token = crypto.randomBytes(24).toString('hex');
  const server = createProxy({ apiKey, model, smallModel, maxTokens, token, debug });
  const port = await listen(server, { host: '127.0.0.1', port: fixedPort || 0 });
  const baseUrl = `http://127.0.0.1:${port}`;

  const env = {
    ...process.env,
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: token,
    ANTHROPIC_API_KEY: token,
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_SMALL_FAST_MODEL: smallModel || model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: smallModel || model,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    NIMRUN_ACTIVE: '1',
    NIMRUN_MODEL: model,
  };
  // A stale key in the ambient environment would outrank our local token.
  delete env.ANTHROPIC_AUTH_TOKEN_FILE;
  if (maxTokens) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(maxTokens);

  process.stderr.write(
    `${c.green}●${c.reset} nimrun → ${c.bold}${model}${c.reset}${smallModel && smallModel !== model ? ` ${c.dim}(fast: ${smallModel})${c.reset}` : ''}\n` +
    `  ${c.dim}proxy ${baseUrl} · settings restored on exit${c.reset}\n\n`
  );

  const child = spawn(bin, claudeArgs, { stdio: 'inherit', env });

  const forward = (sig) => () => { if (!child.killed) child.kill(sig); };
  const onInt = forward('SIGINT');
  const onTerm = forward('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);

  const code = await new Promise((resolve) => {
    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        process.stderr.write(
          `${c.yellow}!${c.reset} '${bin}' not found on PATH.\n` +
          `  Install it with: npm i -g @anthropic-ai/claude-code\n`
        );
        resolve(127);
      } else {
        process.stderr.write(`${c.yellow}!${c.reset} failed to start '${bin}': ${err.message}\n`);
        resolve(1);
      }
    });
    child.on('exit', (code, signal) => resolve(signal ? 128 + 1 : (code ?? 0)));
  });

  process.off('SIGINT', onInt);
  process.off('SIGTERM', onTerm);
  await new Promise((r) => server.close(r));
  return code;
}
