<div align="center">

<img src="https://raw.githubusercontent.com/ahmetatar/palimorph/main/docs/media/hero.png" alt="palimorph" width="820">

**Run [Claude Code](https://claude.com/claude-code) against any model on [build.nvidia.com](https://build.nvidia.com/models), or a local LM Studio / Ollama server.**

[![npm](https://img.shields.io/npm/v/palimorph?color=76b900&labelColor=0b0e14)](https://www.npmjs.com/package/palimorph)
[![license](https://img.shields.io/npm/l/palimorph?color=76b900&labelColor=0b0e14)](./LICENSE)
[![node](https://img.shields.io/node/v/palimorph?color=76b900&labelColor=0b0e14)](https://nodejs.org)
[![ci](https://github.com/ahmetatar/palimorph/actions/workflows/ci.yml/badge.svg)](https://github.com/ahmetatar/palimorph/actions/workflows/ci.yml)

</div>

---

`palimorph` looks at NVIDIA's NIM catalog and any local LM Studio / Ollama server at
once, lets you pick a model from whatever it finds, and launches Claude Code wired to
it. When that process exits, nothing is left behind — your Claude Code settings files
are never touched.

```bash
npx palimorph
```

## Why a proxy is involved

NIM, LM Studio, and Ollama all expose an **OpenAI-compatible** API. Claude Code's
`ANTHROPIC_BASE_URL` only speaks the **Anthropic Messages API**. Setting environment
variables alone will not connect them — the first request 404s.

So `palimorph` starts a translation proxy on loopback for the life of the session:

```
claude ──Anthropic /v1/messages──▶ palimorph proxy ──OpenAI /v1/chat/completions──▶ NIM / LM Studio / Ollama
       ◀──Anthropic SSE events───               ◀──OpenAI delta stream─────────
```

It translates system prompts, multi-part content, images, tool definitions, tool calls,
tool results, stop reasons, usage, and the full streaming event sequence. The proxy binds
to `127.0.0.1` on an ephemeral port and requires a random per-run token, so nothing else
on the machine can reach it. It dies with the process.

## Setup

Claude Code itself must be installed:

```bash
npm i -g @anthropic-ai/claude-code
```

That's it if you already have [LM Studio](https://lmstudio.ai/) or [Ollama](https://ollama.com/)
running locally — `palimorph` looks for both automatically, no key required:

```bash
npx palimorph
```

For NVIDIA NIM, `palimorph login` does **not** open a browser — NVIDIA has no OAuth flow
for NIM, so the key is pasted once:

1. Sign in at [build.nvidia.com](https://build.nvidia.com/models) (free account).
2. Open any model page and use **Get API Key**.
3. Copy the `nvapi-…` key.

```bash
palimorph login                 # stored at ~/.palimorph/config.json, mode 0600
# or
export NVIDIA_API_KEY=nvapi-…   # env always wins; never written to disk
```

You don't need to run `login` up front, either — with no key yet, NVIDIA still shows up
in the picker below, and selecting it prompts for the key right there.

### Auto-discovery

With no `--provider` flag, `palimorph` checks NVIDIA NIM (if a key is already known), LM
Studio (`127.0.0.1:1234`), and Ollama (`127.0.0.1:11434`) at once, and shows everything it
finds in a single picker — vendor column tells them apart. Nothing running locally and no
NVIDIA key yet? You still get one entry to paste a key and go.

```bash
palimorph                        # look at everything, pick, launch
palimorph --provider lmstudio    # skip discovery, go straight to LM Studio
palimorph --provider ollama      # skip discovery, go straight to Ollama
palimorph --provider custom --base-url http://host:port/v1   # any other OpenAI-compatible server
```

Whichever model you pick, the provider and base URL are remembered as your last pick — a
plain `palimorph --last` reuses it without scanning again.

## Usage

```bash
palimorph                              # pick a model, launch Claude Code
palimorph --last                       # reuse your last pick
palimorph qwen/qwen3-coder-480b-a35b-instruct
palimorph --tools-only                 # only models known to do tool calling
palimorph models                       # print the catalog (plain stdout, pipe-safe)
palimorph status                       # key, endpoint, connectivity, last model
palimorph check z-ai/glm-5.2           # ask a model to make a real tool call
palimorph fav moonshotai/kimi-k2-instruct   # pin to the top of the picker
palimorph -- -p "summarize this repo"  # everything after -- goes to claude
```

### The picker

Start typing to narrow the catalog; matches are underlined as you type.
`↑↓` to move, `⏎` to select, `esc` to quit.

<img src="https://raw.githubusercontent.com/ahmetatar/palimorph/main/docs/media/picker.png" alt="model picker filtering on 'coder'" width="820">

### The session

<img src="https://raw.githubusercontent.com/ahmetatar/palimorph/main/docs/media/session.png" alt="session card shown at launch" width="560">

Claude Code runs normally from here. On exit you get the tally, and the proxy is gone:

<img src="https://raw.githubusercontent.com/ahmetatar/palimorph/main/docs/media/session-end.png" alt="session summary printed on exit" width="560">

### Options

| Flag | Meaning |
|---|---|
| `--provider <id>` | skip auto-discovery: `nvidia`, `lmstudio`, `ollama`, or `custom` |
| `--base-url <url>` | override the endpoint (required for `--provider custom`) |
| `--small <id>` | model for Claude Code's cheap background calls (titles, summaries) |
| `--max-tokens <n>` | cap output tokens per response |
| `--context <n>` | the model's real context window (Claude Code otherwise assumes 200k) |
| `--concurrency <n>` | upstream requests in flight at once (default 1 — NIM limits these) |
| `--tools-only` | only list models known to handle tool calling |
| `--all` | include non-chat endpoints (embedding, rerank, vision) in the picker |
| `--port <n>` | fixed proxy port instead of an ephemeral one |
| `--debug` | log every proxied request to stderr |
| `--bin <path>` | Claude Code executable (default `claude`) |
| `--no-banner` | skip the hero banner |

<details>
<summary><code>palimorph --help</code></summary>

<img src="https://raw.githubusercontent.com/ahmetatar/palimorph/main/docs/media/help.png" alt="palimorph --help" width="700">

</details>

### Proxy-only mode

To point an existing tool at NIM without spawning anything:

```bash
eval "$(palimorph proxy meta/llama-3.3-70b-instruct)"
```

## Choosing a model

Claude Code is an agentic tool: it is useless with a model that will not emit tool
calls. Family names do not prove support and NIM's catalog reports no capabilities, so
`palimorph` **asks the model directly** — one tiny tool call, the first time you use it:

```
$ palimorph check nvidia/nemotron-3-super-120b-a12b
✔ nvidia/nemotron-3-super-120b-a12b makes tool calls — usable with Claude Code

$ palimorph check moonshotai/kimi-k2.6
▲ moonshotai/kimi-k2.6 did not make a tool call: listed in the catalog but not
  enabled for this account
```

Verdicts are cached in `~/.palimorph/config.json`, so the picker shows what is real:

| Badge | Meaning |
|---|---|
| **`tools`** | probed and confirmed to make tool calls |
| `tools?` | family suggests it should — not probed yet |
| `no tools` | reachable, but answered in prose instead of calling the tool |
| `unavailable` | listed in the catalog, but your account cannot invoke it |

`--tools-only` filters on the cached verdicts, falling back to the family guess for
models you have not probed. Models that stream a `<think>` scratchpad have it stripped
before it reaches Claude Code.

Tool-call reliability still varies between models that pass the probe — one that makes
a clean call once can still lose the thread on a long agentic session. Try a few.

Eight models were measured on a real Claude Code loop (run the tests, read the failure,
fix the source, re-run): six solved it, and the cost between them varied by more than 2×.
See [docs/nim-agent-benchmark.md](docs/nim-agent-benchmark.md).

## Terminal output

The banner, picker, and cards adapt rather than break:

| Condition | Behaviour |
|---|---|
| `NO_COLOR` / not a TTY / `TERM=dumb` | all colour dropped |
| 256-colour or 16-colour terminal | gradients quantised to the nearest palette |
| terminal narrower than 55 columns | hero collapses to a one-line wordmark |
| `PALIMORPH_ASCII=1` or plain Windows console | box-drawing swapped for ASCII |
| `PALIMORPH_NO_BANNER` / `--no-banner` | banner suppressed entirely |

Everything decorative goes to **stderr**, so `palimorph models | grep coder` and
`palimorph --version` stay clean.

## Notes and limits

- Prompt caching, extended thinking blocks, and the web-search / computer-use server
  tools are Anthropic-side features with no NIM equivalent; they are dropped, not faked.
- `count_tokens` returns a character-based estimate — NIM has no token counting endpoint.
- On NIM, rate limits are **per model, per account**, and on the free tier some models
  are far tighter than others — one model can be exhausted while another answers
  instantly. `palimorph` sends at most one upstream request at a time by default
  (Claude Code otherwise fires background calls alongside the main query, which is
  enough to trip a limit — or overload a local model — on its own) and retries `429`s
  with backoff, honouring `Retry-After`. A quota that is genuinely spent still surfaces —
  raise throughput with `--concurrency` only if your account (or local machine) can
  take it, and use `--small` so background calls do not spend the main model's quota.
- NIM's catalog over-reports. `/v1/models` lists models your account cannot invoke, and
  the records are byte-identical to working ones — `{id, object, created, owned_by}`,
  nothing that marks availability. There is no way to filter them out in advance; the
  only signal is a real call, which is what `palimorph check` makes. The model list itself
  is NVIDIA's own `/v1/models` verbatim, minus embedding/rerank/guard endpoints (`--all`
  keeps those). LM Studio and Ollama only list what is actually loaded or pulled, so this
  does not apply to `--provider lmstudio`/`ollama` — but the model still may not support
  tool calling, which is what `palimorph check` verifies either way.
- A cold model can take minutes to emit its first token — a NIM model spinning up, or a
  local model loading into memory for the first time. `palimorph` opens the response
  stream as soon as the upstream accepts the request and sends keep-alive pings, so the
  client does not time out waiting for headers.
- Claude Code prints a notice that claude.ai connectors are disabled whenever an auth
  source is set. That is unavoidable — pointing it at a different provider *is* setting one.
- With the NVIDIA provider, your prompts and code go to NVIDIA's servers, under NVIDIA's
  terms — not Anthropic's. With `--provider lmstudio`/`ollama`, nothing leaves your
  machine — the model runs locally and the proxy only talks to `localhost`.

## Development

```bash
npm test                      # proxy, error mapping, and a full spawn round trip
node tools/screenshots.mjs    # regenerate docs/media from the real CLI output
```

The suite runs against a fake NIM upstream on loopback — no API key, no network.
CI runs it on Linux, macOS and Windows across Node 18.17 – 24, and separately packs
the tarball and installs it as a consumer would.

The screenshots are captured from the actual `ui`/`picker`/`run` code paths with a faked
TTY, then rendered to SVG — so they cannot drift away from what the CLI prints.

## Licence

MIT © [Ahmet Atar](https://github.com/ahmetatar)
