# Benchmarks

Measured evidence for the sessionful-worker claims — run them yourself; the
journal is the instrument (`summarize-run` reads it).

## warm-vs-cold — "load once, ask many"

Two arms answer the **same questions** about the **same corpus**:

- **Warm** — one sessionful worker ingests the corpus once (`agent.start`), then
  answers every question as a `steer` on its warm thread.
- **Cold** — a fresh one-shot `agent()` per question, each re-reading the corpus
  from scratch (the only option in the native one-shot DSL).

```bash
node runner/bin/run-workflow.js examples/benchmarks/warm-vs-cold.workflow.js \
  --pin-model kimi-code/kimi-for-coding --sandbox read-only
node runner/bin/summarize-run.js .          # By-phase + Sessionful workers tables
```

> **Note — this measurement predates the k3 tier and the `low`/`high`/`max`
> reasoning-effort ladder.** When it was taken, `--frontier` selected
> `kimi-code/kimi-for-coding` (the strongest model then configured) and the run used a
> flat `medium` effort — a tier since removed. On a current kimi-code install
> `--frontier` selects **`kimi-code/k3`**, whose reasoning effort is `low`/`high`/`max`
> (default `max`; the managed kimi-code endpoint pins it to `max`). `kimi-for-coding` is
> always-thinking and takes no reasoning-effort level, so the original `--effort` was
> only a prompt hint. To reproduce the recorded run, pin the model as shown above
> (`--pin-model kimi-code/kimi-for-coding`); to benchmark the current frontier instead,
> use `--frontier` (k3, at its default `max`).

### Measured result (2026-07-15 · kimi-code 0.23.3 · kimi-code/kimi-for-coding · legacy `medium` effort · corpus `runner/src`, ~4.1k lines · 3 questions)

> Measured on the real Kimi backend, post-port (the runner rides `kimi -S`
> persisted sessions; the seam file is `kimiAgent.js`). The original run used
> `--frontier` with a flat `medium` effort (a tier since removed), which on
> kimi-code 0.23.3 selected `kimi-code/kimi-for-coding` (this predates the k3 tier);
> to reproduce it now, pin that model: `--pin-model kimi-code/kimi-for-coding
> --sandbox read-only --budget 4000000 --run-id bench1` (`kimi-for-coding` is
> always-thinking, so no `--effort` level applies). Completed in 1m32s
> wall-clock, 7/7 agents completed, 0 retries.

| | tokens (est.) | agent time |
| :--- | ---: | ---: |
| **Warm** — ingest (one-time, turn 0) | 203 | 32.9s |
| **Warm** — each question (steer, marginal, avg of 3) | **~197** | **~11.3s** |
| **Cold** — each question (full re-read, avg of 3) | **~315** | **~20.7s** |
| **Warm** — arm total (1 ingest + 3 steers) | 794 | 1m07s |
| **Cold** — arm total (3 agents, run in parallel) | 944 | 1m02s agent-time (25s wall, parallel) |

Per question the warm worker was **~1.6× cheaper in (estimated) tokens and
~1.8× faster per turn** than a cold re-read, and the warm arm's cumulative
total was already below the cold arm's by the second question (621 vs 637)
and stayed ahead through the third (794 vs 944). Both arms produced correct,
file-citing answers (spot-checked: both located retry/backoff in
`kimiAgent.js`'s `withRetry`/`isRetryable`).

**Read this measurement's token column with real skepticism** — it is not
comparable in scale to the pre-port GPT-5.5 numbers below, and the reason is
mechanical, not a property of Kimi being cheaper:

- The headless `kimi -p` CLI reports **no real per-turn token usage**. The
  runner estimates tokens as ~4 chars/token of the **literal prompt string
  it sent plus the literal reply text** (`estimateTokens` in `meter.js`,
  called from `kimiAgent.js`'s turn-completion path in `runOneTurn`). It
  does **not** see (and cannot count) the tokens
  Kimi's own agentic tool calls spend reading files under `runner/src` —
  that corpus-reading cost happens inside the Kimi process and is invisible
  to the runner's meter.
- That is why every number above is in the hundreds, not the hundreds of
  thousands the GPT-5.5 run reported: the GPT-5.5 arm's tokens included the
  full corpus text (the one-shot DSL there re-sent the transcript each
  call); here, Kimi manages its own file reads out of band, so the estimate
  only ever sees the short instruction/question and the short answer.
- The **wall-clock gap still holds up as real evidence** (cold re-reads the
  corpus from scratch every time and is measurably slower per question:
  ~20.7s vs ~11.3s), because wall time isn't estimated — it's the actual
  process duration. Treat the token column here as a lower-bound proxy for
  "prompt+reply size," not as a dollar-cost measurement of the Kimi run.

### Historical measurement — pre-port, different backend (2026-06-09 · codex 0.137.0 · gpt-5.5 · effort medium · corpus `runner/src`, ~3.3k lines · 3 questions)

> Taken on the original Codex backend **before the Kimi port**, where the
> one-shot DSL re-sent the full transcript on every call, so tokens included
> the actual corpus text. Not directly comparable to the Kimi measurement
> above (different backend, different token-accounting model) — kept for
> context on the original claim this benchmark was written to test.

| | tokens | wall time |
| :--- | ---: | ---: |
| **Warm** — ingest (one-time, turn 0) | 329k | 80s |
| **Warm** — each question (steer, marginal) | **~69k** | **~6s** |
| **Cold** — each question (full re-read) | **~219k** | **~97s** |
| **Warm** — arm total (1 ingest + 3 steers) | 535k | 99s |
| **Cold** — arm total (3 agents) | 656k | 290s agent-time |

Per question, after the one-time ingest, the warm worker was **~3× cheaper in
tokens and ~16× faster** — it answers from context instead of re-reading. On
totals the warm arm broke even at the **second** question and was ahead by the
third (535k vs 656k). Both arms produced correct, file-citing answers
(spot-checked: both located retry/backoff in `codexAgent.js`).

Two honest notes:

- **One question → use a one-shot.** The ingest dominates at N=1 (~398k warm — the
  329k read plus one ~69k answer — vs a single cold question that re-reads and
  answers in one shot, here 179k–289k depending on the question). Sessions win when
  you'll ask *again* — which is the point.
- The steers' ~69k/turn is mostly the thread's **re-billed (largely cached)
  input**; raw token counts therefore *understate* the warm advantage in dollar
  terms, since cached input is billed far below fresh input. The wall-clock gap
  (6s vs 97s) needs no such caveat.

Numbers vary with corpus size, model, and effort — the relative shape (flat
cheap steers vs linear re-reads) is the durable result. Re-run with your own
`--args '{"scope":"…","questions":[…]}'` to measure your case.
