// Checks for scripts/sync-skill.js — the repo → skills-dir installer.
//
//  1. The self-destruct guard: a fixture repo (so a regression can't hurt the
//     real one) refuses to sync onto itself or onto an ancestor directory,
//     exits 1, and leaves the tree (including .git) intact.
//  2. The sync set, against the REAL repo into a temp dest: SKILL.md,
//     .claude-plugin/ (plugin identity), bin/ (the npx entrypoint), references/,
//     examples/, runner/ all ship; BOTH committed demo journals survive; run
//     artifacts (*.run.html, stray .workflow-journal dirs, .DS_Store) do not.
//
//   node test/sync-skill.test.js

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, existsSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const REPO = new URL("../..", import.meta.url).pathname;
const SYNC = join(REPO, "scripts", "sync-skill.js");
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "wf-sync-")));

let n = 0;
const ok = (m) => { n++; console.log("  ✓ " + m); };
const run = (script, args) => spawnSync("node", [script, ...args], { encoding: "utf8", timeout: 30_000 });

try {
  // ── fixture repo (guard tests run here so a broken guard can't eat the real repo)
  const fix = join(ROOT, "repo");
  for (const d of [
    "scripts", ".git", ".claude-plugin", "bin", "references",
    join("examples", "demo", ".workflow-journal"),
    join("examples", "incident-demo", ".workflow-journal"),
    join("examples", "other", ".workflow-journal"),
    "runner",
  ]) mkdirSync(join(fix, d), { recursive: true });
  cpSync(SYNC, join(fix, "scripts", "sync-skill.js"));
  writeFileSync(join(fix, "SKILL.md"), "# fixture skill\n");
  writeFileSync(join(fix, "package.json"), JSON.stringify({ version: "0.0.0-fixture" }));
  writeFileSync(join(fix, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(fix, ".claude-plugin", "plugin.json"), "{}");
  writeFileSync(join(fix, "bin", "kimi-workflows.js"), "// stub\n");
  writeFileSync(join(fix, "references", "r.md"), "ref");
  writeFileSync(join(fix, "examples", "demo", ".workflow-journal", "demo.jsonl"), "{}");
  writeFileSync(join(fix, "examples", "incident-demo", ".workflow-journal", "incident.jsonl"), "{}");
  writeFileSync(join(fix, "examples", "other", ".workflow-journal", "local.jsonl"), "{}");
  writeFileSync(join(fix, "examples", "page.run.html"), "<html>");
  writeFileSync(join(fix, "examples", ".DS_Store"), "");
  writeFileSync(join(fix, "runner", "a.js"), "// a");
  const FIXSYNC = join(fix, "scripts", "sync-skill.js");

  // 1a) DEST == repo root → refuse, exit 1, nothing deleted
  const self = run(FIXSYNC, [fix]);
  assert.equal(self.status, 1, "syncing onto the repo itself exits 1");
  assert.match(self.stderr, /refusing/i, "the refusal is explicit");
  assert.ok(existsSync(join(fix, ".git", "HEAD")), ".git survives");
  assert.ok(existsSync(join(fix, "SKILL.md")), "working tree survives");
  ok("guard: DEST == repo root refuses and destroys nothing");

  // 1b) DEST is an ancestor of the repo → refuse too (deleting it deletes the repo)
  const anc = run(FIXSYNC, [ROOT]);
  assert.equal(anc.status, 1, "syncing onto an ancestor exits 1");
  assert.match(anc.stderr, /refusing/i);
  assert.ok(existsSync(join(fix, ".git", "HEAD")), "repo (and its parent) survive");
  ok("guard: DEST ancestor of the repo refuses and destroys nothing");

  // 1c) a legitimate dest still works on the fixture, with the right sync set
  const fdest = join(ROOT, "fixture-dest");
  const fsync = run(FIXSYNC, [fdest]);
  assert.equal(fsync.status, 0, "fixture sync succeeds: " + fsync.stderr);
  for (const p of [
    "SKILL.md",
    join(".claude-plugin", "plugin.json"),
    join("bin", "kimi-workflows.js"),
    join("references", "r.md"),
    join("examples", "demo", ".workflow-journal", "demo.jsonl"),
    join("examples", "incident-demo", ".workflow-journal", "incident.jsonl"),
    join("runner", "a.js"),
  ]) assert.ok(existsSync(join(fdest, p)), `synced copy has ${p}`);
  assert.ok(!existsSync(join(fdest, "examples", "other", ".workflow-journal")), "stray journals are dropped");
  assert.ok(!existsSync(join(fdest, "examples", "page.run.html")), "*.run.html is dropped");
  assert.ok(!existsSync(join(fdest, "examples", ".DS_Store")), ".DS_Store is dropped");
  assert.ok(!existsSync(join(fdest, ".git")), ".git is not part of the sync set");
  ok("fixture sync ships plugin identity + bin + both demo journals, drops artifacts");

  // 2) the REAL repo syncs into a temp dest with the same contract
  const rdest = join(ROOT, "real-dest");
  const rsync = run(SYNC, [rdest]);
  assert.equal(rsync.status, 0, "real-repo sync succeeds: " + rsync.stderr);
  for (const p of [
    "SKILL.md",
    join(".claude-plugin", "plugin.json"),
    join("bin", "kimi-workflows.js"),
    join("examples", "demo", ".workflow-journal", "nimbus-landing-redesign.workflow.jsonl"),
    join("examples", "incident-demo", ".workflow-journal", "checkout-incident.workflow.jsonl"),
    join("runner", "bin", "run-workflow.js"),
  ]) assert.ok(existsSync(join(rdest, p)), `real sync has ${p}`);
  // the synced bin dispatcher actually works from the synced location
  const doc = spawnSync("node", [join(rdest, "bin", "kimi-workflows.js")], { encoding: "utf8", timeout: 30_000 });
  assert.equal(doc.status, 0, "synced dispatcher runs (usage, exit 0)");
  assert.match(doc.stderr, /usage: kimi-workflows/);
  ok("real repo syncs with plugin identity, both demo journals, and a working bin/");

  console.log(`sync-skill.test: ${n} checks passed`);
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}
