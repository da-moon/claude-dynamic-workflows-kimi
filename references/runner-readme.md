# kimi-workflows runner

Run **Claude Code dynamic-workflow scripts** against the **headless Kimi CLI**
instead of Claude subagents.

The workflow authoring surface is preserved verbatim — `export const meta` plus a
body using `agent()`, `parallel()`, `pipeline()`, `phase()`, `log()`, `args`,
`budget`, and `workflow()`. The **only** thing that changes is what backs
`agent()`: rather than spawning a Claude subagent, each call runs as one
`kimi -p <prompt> --output-format stream-json` subprocess, and returns the
agent's final message (or, with a `schema`, the parsed structured object).

So you "create the workflow as normal" — author it (or let Claude Code's Workflow
tool author + persist it), then execute that same script file here.

## How it works

```
workflow script (.js, unchanged)
        │  loaded by
        ▼
  src/runWorkflow.js ──► hosts the body in an isolated node:vm context
        │                (injected globals only; no fs/process/fetch/timers)
        ▼
  src/runtime.js ──────► parallel / pipeline / phase / log / budget / workflow
        │                (provider-neutral; concurrency cap = min(16, cores-2))
        ▼
  agent(prompt, opts) ─► src/kimiAgent.js   ◄── THE SEAM (one-shot: 1 subprocess, 1 turn)
  agent.start(...)    ─► src/kimiSession.js ◄── sessionful: 1 persisted kimi session, MANY turns
        │
        ▼
  spawn `kimi -p <full prompt> --output-format stream-json [--model <configured id>]`
  parse the NDJSON stream: last assistant line = the result;
  trailing session.resume_hint meta line = the persisted session id
```

| Workflow concept              | Kimi CLI mapping                                            |
| ----------------------------- | ----------------------------------------------------------- |
| `agent(prompt)` → final text  | one `kimi -p` run; the **last** stream-json assistant line with string `content` (tool-call/tool lines ignored) |
| `agent(prompt, {schema})`     | schema strict-normalized + **embedded in the prompt**; reply parsed (`JSON.parse`, then fence/prose extraction) → object, or `null` if non-compliant |
| `agent.start(prompt)`         | first `kimi -p` run; its `session.resume_hint` id is captured, returns before completion |
| `session.steer(msg)`          | `kimi -S <session id> -p <msg>` — a follow-up turn on the **same persisted session** (only the new prompt is sent) |
| `session.cancel()`            | per-turn `AbortSignal` → **SIGTERM** the live `kimi` subprocess → turn resolves `interrupted`, snapshot `cancelled` |
| `agentType: 'x'`              | loads `.claude/agents/x.md` → its body becomes the system prompt (prepended to the prompt) |
| `model` (Claude id or alias)  | remapped onto the **configured** model set (`kimi provider list --json`) |
| `systemPrompt` / `effort`     | prepended to the prompt (effort as a `(thinking effort: X)` hint — a steer, not an API parameter) |
| sandbox / permissions         | **none** — headless `kimi -p` is full-auto (every tool action auto-approved); `sandbox` is an advisory label only (see below) |
| transient errors              | retry with exponential backoff (default 3); permanent config errors fail fast |
| `budget.spent()`              | summed per-turn **estimates** (~4 chars/token over prompt + final text; the CLI reports no usage) |
| `parallel` / `pipeline`       | unchanged — pure JS scheduling                              |

### The wire contract (`kimi -p`, verified on kimi 0.23.3)

Every agent turn spawns exactly:

```
kimi [-S <session_id>] -p <full prompt> --output-format stream-json [--model <configured id>]
```

- **`-y` / `--yolo` / `--auto` are never passed.** kimi 0.23.3 hard-errors on
  `-p` + `--yolo` (`Cannot combine --prompt with --yolo`) — and they'd be
  redundant anyway: a headless `-p` run already **auto-approves every tool
  action**. Unrestricted full-auto is the runner's default (and only) execution
  mode; see *Sandbox honesty* below.
- The stdout stream is NDJSON. The turn's result is the **last** line with
  `role:"assistant"` and string `content`; assistant `tool_calls` lines, tool
  results, and meta lines are ignored.
- Every `-p` run ends with a meta line
  `{"role":"meta","type":"session.resume_hint","session_id":"session_<uuid>",…}` —
  the persisted-session id that `-S` accepts. One-shot `agent()` ignores it;
  sessions are built on it.
- The **full prompt** is assembled by the runner: system prompt (from
  `systemPrompt` or the `agentType` file), an optional `(thinking effort: X)`
  hint, the prompt itself, and — with a `schema` — the strict-normalized schema
  plus a "respond with a single JSON object" instruction.

### Sandbox honesty (read this before pointing agents at anything sensitive)

kimi 0.23.3 has **no headless sandbox or approval surface**: a `kimi -p` run
executes reads, writes, and shell commands without a permission gate. The
runner's `--sandbox` flag and the per-call `sandbox` opt are **advisory
metadata only** — they participate in the resume journal's cache identity and
are reported in the meta sidecar and summaries, but nothing enforces them.
`--sandbox read-only` does **not** prevent writes.

That unrestricted **full-auto mode is the supported default** for workflow runs
— it's what makes unattended fleets work. Contain agents *structurally*
instead: scope prompts, set `cwd`, use `isolation:'worktree'` for parallel
editors, and keep untrusted text away from agents whose output you'll act on
(see `authoring.md` → *Triage + quarantine*). Real enforcement is future work,
tracked in the repo's issues.

### Model selection

- **Usable ids are the CONFIGURED set** from `kimi provider list --json`
  (config.toml) — on a stock kimi-code install: `kimi-code/kimi-for-coding` and
  `kimi-code/kimi-for-coding-highspeed`. The models.dev discovery catalog
  (`kimi provider catalog list`) is **not** usable: its ids fail with
  `config.invalid` unless configured.
- **Aliases** — Claude ids / `opus` / `sonnet` → `kimi-for-coding`; `haiku` →
  `kimi-for-coding-highspeed`; `kimi` / `frontier` → `kimi-for-coding`. A bare
  name (`kimi-for-coding`) matches its provider-prefixed configured id.
  `undefined` / `inherit` / `default` → no `--model` flag (kimi's own config
  default). An unconfigured id falls back to the config default with a warning.
- **`--frontier`** pins every agent to the strongest configured model
  (`pickFrontier` over the configured list; here `kimi-code/kimi-for-coding`),
  overriding any per-call `model`. **`--pin-model M`** does the same for an
  explicit M, validated against the configured set — an unusable pin exits 1
  up front (listing the configured ids) instead of letting every agent die
  with `config.invalid`.

### Sessionful workers (`agent.start` / `agent.waitAny` / `session.*`)

`agent()` is one subprocess + one turn. `agent.start()` begins the first turn but
**returns before it finishes**, so a workflow can spawn long-lived workers,
`agent.waitAny([…])` for the first to become actionable, and `steer()` a worker
with follow-up turns. Sessions ride kimi's **real persisted sessions**: the
driver captures the `session.resume_hint` id from the first turn, and every
follow-up runs `kimi -S <id> -p <new prompt>` — the system prompt is sent once,
transcripts are never re-sent, and the context (tool calls included) lives in
kimi's session store, so per-turn input does not grow. See
[`authoring.md` → *Sessionful workers*](authoring.md#sessionful-workers-long-lived-steerable)
for the full API, the controller pattern, and the human interaction model
(`hands_off` / `checkpointed` / `interactive`). Key runner facts:

- **Concurrency:** a turn holds one semaphore slot from start to settle, so a
  *detached running worker still counts against* `min(16, cores-2)`. `agent.start`
  blocks if the cap is saturated (like `agent()`), then returns once a slot frees.
- **Budget:** every start/steer gates on `--budget` (same `BUDGET_EXCEEDED`);
  each turn's estimated tokens feed the shared meter.
- **Cancel is a real interrupt:** `session.cancel()` (and `close()`, and
  finalization) aborts the turn's `AbortSignal`, which SIGTERMs the live `kimi`
  subprocess. The turn resolves `interrupted` (error `null`, excluded from the
  session context, never retried) and the workflow-visible snapshot is
  `cancelled` — hedged / take-first-win patterns actually stop paying wall-clock
  and tokens for the losers.
- **Resume:** sessions resume **warm**. Each turn is journaled under
  `sess:<workerId>#<turn>` with its verbatim prompt, prompt hash, and the real
  kimi session id (`threadId`). On `--resume` the completed-turn prefix replays
  free (`cached` events, zero kimi spawns) and the worker re-attaches to its
  persisted session via `-S`, so new steers run on the full prior context.
  Replay is positional **and prompt-checked** (a changed steer prompt re-runs
  live from that turn onward). If kimi no longer has the session
  (`Session "…" not found`), the next live turn falls back once to a fresh
  session whose context is rebuilt from the journaled prompts/results, and the
  fresh id re-arms `-S`. Journals that predate prompt recording (synthetic
  `kimi-session-*` ids) invalidate cleanly — everything re-runs live, and a
  synthetic id is never passed to `-S`.
- **Finalization:** `runWorkflowSource` closes any sessions left open in a
  `finally` (cancels active turns, removes worktrees). `isolation:'worktree'`
  persists across steers, cleaned only on `close()`/finalization.
- **Events:** session turns emit the same `start`/`end` lifecycle events as
  `agent()` (with extra `kind:"session"`, `sessionId`, `turn`, `status` fields),
  so `map-run` / `view-run` / `summarize-run` keep working.
- **Seam:** the runtime takes a `startSession` option (default
  `kimiSession.startKimiSession`) and the driver takes a `runAgent` option, so
  offline tests drive sessions with fakes — no kimi binary, no tokens.

## Requirements

- Node ≥ 18.17 (CI runs the maintained LTS lines, 20 and 24)
- `kimi` CLI on `PATH`, logged in, with at least one model configured
  (`kimi provider list --json` must return a non-empty `models` object)

## Usage

```bash
# preflight: version, configured models, frontier pick, one tiny live turn
npm run doctor            # from the repo root  (runner/: npm run handshake)
npm run doctor -- --offline   # same checks without the live turn (no tokens)

# run the example 2-agent workflow
cd runner && npm run example
# or:
node bin/run-workflow.js ../examples/hello.workflow.js --frontier

# offline test suite (no kimi, no network — fakes at the seam)
npm test
```

CLI options:

```
run-workflow <script.js>
  --args JSON         value exposed to the script as `args`
  --args-file PATH    same, read from a file
  --budget N          token ceiling backing budget.total / budget.remaining()
  --budget-meter M    what budget.spent() counts: total (input+output, default) | output
  --plan              dry run: count agents per phase/effort + estimate a budget
                      (no model, no tokens; alias --dry-run)
  --tui               open a live ASCII map of the run in a new terminal window
  --gui               open a live HTML viewer in your browser (--monitor = both)
  --interactive       enable the human() answer channel without a monitor
  --model M           fallback model (Claude ids/aliases auto-mapped); omit for config default
  --frontier          pin ALL agents to the strongest CONFIGURED model
  --pin-model M       pin ALL agents to model M (validated; fails fast if unusable)
  --effort E          none|minimal|low|medium|high|xhigh (flat fallback, prompt hint)
  --auto-effort       scale effort to each layer's parallel width: 1->xhigh, 2+->high (floor)
  --pin-effort E      force ALL agents to effort E (overrides per-call effort)
  --sandbox S         read-only | workspace-write | danger-full-access
                      (ADVISORY label only — journaled + reported, never enforced)
  --retries N         transient-error retries per agent (default 3)
  --resume            reuse prior results from the journal (skip unchanged agents)
  --journal PATH      journal location (default .workflow-journal/<script>.jsonl)
  --run-id NAME       suffix journal/sidecar names (concurrent runs of one script)
  --notify-cmd CMD    push notifications for pending gates / run end (implies --interactive)
  --fresh             discard the journal before running
  --no-journal        disable journaling entirely
  --summary           print the full cost/performance/reliability report at the end
  --no-summary        silence the short end-of-run recap (printed by default)
```

The argv surface is **strict**: exactly one positional (the script) plus the
flags above. Any unknown `-`/`--` token exits 1 naming the token (a typo'd flag
can't silently become the script path), and a second positional exits 1 as an
unexpected argument. `--multi` is skill-mode vocabulary, **not** a run-workflow
flag.

### Retries & error classification

Transient failures — connection resets, stream disconnects, timeouts, a killed
subprocess — are retried with exponential backoff (default 3 attempts, 30s cap,
jittered). Permanent, deterministic failures fail **immediately** with no
retry: `config.invalid` / "is not configured" (unusable model), unknown
options, impossible flag combinations (`Cannot combine`), and a `-S` resume of
a session kimi no longer has (`Session "…" not found` — the session driver
handles that one with its single fresh-session fallback instead). A cancelled
turn is never retried. Unknown errors are conservatively NOT retried.

### Token accounting (estimates)

The Kimi CLI reports no per-turn token usage, so the runner **estimates**:
~4 characters per token over each turn's full prompt + final text. Those
estimates feed per-agent attribution (journal, viewers, summaries) and the
run-wide meter behind `budget.spent()` / `--budget`. They exclude the agent's
own tool traffic (file reads, intermediate model turns inside kimi), so real
provider-side usage is higher — treat `--budget` as a coarse backstop and size
runs with `--plan`, not as exact billing.

### Layer-width effort (`--auto-effort`)

`parallel()` and `pipeline()` publish how many agents run side-by-side in the
current layer via an `AsyncLocalStorage` store (`runtime.js`); `agent()` reads it
(default `1` for a lone, un-fanned-out call) and, when `--auto-effort` is on,
maps width → effort with `effortForLayerWidth`:

| layer width | effort  |
| ----------- | ------- |
| 1           | `xhigh` |
| 2+          | `high`  |

The rationale: a lone agent is a critical gate (consolidation / judge / report)
where one weak output sinks the run, so it gets the policy's extra-high tier;
every fan-out floors at `high` (the policy never drops to `medium`). The context
propagates across awaits and through the vm-hosted thunks, so a queued or
deeply-awaited agent still sees the width of the layer that spawned it. Effort
precedence (highest first): `--pin-effort` → per-call `opts.effort` →
`--auto-effort` → `--effort` → unset (no effort hint sent; kimi's own defaults
apply). Effort reaches the model as a `(thinking effort: X)` prompt hint, and
the *effective* effort is folded into each agent's journal identity, so toggling
the policy between runs busts only the agents whose effort changed.

### Resume journal

Every run records each completed `agent()` result to a journal, keyed by a hash
of its identity (prompt + output-affecting opts) plus occurrence index. Re-run
with `--resume` and unchanged agents return instantly from cache (0 tokens);
edited prompts/opts miss and re-run. This is the runner's analogue of native
`resumeFromRunId` — and it makes a mid-run failure (or a tripped `--budget`)
cheap to recover from: bump the limit, `--resume`, and only the unfinished work runs.
On a `--budget` trip the CLI prints a paste-ready `--resume --budget <2×>` command.

### Per-agent metrics & the viewers

Alongside each result, the journal records non-identity attribution: the agent's
**phase** (`opts.phase`, else the ambient `phase()`), **effort**, resolved
**model**, **tokens** (estimated; total and output-only), and **wall time** —
captured in `kimiAgent.js` and folded in by `runtime.js`.

Both viewers read the same model. `src/runModel.js` (`locateRun` + `buildRunModel`)
turns a journal (+ optional script) into the structured run model — phases, agents
with phase/model/effort/tokens/ms, and totals — preferring the journal's per-agent
fields and falling back to script regex for older journals. On top of it:

- **`bin/view-run.js`** — the HTML viewer. Renders token totals and time per agent,
  per phase, and per run (the data the native `/workflows` view shows). `<dir>
  --watch` rebuilds the HTML as the journal grows so an open tab tracks a live run
  (auto-refreshes every 2s).
- **`bin/map-run.js`** — an **ASCII execution-graph (DAG)** in the terminal: an
  orchestrator node-box (with a monochrome `✓✓⠋··` progress strip) → a flow arrow
  into each phase layer → branch edges (`├─` / `╰─`) to a **fixed-column agent
  grid** (`AGENT MODEL EFFORT TOKENS WALL` header; running rows share the columns —
  spinner status, `--` tokens, elapsed in `WALL` — so done/running scan as one
  table) → a **1–2 sentence result snippet** (via `agentSnippet`) under each node →
  **semantic barriers** (`┄ barrier · Gather → Synthesize ┄`) → a result node-box.
  All widths derive from one `frameW`; text is display-width-safe (wide/combining
  chars), so it stays aligned in `--no-color`. `+N more` collapses big fan-outs;
  `<dir> --watch` redraws in place on an alternate screen (snippets auto-drop if the
  frame would overflow the terminal height). The polish came from a multi-persona
  workflow run — see `polish-ascii-map.workflow.js`.

### Live observability (the event stream)

Completed agents come from the journal, but a live run also wants to show what's
**running**. So when journaling is on, the runner writes a sidecar event stream
next to the journal — `<name>.events.jsonl` — appending `{t, type, label, phase,
model, effort, tokens, ms}` on each agent `start` / `end` / `cached` (emitted by
`runtime.js` via an `onEvent` sink; truncated fresh per run; best-effort, never
blocks the run; disabled by `--no-journal`). It's purely observational — separate
from the resume journal, so it never affects identity/hashing.

`runModel.js` (`readEvents` + `liveState`) turns it into live state: agents with a
`start` not yet matched by an `end` are **running**, plus run wall-clock
(`runStartedAt`..`lastEventAt`) and done/running counts. `map-run.js --watch` merges
those running agents into the map — they show under their phase the instant they
start, with a spinner and live elapsed (`⠴ global-ranking  3.6s running…`), and an
animated footer (`⠴ 42s · 2 done · 1 running`). The HTML viewer consumes the same
stream via `buildLiveRunModel`.

### Budget metering (`--budget-meter`)

`budget.spent()`/`remaining()` count **total** estimated tokens (input+output) by
default — a conservative cost bound, and what the `--plan` estimate and the
budget-sizing rule of thumb assume. Pass `--budget-meter output` to count only
the output side, matching the native runtime's output-token pool, for scripts
whose `budget`-driven loops were written against that semantics. (Both meters
run on the same estimates — see *Token accounting* above.)

### Run summary report (`bin/summarize-run.js`)

A run leaves a journal (and, when journaling is on, an event sidecar); `summarize-run`
distills them into a **cost / performance / reliability** report. `src/runSummary.js`
(`summarizeRun` + `renderSummaryText` / `renderSummaryMarkdown`) builds it on top of
`buildRunModel`, so it inherits the same old-journal tolerance (phase/model/effort
recovered from the script when the journal predates the metric fields) and **never
writes the journal**.

```bash
node bin/summarize-run.js --journal .workflow-journal/<name>.jsonl   # or: <run-dir>
node bin/summarize-run.js <run-dir> --json        # structured (the summary object)
node bin/summarize-run.js <run-dir> --markdown    # paste-ready report
node bin/summarize-run.js <run-dir> --out r.txt   # write to a file
node bin/summarize-run.js <run-dir> --include-result   # also preview the return value
```

It reports total / completed / null / cached / interrupted agents, agents·tokens·
agent-time **by phase**, the **top 10 costliest** (tokens) and **slowest** (time)
agents, a **model & effort** breakdown, and **cache hit rate** on a resumed run.
Token totals separate the journal's **all-in** sum (across resumes) from the
**latest run's executed** tokens (agents that finished this run, matched by stable
id); **budget usage** (from the meta sidecar) bills the latest run when the event
sidecar is present, else the all-in total — and labels which. It also raises
warnings: missing metrics, many null results, interrupted agents, unphased /
unlabeled agents, a single phase with a huge fan-out, and agents left on inherited
or model-default effort.

When a run directory holds several journals, `summarize-run` — like `view-run` and
`map-run` — defaults to the **most recently modified**; **`--list`** shows them all
and **`--journal PATH`** selects a specific one.

What each source contributes (all optional except the journal):

- **journal** — completed agents (deduped by key), phase/model/effort/tokens/ms.
- **`<name>.events.jsonl`** — the most recent run's lifecycle, giving true
  **wall-clock per phase** (vs. the journal's sum-of-durations), **cached** replays,
  and **interrupted** agents (a `start` with no matching `end`).
- **`<name>.result.json`** — the workflow's return value, for `--include-result`.
- **`<name>.meta.json`** — run-level facts the journal can't carry (budget + meter,
  pinned model, effort policy, the advisory sandbox label — plus `pid` /
  `startedAt` / `script` / `runId`, which `fleet status` uses to tell a live run
  from a finished or killed one), written once by `run-workflow` at startup
  (best-effort; runtime-only, git-ignored). Absent → the budget line is simply
  omitted.

`run-workflow` prints a short recap automatically when a run finishes (one line for
tiny runs, a small phase table otherwise); `--summary` prints the full report inline,
`--no-summary` silences it.

### Across-runs analytics (`bin/compare-runs.js`)

`summarize-run` is one journal deep; `compare-runs [dir|journal …] [--json]`
reads **many** (same discovery as `fleet status`: a dir contributes every
journal under its `.workflow-journal/`). One line per run, newest first —
agents (+ worker count), completion rate (cancelled-by-design race losers are
**not** failures), cached replays, the run's own **executed** tokens (resume
replays excluded when the event sidecar can tell), wall clock, and
budget/null/warning flags — then **run-over-run rollups** for workflows that
ran more than once: average cost, completion rate, and the latest-vs-previous
token trend. `--run-id` variants of one script roll up under the same name.
`src/compareRuns.js` is the pure logic; `test/compare-runs.test.js` covers it.

### Dry-run planning (`--plan`)

`--plan` executes the orchestration with `agent()` stubbed — it returns a JSON
Schema *skeleton* (objects filled, arrays empty) instead of calling a model — and
records each would-be agent's phase/effort/width to print a per-phase count and an
estimated `--budget`. Because skeleton arrays are empty, a fan-out sized from a
prior agent's output is **uncounted** (a lower bound); the CLI says so. Static
fan-outs (over `args`, fixed lists) count exactly. Session starts and steers are
counted too, so sessionful workflows plan honestly.

### Live monitoring (`--tui` / `--gui`)

`run-workflow` can auto-open a live monitor that watches **this run's** journal +
event sidecar as it progresses — so you see every agent (running + done) update in
real time without a second command. It's spawned *before* the workflow starts (the
journal is pre-created) and runs alongside it:

- **`--tui`** opens the ASCII map (`map-run.js --watch`) in a **new terminal
  window** — it needs its own TTY for the alternate-screen redraw, so on macOS the
  runner uses `osascript` to open Terminal (elsewhere it prints the command). The
  window persists after the run; Ctrl-C there to close it.
- **`--gui`** spawns `view-run.js --watch --serve --open`, which opens the **HTML
  viewer** in your browser, serves it on localhost (so the workflow's `human()`
  questions are answerable in the page), and rebuilds it as the journal/events
  grow. On completion the runner stops the watcher and writes a final static
  render so the page settles in place.
- **`--monitor`** does both. All need journaling (skipped under `--no-journal`).

Both viewers consume the same live model: `runModel.js`'s **`buildLiveRunModel`**
(= `buildRunModel` + `liveState`) merges started-but-unfinished agents as
`status:'running'`, so the HTML viewer shows in-flight agents (amber, pulsing,
with elapsed) exactly as the ASCII map does. The workflow itself runs unchanged —
its result JSON still prints to stdout — so `--tui`/`--gui` compose with everything
else (`--frontier --auto-effort`, `--resume`, …).

`agent(prompt, { isolation: 'worktree', cwd: <repo> })` runs the agent in a
detached `git worktree` at HEAD, so parallel agents that edit files don't collide.
The worktree is auto-removed if the agent left it clean, and **kept** (path logged)
if it made changes. Requires `cwd` to be inside a git repo (otherwise isolation is
skipped with a notice).

Progress goes to **stderr**; the workflow's return value is printed as JSON to
**stdout** (so `run-workflow wf.js | jq .` works).

### Fleet supervision (`bin/fleet.js`, `--run-id`)

Several runs can execute **concurrently** and be supervised from outside — by a
human in a second terminal, or (the intended operator) a supervising agent in a
loop. The pieces:

- **Isolation** — journals derive from the script name, so N concurrent runs of
  the *same* script need **`--run-id NAME`** (journal + every sidecar become
  `<base>--NAME.*`). Distinct variant scripts in one shared directory isolate
  naturally — and that shared directory *is* the fleet.
- **Discovery** — the journal file is touched **eagerly** at startup, so a
  just-launched run is visible to `fleet status` (and the viewers) before its
  first agent completes.
- **`fleet status [dir|journal ...] [--json] [--stall-after S]`** — one digest
  across every run found: a derived state machine (**completed** = a result
  sidecar fresher than this run's `startedAt` · **running** = the recorded pid is
  alive · **stopped** = started but pid gone with no fresh result, i.e.
  killed/crashed/budget-tripped → resumable · **idle** = journal only), phase +
  agent progress, tokens vs budget, **stall** detection (a live pid with no
  events past the threshold — unless it's waiting on a question, which is
  *waiting*, not stalled), and every **pending `human()` question** with a
  paste-ready answer command. `src/fleetStatus.js` is the pure logic (clock and
  pid-liveness injectable; see `test/fleet.test.js`). For a human watching:
  **`--watch`** redraws the digest in place every 2s until all runs are
  terminal, and **`--html PATH [--open]`** writes a self-contained card-per-run
  dashboard (auto-refreshes while any run is live; links each run's generated
  viewer page when present; `--watch --html` rewrites it each cycle).
- **`fleet answer --journal J --id ID --answer TEXT [--answer-json]`** — the
  write side of the supervisor channel: validates the id against the run's
  *currently-pending* questions (same rule as the `--serve` cockpit's endpoint —
  no pre-answering, no re-answering; a bare `qid` resolves if unambiguous) and
  appends to `<name>.answers.jsonl`, which the running workflow polls (~500ms).
  `--list` shows a run's asked/pending questions. Free-text answers are how a
  supervisor **steers**: author workflows with checkpoint gates whose answers
  the script applies (e.g. `session.steer(directive)`).
- **`--notify-cmd CMD`** (on `run-workflow`) — the push side: CMD runs detached
  (best-effort, `/bin/sh -c`, the event JSON in `$WORKFLOW_EVENT`) when a
  `human()` question goes pending — gates time out to their defaults, so an
  away supervisor needs the push — and when the run ends
  (`completed` / `budget_exceeded` / `failed`). Implies `--interactive`.
- **Fork** — copy a journal to a new name, point an edited variant at it with
  `--journal <copy> --resume`: the unchanged prefix replays at 0 tokens and
  sessionful workers re-attach to their persisted kimi sessions warm; only the
  new direction spends. Kill + `--resume` (same journal) is the degenerate case.

`examples/fleet/` is a runnable two-variant fleet with the full supervision
transcript; the `/kimi-workflows --multi` skill mode automates the whole loop.

The whole supervision layer is a **file contract**, not a runner coupling —
any long-running job that writes the sidecars is supervisable by the same
tools. The contract (file formats, state machine, answer/steer rules, the
minimum viable producer) is specified in
[`fleet-protocol.md`](fleet-protocol.md), and **`bin/supervise.js`** is its
reference second producer: `supervise --name nightly -- python evals.py`
wraps *any* command in the sidecars — output streams as live progress, and an
`@@ASK {json}` line on the job's stdout becomes a gate whose answer arrives on
the job's stdin (a bash `echo @@ASK…; read answer` is a complete client).

### Cross-project robustness

A persisted script written for Claude Code rarely needs editing to run here:

- **Model translation** — a script (or `agentType`) that asks for
  `claude-opus-4-8`, or a bare `opus`/`sonnet`/`haiku` alias, maps onto the
  models configured in kimi (`opus`/`sonnet` → `kimi-for-coding`, `haiku` →
  `kimi-for-coding-highspeed`, matched against `kimi provider list --json`).
  Unknown/`inherit` → kimi config default. `--frontier` bypasses this routing
  and pins the whole run to the strongest configured model.
- **`agentType`** — `agent(p, { agentType: 'reviewer' })` loads
  `.claude/agents/reviewer.md` (project scope first, then `~/.claude`) and uses its
  body as the system prompt and its frontmatter `model` as a fallback.
- **Resilience** — transient errors (rate limits, dropped connections, killed
  subprocesses, timeouts) are retried with exponential backoff; each turn is its
  own subprocess, so there is no long-lived server to lose. Permanent errors
  (misconfigured model, bad flags, a vanished session) fail fast.
- **Isolation** — the script runs in a `node:vm` context whose global holds only
  the injected workflow API + JS intrinsics. No `process`/`fetch`/`require`/
  `import()`/`fs`/timers are reachable from the script itself (agents do the I/O),
  matching the native "no direct filesystem or shell access" guarantee.
  `Math.random()`/`Date.now()`/argless `new Date()` are blocked (resume safety).

### `agent(prompt, opts)` options

`schema`, `model`, `agentType`, `effort`, `sandbox` (advisory), `cwd`,
`systemPrompt`, `personality`, `isolation`, `retries`, `timeoutMs`, `label`,
`phase`. Per-call `opts` override the CLI `--model/--effort/--sandbox/--retries`
defaults — except that `--frontier`/`--pin-model` force the model and
`--pin-effort` forces the effort regardless of `opts`. A per-call `effort`
overrides `--auto-effort` (so omit it unless you deliberately want to escape the
layer-width policy for one agent).

## Implemented vs. extension points

**Implemented & tested:** the `kimi -p --output-format stream-json` spawn
boundary (argv contract + NDJSON parser pinned by `test/kimi-agent.spawn.test.js`
against a byte-for-byte 0.23.3 wire fixture), prompt-embedded structured output
(strictified schema + lenient parse), `agent`, `parallel`, `pipeline`, `phase`,
`log`, `budget` (estimate-based metering + enforcement), **per-call `opts.phase`
grouping**, **per-agent metrics** (phase/effort/model/tokens/time persisted to
the journal, rendered by the viewer), **model translation + configured-model
preflight** (`kimi provider list --json`), **`agentType`** resolution,
**retry-with-backoff** with permanent-error fast-fail, an **isolated `node:vm`
script sandbox** (no fs/shell/process/fetch/import; non-deterministic builtins
blocked), **`isolation:'worktree'`**, the **resume journal** (`--resume`), the
**named-workflow registry** (`workflow("name")` → `.claude/workflows/` then
`~/.claude/workflows/`), **`--plan` dry-run estimation**, **`--budget-meter
total|output`**, **`--watch` live viewers**, the **`summarize-run`
cost/performance/reliability report** (text/json/markdown, with an automatic
end-of-run recap), **`compare-runs` across-runs analytics**, one-level
`workflow({scriptPath} | "name")` nesting, **sessionful workers** (`agent.start`
/ `agent.waitAny` / `session.steer`/`wait`/`poll`/`cancel`/`close` — long-lived,
multi-turn, steerable workers on persisted kimi sessions (`-S`), with per-turn
budget/concurrency, lifecycle events, runtime finalization, worktree persistence
across turns, warm-context resume, and a real subprocess-killing cancel), the
**fleet supervision layer** (status/answer/supervise + the sidecar protocol),
and the CLI. The full runtime→driver→spawn session stack is locked down by
`test/kimi-session.integration.test.js` against a fake `kimi` binary speaking
the verified wire contract.

**Extension points (not yet wired):**

- **Sandbox enforcement** — `--sandbox`/`sandbox` are advisory labels; kimi 0.23.3
  offers no headless permission surface to bind them to. A real approximation
  (read-only worktrees, tmp cwds, refusing values that can't be honored) is
  future work.
- **Real token usage** — all token numbers are ~4-chars/token estimates over
  prompt + final text; if a future kimi exposes per-turn usage in stream-json,
  the meter can switch to it without touching the workflow surface.
- **One-shot thread forking** — `agent()` resume replays *results* (single
  stateless turns have no state worth forking). Sessions DO resume warm (`-S`,
  see above); *forking* one warm worker into several would need kimi-side
  session duplication, which the CLI doesn't expose.
- **Direct worker steering from the viewer** — `human()` (built) covers
  *declared* forks: the workflow asks, the served live viewer (`view-run
  --serve`, auto with `--gui`) renders an answer card that POSTs to `/answer`,
  and the runner polls the `<journal>.answers.jsonl` sidecar. What remains
  unbuilt is UNdeclared steering — injecting a turn into a running worker the
  script didn't offer up — which would race the script's one-active-turn
  ownership; if ever added it needs a hand-off protocol, not just an endpoint.

## Pinning to a Kimi version

Flag names and stream shapes here were verified against the installed `kimi`
0.23.3 (`src/kimiVersion.js` → `VERIFIED_KIMI_VERSION`): `-p` with
`--output-format stream-json`, `--model` with configured ids, `-S` resume, the
`session.resume_hint` meta line, and `kimi provider list --json` as the source
of usable model ids. The preflight (`npm run doctor`, `--offline` to skip the
live turn) prints the detected version and **warns on drift** (a mismatch is a
warning, not a hard failure — CLI flags are usually stable). To re-verify
against another version, run the doctor and, if the spawn shape changed, update
`kimiAgent.js`/`kimiSession.js` and the wire fixture in
`test/fixtures/kimi-stream.ndjson`, then bump `VERIFIED_KIMI_VERSION`.
