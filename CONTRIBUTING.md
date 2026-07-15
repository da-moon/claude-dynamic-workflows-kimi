# Contributing

Thanks for your interest! This is a small, dependency-free project -- easy to hack on.

## Layout

- `SKILL.md` -- the Claude Code skill definition (what Claude reads when the skill loads).
  It lives at the repo root on purpose: this is the single-skill *plugin-root* layout, where
  the plugin directory itself is the skill (the frontmatter `name: kimi-workflows` is
  load-bearing for that layout -- don't remove it).
- `.claude-plugin/plugin.json` -- Claude Code plugin manifest. It intentionally has **no
  `version` field** (`claude plugin validate` warns about this; the warning is accepted):
  with no version, the installed plugin version falls back to the git SHA, so **every push
  is a new version** and `/plugin` updates always pick up the latest commit. Don't add a
  static semver -- a stale number would mask pushed changes -- unless you also wire a
  release step that bumps it (and root `package.json`) on every release.
- `.claude-plugin/marketplace.json` -- Claude Code marketplace bundle manifest.
- `runner/` -- the standalone runner (Node, zero deps):
  - `src/` -- the seam (`kimiAgent.js` + `kimiSession.js` for sessionful workers) + provider-neutral DSL (`runtime.js`), and helpers (model mapping, agentTypes, journal, worktree, meter).
  - `bin/run-workflow.js` -- CLI to execute a workflow script.
  - `bin/view-run.js` -- the run-viewer generator (`--serve` adds the interactive cockpit endpoint).
  - `bin/fleet.js` -- fleet supervision: `status` (multi-run digest) + `answer` (the human()/checkpoint channel; `src/fleetStatus.js` is the pure logic).
  - `bin/supervise.js` -- wrap any command in the fleet-protocol sidecars (gates via `@@ASK` lines \u2194 stdin; the protocol's reference second producer).
  - `test/` -- `offline.js` (unit), `kimi-agent.spawn.test.js` (the kimi argv contract + stream-json parser), `kimi-session.test.js` (session driver + chaos), `kimi-session.integration.test.js` (the full session stack against a fake `kimi` binary), `view-run.test.js` / `view-run.live.test.js` / `map-run.test.js` / `summarize-run.test.js` (viewer + summary robustness across run shapes), `serve.test.js` (cockpit channel), `fleet.test.js` (fleet status/answer + the agent-supervisor loop), `goal-lint.plan.test.js` / `claim-check.plan.test.js` (harness-zoo dry runs), `supervise.test.js` (the second fleet-protocol producer), `compare-runs.test.js` (across-runs analytics), `examples.plan.test.js` (every bundled workflow stays `--plan`-safe), `dispatcher.test.js` (the npx dispatcher contract), `sync-skill.test.js` (the sync-skill guard + synced manifest), `handshake.js` (live Kimi connectivity -- the `npm run doctor` probe, deliberately not part of `all.js`).
- `references/` -- `authoring.md` (workflow-script DSL), `runner-readme.md` (architecture / Kimi prompt mapping / faithfulness), `fleet-protocol.md` (the sidecar contract that makes runs supervisable -- implement it to add a new producer/consumer).
- `examples/` -- runnable templates and a bundled `demo/` run.
- `bin/kimi-workflows.js` -- the npx/git-install dispatcher (`run` / `fleet` / `supervise` / `view` / `map` / `summarize` / `compare` / `doctor`).
- `scripts/sync-skill.js` -- one-command sync of the skill surface to `~/.claude/skills/kimi-workflows` (`npm run sync-skill`).

## Develop

No build step. Requires Node >= 18.17 (CI runs the maintained LTS lines, 20 and 24).

```bash
npm test            # full offline suite via runner/test/all.js (no Kimi, no network)
npm run doctor      # check that Kimi CLI is reachable and logged in
npm run demo        # open the bundled sample run in the viewer
npm run sync-skill  # push your working tree to ~/.claude/skills/kimi-workflows
```

The suite list lives in one place: `runner/test/all.js` globs every
`runner/test/*.test.js` (plus `offline.js`), and `npm test` -- at the root, in
`runner/`, and in CI -- runs that. Drop a new `*.test.js` file in `runner/test/`
and it runs everywhere automatically; keep it offline (no Kimi, no network).

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
