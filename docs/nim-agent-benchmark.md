# Which NIM models can actually drive Claude Code?

A measurement of eight NVIDIA NIM models running a real Claude Code agent loop through
[`nimrun`](../README.md), on one NVIDIA account, 2026-08-17.

The question is narrower than "which model is best". Claude Code is useless with a model
that will not emit tool calls, and a model that emits one tool call may still lose the
thread over a multi-turn loop. This measures the loop.

---

## The task

A small ESM package with one bug. `parseDuration` handles a single unit (`"90s"`) but
throws on compound ones (`"1h30m"`). The suite is 4 tests; 3 pass, 1 fails.

```js
export function parseDuration(input) {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(String(input).trim());
  if (!match) throw new Error(`invalid duration: ${input}`);
  const [, value, unit] = match;
  return Number(value) * UNITS[unit];
}
```

Each model got a fresh copy and one instruction:

> Run `npm test`. One test fails. Fix the bug in src/ so that every test passes.
> Do NOT modify anything in test/ and do NOT change package.json. Re-run npm test
> until it is green, then stop.

Claude Code 2.1.233, `--allowedTools Bash,Read,Edit,Write`, `--permission-mode acceptEdits`,
`--context 128000`, 420 s watchdog. Background calls routed to a separate small model
(`--small nvidia/nemotron-3.5-lightning-30b-a3b`) so they did not spend the main model's
per-model quota.

Completing this needs the full loop: run the tests with Bash, read the failure, read the
source, edit it, re-run, and judge the result.

## How it was graded

Grading happens in a clean room. The model's `src/` is copied next to a **pristine** test
file and a **pristine** `package.json`, and the suite runs there. A model cannot pass by
weakening a test or rewriting the npm script. Tampering is tracked separately, as a data
point rather than as the pass criterion.

> **The first attempt at this benchmark was invalid and its ranking was withdrawn.**
> The fixture's npm script was `node --test test/`, which does not run the suite on
> Node 24 — it tries to load the directory as a module and dies with `MODULE_NOT_FOUND`.
> The visible symptom was a failing `npm test`, so the error went unnoticed. Models were
> effectively graded on whether they noticed the broken script, not on whether they fixed
> the bug: the two that "passed" had rewritten the npm script, and several that "failed"
> had in fact produced a correct fix. The fixture is now verified to fail for the intended
> reason before any model sees it, and grading no longer trusts the model's manifest.

## Results

| Model | Result | Wall | Requests | Input tokens | Tests |
|---|---|--:|--:|--:|--:|
| `stepfun-ai/step-3.7-flash` | **pass** | 23 s | 6 | 132,879 | 4/4 |
| `nvidia/nemotron-3.5-lightning-30b-a3b` | **pass** | 28 s | 7 | 162,649 | 4/4 |
| `nvidia/nemotron-3-ultra-550b-a55b` | **pass** | 62 s | 6 | 137,970 | 4/4 |
| `thinkingmachines/inkling` | **pass** | 62 s | 9 | 190,086 | 4/4 |
| `nvidia/nemotron-3-super-120b-a12b` | **pass** | 78 s | 12 | 288,915 | 4/4 |
| `deepseek-ai/deepseek-v4-flash-0731` | **pass** | 132 s | 6 | 134,727 | 4/4 |
| `meta/llama-3.3-70b-instruct` | did not finish | 420 s | 13 | 122,539 | 3/4 |
| `poolside/laguna-xs-2.1` | not measurable | 3 s | 2 | 0 | — |

None of the eight tampered with the tests or the manifest.

**Six of eight solved it.** Tool-calling capability is not the differentiator among these
models — efficiency is. `step-3.7-flash` finished in 6 requests and 133k tokens;
`nemotron-3-super-120b` needed 12 requests and 289k tokens for the same fix, more than
twice the cost.

Single-call latency did not predict loop performance. `nemotron-3-ultra-550b` is the
slowest of the group on one call (5.3 s vs 0.7 s for `lightning`) yet tied for fewest
requests, because it converged in fewer turns.

### The two that did not produce a result

- **`poolside/laguna-xs-2.1`** returned `HTTP 503` on both attempts. The endpoint is
  listed in the catalog but was not serving. Nothing about the model was measured.
- **`meta/llama-3.3-70b-instruct`** ran the full 420 s across 13 requests and never
  edited the source. Its tool loop works — tested directly through the proxy, a
  tool-call plus `tool_result` round trip completes correctly — but each leg takes
  9–12 s on this account, so roughly 30 s per turn. It ran out of wall clock, not
  capability. Whether it would finish with a longer budget is untested.

## Passing is not the same as correct

All six solutions pass the suite. They are not equally good. Probing them with malformed
inputs the suite never covers (`"1h!30m"`, `"!1h"`, `"1h garbage"`, `"abc1h"`, `"1h30"`,
`"1hh"`, `"--5s"`, …) separates them:

| Model | Malformed inputs silently accepted |
|---|--:|
| `deepseek-ai/deepseek-v4-flash-0731` | 0 of 9 |
| `nvidia/nemotron-3-super-120b-a12b` | 0 of 9 |
| `thinkingmachines/inkling` | 0 of 9 |
| `nvidia/nemotron-3-ultra-550b-a55b` | 5 of 9 |
| `nvidia/nemotron-3.5-lightning-30b-a3b` | 8 of 9 |
| `stepfun-ai/step-3.7-flash` | 8 of 9 |

The fast solutions reach for `matchAll` with an unanchored pattern:

```js
// step-3.7-flash — passes every test, and parseDuration('1h garbage') === 3600000
const matches = [...trimmed.matchAll(/(\d+)(ms|s|m|h|d)/g)];
if (!matches.length) throw new Error(`invalid duration: ${input}`);
return matches.reduce((total, [, value, unit]) => total + Number(value) * UNITS[unit], 0);
```

The strict ones validate the whole string before summing:

```js
// deepseek-v4-flash — rejects anything that is not entirely unit pairs
const parts = /^(\d+ms|\d+s|\d+m|\d+h|\d+d)+$/.exec(str);
if (!parts) throw new Error(`invalid duration: ${input}`);
```

`nemotron-3-ultra` sits between: it tracks how far the regex consumed and requires it to
reach the end, which catches trailing junk but not junk in the middle — `"1h!30m"` still
returns `5400000`.

This is the original bug's mirror image. The suite pins down compound parsing and leaves
input validation untested, so a model optimising for green tests can quietly widen what
the function accepts. Worth remembering when a model's diff looks clean and the tests are
passing.

## What this does and does not establish

**Does:** all six can drive Claude Code's tool loop end to end — Bash, Read, Edit,
re-run, judge — without hand-holding. Efficiency varies by more than 2×. Tests-green does
not mean correct.

**Does not:** this is one task, one run per model, on one account. The task is small and
single-file; nothing here speaks to multi-file refactors, long context, or recovery from
a bad edit. The gaps between adjacent rows are well inside what a second run could
reverse. Treat the pass/fail split as meaningful and the ordering within the passing group
as provisional.

## Reproducing

The harness lives in the scratch directory used for this run, not in the package. It is
about 60 lines of bash: copy the fixture, run `nimrun <model> -- -p "<task>"` under a
watchdog, then grade in a clean room. The numbers above come from `nimrun`'s own
end-of-session summary, which counts requests and tokens as they pass through the proxy.

## Footnote: two `nimrun` defects this surfaced

- A cold model could stall a client into a headers timeout, because the proxy did not
  open the SSE response until the first upstream token. It now opens on upstream accept
  and sends keep-alive pings.
- A transient probe failure (`HTTP 503`, a dropped connection) was cached permanently as
  "this model is unavailable". Only verdicts that say something about the model itself
  are remembered now.
