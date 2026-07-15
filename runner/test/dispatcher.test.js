// Checks for the advertised npx entrypoint (bin/kimi-workflows.js) and the
// run-workflow argv contract. All offline, no kimi, no tokens.
//
//  1. Every MAP target resolves to a file that exists — a renamed runner/bin
//     script can't ship a broken dispatcher.
//  2. Exit-code contract: no args / -h / help / `doctor --help` → 0 with usage;
//     an unknown command → 1 with usage; a forwarded child's exit code
//     propagates.
//  3. run-workflow rejects unknown flags and stray positionals loudly (exit 1,
//     the offending token named) instead of silently swallowing them or
//     treating a leading flag as the script path.
//
//   node test/dispatcher.test.js

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const DISPATCH = new URL("../../bin/kimi-workflows.js", import.meta.url).pathname;
const RUNNER = new URL("..", import.meta.url).pathname;
const RUN = new URL("../bin/run-workflow.js", import.meta.url).pathname;

let n = 0;
const ok = (m) => { n++; console.log("  ✓ " + m); };
const sh = (bin, args) => spawnSync("node", [bin, ...args], { encoding: "utf8", timeout: 30_000 });

// ── 1 · MAP targets exist ─────────────────────────────────────────────────────
{
  const src = readFileSync(DISPATCH, "utf8");
  const mapBlock = src.match(/const MAP = \{([\s\S]*?)\};/);
  assert.ok(mapBlock, "bin/kimi-workflows.js declares a MAP object");
  const entries = [...mapBlock[1].matchAll(/(\w+):\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]);
  assert.equal(entries.length, 8, "MAP has the 8 documented commands");
  const cmds = entries.map(([c]) => c);
  for (const want of ["run", "fleet", "supervise", "view", "map", "summarize", "compare", "doctor"]) {
    assert.ok(cmds.includes(want), `MAP includes '${want}'`);
  }
  for (const [cmd, rel] of entries) {
    assert.ok(existsSync(join(RUNNER, rel)), `MAP['${cmd}'] -> ${rel} exists under runner/`);
  }
  ok("all 8 MAP targets resolve to existing runner files");
}

// ── 2 · dispatcher exit codes ─────────────────────────────────────────────────
{
  const usage = /usage: kimi-workflows/;

  const none = sh(DISPATCH, []);
  assert.equal(none.status, 0, "no args exits 0 (help was effectively asked)");
  assert.match(none.stderr, usage);

  for (const flag of ["-h", "--help", "help"]) {
    const r = sh(DISPATCH, [flag]);
    assert.equal(r.status, 0, `'${flag}' exits 0`);
    assert.match(r.stderr, usage);
  }

  const unknown = sh(DISPATCH, ["frobnicate"]);
  assert.equal(unknown.status, 1, "unknown command exits 1");
  assert.match(unknown.stderr, usage, "unknown command prints usage");

  // doctor takes no flags: `doctor --help` prints the dispatcher usage and
  // exits 0 WITHOUT spawning the handshake (which would talk to kimi).
  const doc = sh(DISPATCH, ["doctor", "--help"]);
  assert.equal(doc.status, 0, "'doctor --help' exits 0");
  assert.match(doc.stderr, usage, "'doctor --help' shows usage, not a handshake");
  ok("exit-code contract: 0 for help/no-args, 1 for unknown, doctor --help stays local");
}

// ── 3 · forwarding + child exit-code propagation ──────────────────────────────
{
  const r = sh(DISPATCH, ["run", "--help"]);
  assert.equal(r.status, 0, "'run --help' propagates run-workflow's exit 0");
  assert.match(r.stderr, /usage: run-workflow/, "run-workflow's own usage is shown");

  const bad = sh(DISPATCH, ["run", "--multi", "wf.js"]);
  assert.equal(bad.status, 1, "a rejected child flag propagates as exit 1");
  assert.match(bad.stderr, /unknown flag '--multi'/);
  ok("dispatcher forwards args and propagates the child's exit code");
}

// ── 4 · run-workflow strict argv ──────────────────────────────────────────────
{
  const lead = sh(RUN, ["--multi", "wf.js"]);
  assert.equal(lead.status, 1, "a leading unknown flag exits 1");
  assert.match(lead.stderr, /unknown flag '--multi'/, "the offending flag is named");
  assert.ok(!/ENOENT/.test(lead.stderr), "the flag never becomes the script path");

  const typo = sh(RUN, ["wf.js", "--sandbx", "read-only"]);
  assert.equal(typo.status, 1, "a typo'd flag after the script exits 1");
  assert.match(typo.stderr, /unknown flag '--sandbx'/);

  const extra = sh(RUN, ["wf.js", "other.js"]);
  assert.equal(extra.status, 1, "a second positional exits 1");
  assert.match(extra.stderr, /unexpected argument 'other.js'/);

  const help = sh(RUN, ["--help"]);
  assert.equal(help.status, 0, "--help still exits 0");
  const noScript = sh(RUN, []);
  assert.equal(noScript.status, 1, "no script exits 1 with usage");
  assert.match(noScript.stderr, /usage: run-workflow/);
  ok("run-workflow rejects unknown flags / stray args loudly; --help unchanged");
}

console.log(`dispatcher.test: ${n} checks passed`);
