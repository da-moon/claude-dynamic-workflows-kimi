# Contributing

Thanks for your interest! This is a small, dependency-free project -- easy to hack on.

## Layout

- `SKILL.md` -- the Claude Code skill definition (what Claude reads when the skill loads).
- `.claude-plugin/plugin.json` -- Claude Code plugin manifest.
- `.claude-plugin/marketplace.json` -- Claude Code marketplace bundle manifest.
- `runner/` -- the standalone runner (Node, zero deps):
  - `src/` -- the seam (`kimiAgent.js` + `kimiSession.js` for sessionful workers) + provider-neutral DSL (`runtime.js`), and helpers (model mapping, agentTypes, journal, worktree, meter).
  - `bin/run-workflow.js` -- CLI to execute a workflow script.
  - `bin/view-run.js` -- the run-viewer generator (`--serve` adds the interactive cockpit endpoint).
  - `bin/fleet.js` -- fleet supervision: `status` (multi-run digest) + `answer` (the human()/checkpoint channel; `src/fleetStatus.js` is the pure logic).
  - `bin/supervise.js` -- wrap any command in the fleet-protocol sidecars (gates via `@@ASK` lines \u2194 stdin; the protocol's reference second producer).
  - `test/` -- `offline.js` (unit), `kimi-session.test.js` (session driver + chaos), `view-run.test.js` / `view-run.live.test.js` / `map-run.test.js` / `summarize-run.test.js` (viewer + summary robustness across run shapes), `serve.test.js` (cockpit channel), `fleet.test.js` (fleet status/answer + the agent-supervisor loop), `goal-lint.plan.test.js` / `claim-check.plan.test.js` (harness-zoo dry runs), `supervise.test.js` (the second fleet-protocol producer), `compare-runs.test.js` (across-runs analytics), `examples.plan.test.js` (every bundled workflow stays `--plan`-safe), `handshake.js` (live Kimi connectivity).
- `references/` -- `authoring.md` (workflow-script DSL), `runner-readme.md` (architecture / Kimi prompt mapping / faithfulness), `fleet-protocol.md` (the sidecar contract that makes runs supervisable -- implement it to add a new producer/consumer).
- `examples/` -- runnable templates and a bundled `demo/` run.
- `bin/kimi-workflows.js` -- the npx/git-install dispatcher (`run` / `fleet` / `view` / `map` / `summarize` / `doctor`).
- `scripts/sync-skill.js` -- one-command sync of the skill surface to `~/.claude/skills/kimi-workflows` (`npm run sync-skill`).

## Develop

No build step. Requires Node \u2265 18.

```bash
npm test            # offline unit checks + viewer robustness (no Kimi, no network)
npm run doctor      # check that Kimi CLI is reachable and logged in
npm run demo        # open the bundled sample run in the viewer
npm run sync-skill  # push your working tree to ~/.claude/skills/kimi-workflows
```

If you touch `runner/bin/view-run.js`, run `npm test` -- `view-run.test.js` renders
every run shape (flat, large fan-out, pipeline, single, mixed, empty, scripted) in a
fake DOM and will catch a regression in any of them.

## Gotchas

- `view-run.js` embeds its CSS and client app as `String.raw` template literals -- **no
  backticks inside those strings** (a stray backtick closes the template and breaks the
  generator; the robustness test catches it).
- Workflow scripts run in an isolated `node:vm` context: no `fs`/`process`/`fetch`/timers,
  and `Math.random`/`Date.now`/argless `new Date` are blocked. The *agents* do I/O.

## Pull requests

Keep it dependency-free where possible. Run `npm test` before opening a PR. For changes
that affect the Kimi CLI invocation, note the `kimi` version you tested against.
