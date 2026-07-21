// Sandbox enforcement tests (issue #1): `sandbox:'read-only'` is ENFORCED
// (best-effort) — the turn's cwd moves into a disposable detached git worktree
// and a hard read-only preamble tops the prompt — while the DEFAULT path (no
// sandbox anywhere) stays byte-identical full-auto, and unhonorable values are
// refused fast, BEFORE any spawn. Fully offline: a fake `kimi` on PATH records
// each prompt spawn's argv + cwd (and can plant a stray write to prove
// containment), replaying the real 0.23.3 wire fixture.
//
// The contract locked down here:
//   - no sandbox set  -> argv is exactly [-p <prompt> --output-format stream-json],
//                        cwd is the caller's cwd, no preamble (M2: unrestricted
//                        full-auto is the first-class default — zero added friction)
//   - read-only       -> cwd is an isolated worktree AT HEAD (not the real tree);
//                        the prompt STARTS with the read-only preamble; a stray
//                        write lands in the worktree and is DISCARDED; the flags
//                        around the prompt are unchanged
//   - read-only, cwd not a git repo -> REFUSED before spawn, clear error
//   - unknown sandbox value          -> REFUSED before spawn, clear error
//   - workspace-write / danger-full-access -> advisory: behavior identical to
//                        the default (same argv shape, same cwd, no preamble)
//   - journal + summary distinguish enforced vs advisory per agent, and the CLI
//     refuses --sandbox typos / unenforceable read-only runs (non-repo cwd OR a
//     repo with no commits — worktrees detach at HEAD) at startup.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { kimiAgent, getClient, shutdownClient, READ_ONLY_PREAMBLE, SANDBOX_VALUES } from "../src/kimiAgent.js";
import { startKimiSession } from "../src/kimiSession.js";
import { createRuntime } from "../src/runtime.js";
import { Journal } from "../src/journal.js";
import { summarizeRun, renderSummaryText } from "../src/runSummary.js";
import { resetMeter } from "../src/meter.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "kimi-stream.ndjson");
const RUN_WORKFLOW = join(HERE, "..", "bin", "run-workflow.js");

const base = await mkdtemp(join(tmpdir(), "wf-sandbox-"));
const binDir = join(base, "bin");
await mkdir(binDir);
const argvLog = join(base, "argv.ndjson");

// The fake `kimi` (extensionless CJS, same pattern as kimi-agent.spawn.test.js),
// extended for sandbox proofs: each prompt turn records argv + the cwd it ran in
// + whether the repo's committed marker file is visible there, and — when
// KIMI_FAKE_WRITE names a file — plants a stray relative-path write in its cwd
// (what a misbehaving "read-only" agent would do).
await writeFile(
  join(binDir, "kimi"),
  `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "provider") {
  process.stdout.write(JSON.stringify({
    providers: { "managed:kimi-code": { type: "kimi" } },
    models: {
      "kimi-code/k3": { provider: "managed:kimi-code", model: "k3" },
      "kimi-code/kimi-for-coding": { provider: "managed:kimi-code", model: "kimi-for-coding" },
    },
  }) + "\\n");
  process.exit(0);
}
if (process.env.KIMI_FAKE_WRITE) {
  try { fs.writeFileSync(process.env.KIMI_FAKE_WRITE, "stray write from the agent"); } catch {}
}
fs.appendFileSync(process.env.KIMI_FAKE_ARGV, JSON.stringify({
  args,
  cwd: process.cwd(),
  seesCommitted: fs.existsSync("committed.txt"),
}) + "\\n");
process.stdout.write(fs.readFileSync(process.env.KIMI_FAKE_FIXTURE, "utf8"));
`,
);
await chmod(join(binDir, "kimi"), 0o755);

process.env.PATH = binDir + delimiter + process.env.PATH;
process.env.KIMI_FAKE_ARGV = argvLog;
process.env.KIMI_FAKE_FIXTURE = FIXTURE;
delete process.env.KIMI_FAKE_WRITE;

// A real git repo (the tree read-only agents must not touch), a non-repo dir,
// and an EMPTY repo (git init, zero commits — unborn HEAD, so a detached
// worktree at HEAD cannot be created).
const repoDir = join(base, "repo");
const plainDir = join(base, "plain");
const emptyRepoDir = join(base, "empty-repo");
await mkdir(repoDir);
await mkdir(plainDir);
await mkdir(emptyRepoDir);
execFileSync("git", ["init", "-q"], { cwd: emptyRepoDir, stdio: "pipe" });
const git = (args) => execFileSync("git", args, { cwd: repoDir, stdio: "pipe" });
git(["init", "-q"]);
git(["config", "user.email", "t@example.com"]);
git(["config", "user.name", "t"]);
await writeFile(join(repoDir, "committed.txt"), "at HEAD\n");
git(["add", "."]);
git(["commit", "-q", "-m", "init"]);

const promptCalls = async () =>
  (await readFile(argvLog, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const resetCalls = () => rm(argvLog, { force: true });

try {
  await shutdownClient();
  await getClient();
  resetMeter();

  // 1) DEFAULT PATH (M2): no sandbox anywhere → byte-identical spawn args,
  //    caller's cwd, no preamble. Zero added friction on the full-auto default.
  {
    await resetCalls();
    const text = await kimiAgent("hello world", { cwd: repoDir, retries: 0 });
    assert.equal(text, "DONE");
    const [call] = await promptCalls();
    assert.deepEqual(
      call.args,
      ["-p", "hello world", "--output-format", "stream-json"],
      "default argv is byte-identical: no sandbox flags, no preamble, no extra args",
    );
    assert.equal(call.cwd, repoDir, "default turn runs in the caller's cwd (no isolation)");
    assert.equal(call.args[1].includes("SANDBOX: READ-ONLY"), false, "no preamble on the default path");
    console.log("  ✓ default path: byte-identical argv, caller cwd, no preamble");
  }

  // 2) READ-ONLY: enforced — isolated worktree cwd at HEAD, preamble first,
  //    stray writes contained and discarded, flags otherwise unchanged.
  {
    await resetCalls();
    process.env.KIMI_FAKE_WRITE = "stray.txt";
    let metrics = null;
    const text = await kimiAgent("audit the code", {
      sandbox: "read-only",
      cwd: repoDir,
      retries: 0,
      onMetrics: (m) => { metrics = m; },
    });
    delete process.env.KIMI_FAKE_WRITE;
    assert.equal(text, "DONE");
    const [call] = await promptCalls();
    assert.notEqual(call.cwd, repoDir, "read-only turn does NOT run in the real tree");
    assert.equal(call.seesCommitted, true, "the isolated cwd is a worktree at HEAD (committed files visible)");
    assert.ok(call.args[1].startsWith(READ_ONLY_PREAMBLE), "the hard read-only preamble comes FIRST in the prompt");
    assert.match(call.args[1], /audit the code/, "the task prompt follows the preamble");
    assert.deepEqual(
      [call.args[0], call.args[2], call.args[3]],
      ["-p", "--output-format", "stream-json"],
      "flags around the prompt are unchanged (still plain -p / stream-json)",
    );
    assert.equal(existsSync(join(repoDir, "stray.txt")), false, "the agent's stray write never reached the real tree");
    assert.equal(existsSync(call.cwd), false, "the dirty worktree was DISCARDED after the turn (stray write dropped)");
    assert.equal(metrics.sandbox, "read-only", "metrics carry the sandbox value");
    assert.equal(metrics.sandboxEnforced, true, "metrics attest enforcement");
    console.log("  ✓ read-only: worktree cwd at HEAD, preamble first, stray write contained + discarded");
  }

  // 3) READ-ONLY REFUSED FAST: a cwd where worktree isolation is unavailable
  //    fails BEFORE any spawn with a clear, actionable error.
  {
    await resetCalls();
    await assert.rejects(
      () => kimiAgent("x", { sandbox: "read-only", cwd: plainDir, retries: 0 }),
      /sandbox 'read-only' cannot be enforced.*not a git repository/,
      "clear refusal naming the reason",
    );
    assert.equal((await promptCalls()).length, 0, "refused before spawn — kimi never ran");
    console.log("  ✓ read-only in a non-repo cwd: refused fast, no spawn");
  }

  // 4) UNKNOWN VALUE REFUSED: a typo must not silently run full-auto under a
  //    wrong label.
  {
    await resetCalls();
    await assert.rejects(
      () => kimiAgent("x", { sandbox: "readonly", cwd: repoDir, retries: 0 }),
      new RegExp(`unknown sandbox value 'readonly'.*${SANDBOX_VALUES.join(" \\| ")}`),
      "refusal lists the valid values",
    );
    assert.equal((await promptCalls()).length, 0, "refused before spawn");
    console.log("  ✓ unknown sandbox value: refused fast, no spawn");
  }

  // 5) ADVISORY VALUES: workspace-write behaves exactly like the default
  //    (full-auto, caller cwd, no preamble) and is reported as NOT enforced.
  {
    await resetCalls();
    let metrics = null;
    const text = await kimiAgent("hello world", {
      sandbox: "workspace-write",
      cwd: repoDir,
      retries: 0,
      onMetrics: (m) => { metrics = m; },
    });
    assert.equal(text, "DONE");
    const [call] = await promptCalls();
    assert.deepEqual(call.args, ["-p", "hello world", "--output-format", "stream-json"], "advisory label changes nothing on the wire");
    assert.equal(call.cwd, repoDir, "advisory label does not move the cwd");
    assert.equal(metrics.sandbox, "workspace-write");
    assert.equal(metrics.sandboxEnforced, false, "advisory label is reported as NOT enforced");
    console.log("  ✓ workspace-write: advisory — identical wire behavior, enforced:false");
  }

  // 6) JOURNAL HONESTY (runtime → journal): enforced read-only records
  //    sandboxEnforced:true; an advisory label records false; the default
  //    records NEITHER field (journal bytes unchanged).
  {
    const jpath = join(base, "journal.jsonl");
    const journal = new Journal(jpath);
    await journal.load();
    const rt = createRuntime({ journal, onLog: () => {} });
    await rt.agent("read-only journaled", { sandbox: "read-only", cwd: repoDir, retries: 0, label: "ro" });
    await rt.agent("advisory journaled", { sandbox: "workspace-write", cwd: repoDir, retries: 0, label: "adv" });
    await rt.agent("default journaled", { cwd: repoDir, retries: 0, label: "def" });
    const entries = (await readFile(jpath, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    const by = (label) => entries.find((e) => e.label === label);
    assert.equal(by("ro").sandbox, "read-only");
    assert.equal(by("ro").sandboxEnforced, true, "enforced read-only is journaled as enforced");
    assert.equal(by("adv").sandbox, "workspace-write");
    assert.equal(by("adv").sandboxEnforced, false, "advisory label is journaled as NOT enforced");
    assert.equal("sandbox" in by("def"), false, "no sandbox → no sandbox fields in the journal (default untouched)");
    assert.equal("sandboxEnforced" in by("def"), false);
    console.log("  ✓ journal: enforced:true / advisory:false / default records neither");
  }

  // 7) SESSIONS: a read-only worker is enforced at the session level (worktree
  //    persists across turns; preamble rides the thread instructions; stray
  //    writes are discarded at close) and refuses a non-repo cwd at start.
  {
    await resetCalls();
    const driver = await startKimiSession({ sandbox: "read-only", cwd: repoDir, systemPrompt: "Be terse.", log: () => {} });
    assert.notEqual(driver.cwd, repoDir, "session cwd is the isolated worktree, not the real tree");
    assert.equal(driver.sandboxEnforced, true);
    process.env.KIMI_FAKE_WRITE = "session-stray.txt";
    const { completion } = await driver.beginTurn("scan the repo", {});
    const outcome = await completion;
    delete process.env.KIMI_FAKE_WRITE;
    assert.equal(outcome.status, "completed");
    const [call] = await promptCalls();
    assert.ok(call.args[1].startsWith(READ_ONLY_PREAMBLE), "session turn carries the preamble (above the system prompt)");
    assert.match(call.args[1], /Be terse\./, "the author's system prompt survives underneath");
    const wt = driver.cwd;
    await driver.cleanup();
    assert.equal(existsSync(join(repoDir, "session-stray.txt")), false, "session stray write never reached the real tree");
    assert.equal(existsSync(wt), false, "dirty read-only session worktree DISCARDED at close");
    await assert.rejects(
      () => startKimiSession({ sandbox: "read-only", cwd: plainDir, log: () => {} }),
      /sandbox 'read-only' cannot be enforced.*not a git repository/,
      "session start refuses an unenforceable read-only fast",
    );
    console.log("  ✓ sessions: enforced worktree + preamble, discard-on-close, fast refusal");
  }

  // 8) REPORTING: summarize-run distinguishes enforced vs advisory — per agent
  //    (counts + warning) and at run level (policy line).
  {
    const jdir = join(base, "report");
    await mkdir(jdir);
    const jpath = join(jdir, "r.jsonl");
    const lines = [
      { key: "a#0", label: "scan:a", phase: "Scan", model: "m", tokens: 10, ms: 5, result: {}, sandbox: "read-only", sandboxEnforced: true },
      { key: "b#0", label: "scan:b", phase: "Scan", model: "m", tokens: 10, ms: 5, result: {}, sandbox: "read-only" }, // pre-enforcement entry
    ];
    await writeFile(jpath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    await writeFile(join(jdir, "r.meta.json"), JSON.stringify({
      startedAt: 1, model: "m", autoEffort: false, pinEffort: null,
      sandbox: "read-only", sandboxEnforcement: "enforced",
    }));
    const s = summarizeRun({ journalPath: jpath });
    assert.equal(s.policy.sandbox, "read-only");
    assert.equal(s.policy.sandboxEnforcement, "enforced");
    assert.equal(s.counts.sandboxedAgents, 2);
    assert.equal(s.counts.sandboxEnforcedAgents, 1);
    assert.equal(s.counts.sandboxAdvisoryAgents, 1);
    const warns = s.warnings.filter((w) => w.level === "warn").map((w) => w.code);
    assert.ok(warns.includes("unenforced-read-only"), "a read-only label without enforcement evidence warns");
    const txt = renderSummaryText(s);
    assert.match(txt, /sandbox read-only \(enforced\)/, "policy line shows enforcement");
    assert.match(txt, /1\/2 agents sandbox-enforced/, "per-agent enforced count rendered");
    console.log("  ✓ reporting: enforced vs advisory per agent + run policy + warning");
  }

  // 9) CLI FAIL-FAST: --sandbox typos and unenforceable read-only runs exit 1
  //    at startup — before journals, monitors, or any agent spawn.
  {
    await resetCalls();
    const script = join(base, "noop.workflow.js");
    await writeFile(script, "return null;\n");
    const envBase = { ...process.env };

    const bad = spawnSync(process.execPath, [RUN_WORKFLOW, script, "--sandbox", "readonly", "--no-journal"], {
      cwd: repoDir, env: envBase, encoding: "utf8", timeout: 30_000,
    });
    assert.equal(bad.status, 1, "--sandbox typo exits 1");
    assert.match(bad.stderr, /--sandbox: unknown value 'readonly'/, "typo refusal names the value and the valid set");

    const nonRepo = spawnSync(process.execPath, [RUN_WORKFLOW, script, "--sandbox", "read-only", "--no-journal"], {
      cwd: plainDir, env: envBase, encoding: "utf8", timeout: 30_000,
    });
    assert.equal(nonRepo.status, 1, "--sandbox read-only outside a git repo exits 1");
    assert.match(nonRepo.stderr, /read-only: cannot be enforced here/, "startup refusal is explicit");

    // An EMPTY repo (unborn HEAD) is just as unenforceable — worktree creation
    // would fail on the first agent call. It must be refused at startup too,
    // before journals or monitors, in the same style as the non-repo refusal.
    const emptyRepo = spawnSync(process.execPath, [RUN_WORKFLOW, script, "--sandbox", "read-only", "--no-journal"], {
      cwd: emptyRepoDir, env: envBase, encoding: "utf8", timeout: 30_000,
    });
    assert.equal(emptyRepo.status, 1, "--sandbox read-only in a commitless repo exits 1");
    assert.match(emptyRepo.stderr, /read-only: cannot be enforced here/, "startup refusal, same style as the non-repo one");
    assert.match(emptyRepo.stderr, /no commits/, "refusal names the actual reason (unborn HEAD)");
    assert.match(emptyRepo.stderr, /initial commit/, "refusal is actionable");

    assert.equal(existsSync(argvLog), false, "no agent was spawned by any refusal");
    console.log("  ✓ CLI: --sandbox typo, non-repo, and commitless-repo read-only all refused at startup");
  }

  console.log("sandbox-enforcement.test: all checks passed");
} finally {
  delete process.env.KIMI_FAKE_WRITE;
  await shutdownClient();
  resetMeter();
  await rm(base, { recursive: true, force: true });
}
