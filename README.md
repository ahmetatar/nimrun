<div align="center">

<img src="https://raw.githubusercontent.com/ahmetatar/nimrun/main/docs/media/hero.png" alt="nimrun" width="820">

**Run [Claude Code](https://claude.com/claude-code) against any model on [build.nvidia.com](https://build.nvidia.com/models).**

[![npm](https://img.shields.io/npm/v/nimrun?color=76b900&labelColor=0b0e14)](https://www.npmjs.com/package/nimrun)
[![license](https://img.shields.io/npm/l/nimrun?color=76b900&labelColor=0b0e14)](./LICENSE)
[![node](https://img.shields.io/node/v/nimrun?color=76b900&labelColor=0b0e14)](https://nodejs.org)

</div>

---

Pick a model from NVIDIA's NIM catalog and `nimrun` launches Claude Code wired to it.
When that process exits, nothing is left behind — your Claude Code settings files are
never touched.

```bash
npx nimrun
```

## Why a proxy is involved

NIM only exposes an **OpenAI-compatible** API. Claude Code's `ANTHROPIC_BASE_URL` only
speaks the **Anthropic Messages API**. Setting environment variables alone will not
connect them — the first request 404s.

So `nimrun` starts a translation proxy on loopback for the life of the session:

```
claude ──Anthropic /v1/messages──▶ nimrun proxy ──OpenAI /v1/chat/completions──▶ integrate.api.nvidia.com
       ◀──Anthropic SSE events───               ◀──OpenAI delta stream─────────
```

It translates system prompts, multi-part content, images, tool definitions, tool calls,
tool results, stop reasons, usage, and the full streaming event sequence. The proxy binds
to `127.0.0.1` on an ephemeral port and requires a random per-run token, so nothing else
on the machine can reach it. It dies with the process.

## Setup

`nimrun login` does **not** open a browser — NVIDIA has no OAuth flow for NIM, so the key
is pasted once:

1. Sign in at [build.nvidia.com](https://build.nvidia.com/models) (free account).
2. Open any model page and use **Get API Key**.
3. Copy the `nvapi-…` key.

```bash
nimrun login                    # stored at ~/.nimrun/config.json, mode 0600
# or
export NVIDIA_API_KEY=nvapi-…   # env always wins; never written to disk
```

Claude Code itself must be installed:

```bash
npm i -g @anthropic-ai/claude-code
```

## Usage

```bash
nimrun                              # pick a model, launch Claude Code
nimrun --last                       # reuse your last pick
nimrun qwen/qwen3-coder-480b-a35b-instruct
nimrun --tools-only                 # only models known to do tool calling
nimrun models                       # print the catalog (plain stdout, pipe-safe)
nimrun status                       # key, endpoint, connectivity, last model
nimrun fav moonshotai/kimi-k2-instruct   # pin to the top of the picker
nimrun -- -p "summarize this repo"  # everything after -- goes to claude
```

### The picker

Start typing to narrow the catalog; matches are underlined as you type.
`↑↓` to move, `⏎` to select, `esc` to quit.

<img src="https://raw.githubusercontent.com/ahmetatar/nimrun/main/docs/media/picker.png" alt="model picker filtering on 'coder'" width="820">

### The session

<img src="https://raw.githubusercontent.com/ahmetatar/nimrun/main/docs/media/session.png" alt="session card shown at launch" width="560">

Claude Code runs normally from here. On exit you get the tally, and the proxy is gone:

<img src="https://raw.githubusercontent.com/ahmetatar/nimrun/main/docs/media/session-end.png" alt="session summary printed on exit" width="560">

### Options

| Flag | Meaning |
|---|---|
| `--small <id>` | model for Claude Code's cheap background calls (titles, summaries) |
| `--max-tokens <n>` | cap output tokens per response |
| `--tools-only` | only list models known to handle tool calling |
| `--all` | include non-chat endpoints (embedding, rerank, vision) in the picker |
| `--port <n>` | fixed proxy port instead of an ephemeral one |
| `--debug` | log every proxied request to stderr |
| `--bin <path>` | Claude Code executable (default `claude`) |
| `--no-banner` | skip the hero banner |

<details>
<summary><code>nimrun --help</code></summary>

<img src="https://raw.githubusercontent.com/ahmetatar/nimrun/main/docs/media/help.png" alt="nimrun --help" width="700">

</details>

### Proxy-only mode

To point an existing tool at NIM without spawning anything:

```bash
eval "$(nimrun proxy meta/llama-3.3-70b-instruct)"
```

## Choosing a model

Claude Code is an agentic tool: it is only useful with a model that reliably emits tool
calls. `nimrun` tags those `[tools]` in the picker and sorts them first, `--tools-only`
hides the rest, and picking an untagged model prints a warning. Models that stream a
`<think>` scratchpad have it stripped before it reaches Claude Code.

Tool-call reliability still varies a lot between models — one that chats well can still
fail to edit files. Try a few.

## Terminal output

The banner, picker, and cards adapt rather than break:

| Condition | Behaviour |
|---|---|
| `NO_COLOR` / not a TTY / `TERM=dumb` | all colour dropped |
| 256-colour or 16-colour terminal | gradients quantised to the nearest palette |
| terminal narrower than 55 columns | hero collapses to a one-line wordmark |
| `NIMRUN_ASCII=1` or plain Windows console | box-drawing swapped for ASCII |
| `NIMRUN_NO_BANNER` / `--no-banner` | banner suppressed entirely |

Everything decorative goes to **stderr**, so `nimrun models | grep coder` and
`nimrun --version` stay clean.

## Notes and limits

- Prompt caching, extended thinking blocks, and the web-search / computer-use server
  tools are Anthropic-side features with no NIM equivalent; they are dropped, not faked.
- `count_tokens` returns a character-based estimate — NIM has no token counting endpoint.
- Rate limits and per-model quotas are NVIDIA's; `nimrun` passes `429`s straight through.
- Your prompts and code go to NVIDIA's servers, under NVIDIA's terms — not Anthropic's.

## Development

```bash
npm test                      # proxy, error mapping, and a full spawn round trip
node tools/screenshots.mjs    # regenerate docs/media from the real CLI output
```

The screenshots are captured from the actual `ui`/`picker`/`run` code paths with a faked
TTY, then rendered to SVG — so they cannot drift away from what the CLI prints.

## Licence

MIT © [Ahmet Atar](https://github.com/ahmetatar)
