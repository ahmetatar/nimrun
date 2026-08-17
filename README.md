```
███╗   ██╗██╗███╗   ███╗██████╗ ██╗   ██╗███╗   ██╗
████╗  ██║██║████╗ ████║██╔══██╗██║   ██║████╗  ██║
██╔██╗ ██║██║██╔████╔██║██████╔╝██║   ██║██╔██╗ ██║
██║╚██╗██║██║██║╚██╔╝██║██╔══██╗██║   ██║██║╚██╗██║
██║ ╚████║██║██║ ╚═╝ ██║██║  ██║╚██████╔╝██║ ╚████║
╚═╝  ╚═══╝╚═╝╚═╝     ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═══╝
Claude Code · any NVIDIA NIM model
```

Run **Claude Code** against any model on [build.nvidia.com](https://build.nvidia.com/models).

Pick a model from NVIDIA's NIM catalog and `nimrun` launches Claude Code wired to it.
When that process exits, nothing is left behind — your Claude Code settings files are
never touched.

```
npx nimrun
```

```
  NVIDIA NIM                                    ↑↓ move   ⏎ select   esc quit
  ────────────────────────────────────────────────────────────────────────────
  ❯ coder▏

    qwen          qwen3-coder-480b-a35b-instruct  [last·tools]              ▐
  ❯ qwen          qwen2.5-coder-32b-instruct  [tools]                       ▐
    mistralai     codestral-22b-v0.1  [tools]                               │

  3/137 models   ·   tools = known tool-calling · ★ = pinned
```

Then:

```
  ╭─ ● session ────────────────────────────────╮
  │ model  qwen/qwen3-coder-480b-a35b-instruct │
  │ fast   meta/llama-3.1-8b-instruct          │
  │ proxy  127.0.0.1:57905  anthropic ⇄ openai │
  ╰────────────────────────────────────────────╯
  starting claude · settings restored on exit
```

## Why a proxy is involved

NIM only exposes an **OpenAI-compatible** API. Claude Code's `ANTHROPIC_BASE_URL` only
speaks the **Anthropic Messages API**. Setting env vars alone will not connect them.

So `nimrun` starts a translation proxy on loopback for the life of the session:

```
claude ──Anthropic /v1/messages──▶ nimrun proxy ──OpenAI /v1/chat/completions──▶ integrate.api.nvidia.com
        ◀──Anthropic SSE events───              ◀──OpenAI delta stream──────────
```

It translates system prompts, multi-part content, images, tool definitions, tool calls,
tool results, stop reasons, usage, and the full streaming event sequence. The proxy binds
to `127.0.0.1` on an ephemeral port and requires a random per-run token, so nothing else
on the machine can reach it. It dies with the process.

## Setup

Get a key from any model page on build.nvidia.com ("Get API Key"), then:

```bash
nimrun login                    # stored at ~/.nimrun/config.json, mode 0600
# or
export NVIDIA_API_KEY=nvapi-…   # env always wins; never written to disk
```

Claude Code itself must be installed: `npm i -g @anthropic-ai/claude-code`.

## Usage

```bash
nimrun                              # pick a model, launch Claude Code
nimrun --last                       # reuse your last pick
nimrun qwen/qwen3-coder-480b-a35b-instruct
nimrun --tools-only                 # only show models known to do tool calling
nimrun models                       # print the catalog (plain stdout, pipe-safe)
nimrun status                       # key, endpoint, connectivity, last model
nimrun fav moonshotai/kimi-k2-instruct   # pin to the top of the picker
nimrun -- -p "summarize this repo"  # everything after -- goes to claude
```

The picker is type-to-filter: start typing to narrow, `↑↓` to move, `enter` to select,
`esc` to quit.

### Options

| Flag | Meaning |
|---|---|
| `--small <id>` | model for Claude Code's cheap background calls (titles, summaries) |
| `--max-tokens <n>` | cap output tokens per response |
| `--tools-only` | only list models known to handle tool calling |
| `--all` | include non-chat endpoints (embedding, rerank, vision) in the picker |
| `--debug` | log every proxied request to stderr |
| `--bin <path>` | Claude Code executable (default `claude`) |
| `--port <n>` | fixed proxy port instead of an ephemeral one |
| `--no-banner` | skip the hero banner |

### Proxy-only mode

To point an existing tool at NIM without spawning anything:

```bash
eval "$(nimrun proxy meta/llama-3.3-70b-instruct)"
```

## Choosing a model

Claude Code is an agentic tool: it is only useful with a model that reliably emits
tool calls. `nimrun` tags those `[tools]` in the picker and sorts them first; `--tools-only`
hides the rest, and picking an untagged model prints a warning. Models that stream a
`<think>` scratchpad have it stripped before it reaches Claude Code.

Tool-call reliability still varies a lot between models — a model that chats well can
still fail to edit files. Try a few.

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

## Development

```bash
npm test    # runs the proxy against a fake NIM upstream — no API key needed
```

MIT.
