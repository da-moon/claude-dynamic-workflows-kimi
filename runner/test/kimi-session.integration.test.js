// Integration tests for the FULL session stack — runtime.js (agent.start/steer/
// cancel + journal replay) → the REAL startKimiSession driver → the REAL kimiAgent
// spawn boundary — against a fake `kimi` executable on PATH. Fully offline.
//
// The fake binary speaks the verified kimi 0.23.3 wire contract:
//   - `kimi provider list --json` → the configured-model shape
//   - a prompt run records its argv, then prints stream-json ending in a
//     `session.resume_hint` meta line: a FRESH session id, or (with `-S <id>`)
//     the SAME id back — kimi session ids are stable across resumes
//   - `-S session_dead…` fails like a deleted session:
//     `error: failed to run prompt: Session "…" not found.` (exit 1)
//   - a prompt containing SLOWMODE hangs ~8s (killable — the cancel race)
//
// What this locks down (the fixed session contract):
//   1. the driver captures the resume_hint id; follow-up turns pass `-S <id>`
//      with ONLY the new prompt (no transcript embedding) and journal entries
//      record the persisted id + each turn's prompt
//   2. on --resume the runtime hands resumeThreadId+replayPrefix to the driver,
//      journaled turns replay free (zero spawns), and new steers run live on the
//      re-attached session
//   3. a dead journaled session falls back once: fresh session, transcript
//      rebuilt from the journaled prompts
//   4. session.cancel() SIGTERMs the live child quickly and yields status
//      "cancelled"

import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { runWorkflowSource } from "../src/runWorkflow.js";
import { Journal } from "../src/journal.js";
import { getClient, shutdownClient } from "../src/kimiAgent.js";
import { resetMeter } from "../src/meter.js";

const FRESH_ID = "session_00000000-0000-4000-8000-0000000000aa";
const DEAD_ID = "session_dead0000-dead-4dea-8dea-deaddeaddead";

const dir = await mkdtemp(join(tmpdir(), "wf-fake-kimi-sess-"));
const argvLog = join(dir, "argv.ndjson");

// The fake `kimi`. Plain CommonJS on purpose: it lives in a tmpdir with no
// package.json, so node treats the extensionless file as CJS.
await writeFile(
  join(dir, "kimi"),
  `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "provider") {
  process.stdout.write(JSON.stringify({
    providers: { "managed:kimi-code": { type: "kimi" } },
    models: { "kimi-code/kimi-for-coding": { provider: "managed:kimi-code", model: "kimi-for-coding" } },
  }) + "\\n");
  process.exit(0);
}
fs.appendFileSync(process.env.KIMI_FAKE_ARGV, JSON.stringify(args) + "\\n");
const si = args.indexOf("-S");
const resumeId = si !== -1 ? args[si + 1] : null;
const prompt = args[args.indexOf("-p") + 1] ?? "";
if (resumeId && resumeId.startsWith("session_dead")) {
  process.stderr.write('error: failed to run prompt: Session "' + resumeId + '" not found.\\n');
  process.exit(1);
}
const finish = () => {
  const sid = resumeId ?? "${FRESH_ID}";
  process.stdout.write(JSON.stringify({ role: "assistant", content: resumeId ? "ok:resumed" : "ok:fresh" }) + "\\n");
  process.stdout.write(JSON.stringify({ role: "meta", type: "session.resume_hint", session_id: sid, command: "kimi -r " + sid }) + "\\n");
};
if (prompt.includes("SLOWMODE")) setTimeout(finish, 8000);
else finish();
`,
);
await chmod(join(dir, "kimi"), 0o755);

process.env.PATH = dir + delimiter + process.env.PATH;
process.env.KIMI_FAKE_ARGV = argvLog;

const promptCalls = async () =>
  (await readFile(argvLog, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const clearCalls = () => rm(argvLog, { force: true });

const jdir = await mkdtemp(join(tmpdir(), "wf-sess-int-"));
const jpath = join(jdir, "run.jsonl");

try {
  await shutdownClient();
  await getClient(); // (re)load the model list through the fake PATH

  // ── 1) live run: -S resume within a run, prompts never embed the transcript ──
  {
    const j = new Journal(jpath, { reuse: false });
    await j.load();
    const r = await runWorkflowSource([
      'export const meta = { name: "int" };',
      'const s = await agent.start("alpha", { label: "w" });',
      'const a = await s.wait();',
      'const b = await s.steer("beta");',
      'return { a: a.result, b: b.result, thread: s.threadId };',
    ].join("\n"), { journal: j });

    assert.equal(r.a, "ok:fresh", "turn 0 starts a fresh kimi session");
    assert.equal(r.b, "ok:resumed", "the steer resumes the persisted session");
    assert.equal(r.thread, FRESH_ID, "the worker's threadId is the REAL kimi session id from the resume_hint");

    const calls = await promptCalls();
    assert.equal(calls.length, 2, "two live turns, two kimi spawns");
    assert.equal(calls[0].includes("-S"), false, "turn 0 has no -S (fresh session)");
    assert.equal(calls[0][calls[0].indexOf("-p") + 1], "alpha", "turn 0 sends just the prompt");
    const s1 = calls[1].indexOf("-S");
    assert.notEqual(s1, -1, "the steer passes -S");
    assert.equal(calls[1][s1 + 1], FRESH_ID, "…with the captured session id");
    const steerPrompt = calls[1][calls[1].indexOf("-p") + 1];
    assert.equal(steerPrompt, "beta", "the steer sends ONLY the new prompt — no transcript embedding");

    const lines = (await readFile(jpath, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.deepEqual(lines.map((l) => l.prompt), ["alpha", "beta"], "journal records each turn's prompt");
    assert.deepEqual(lines.map((l) => l.threadId), [FRESH_ID, FRESH_ID], "journal records the persisted session id");
  }

  // ── 2) --resume: journaled turns replay FREE; a new steer runs live via -S ──
  {
    await clearCalls();
    const j = new Journal(jpath, { reuse: true });
    await j.load();
    const events = [];
    const r = await runWorkflowSource([
      'export const meta = { name: "int" };',
      'const s = await agent.start("alpha", { label: "w" });',
      'const a = await s.wait();',
      'const b = await s.steer("beta");',
      'const c = await s.steer("gamma");',
      'return { a: a.result, b: b.result, c: c.result, thread: s.threadId };',
    ].join("\n"), { journal: j, onEvent: (e) => events.push(e) });

    assert.equal(r.a, "ok:fresh", "turn 0 replays the journaled result");
    assert.equal(r.b, "ok:resumed", "turn 1 replays too");
    assert.equal(r.c, "ok:resumed", "the NEW steer ran live on the re-attached session");
    assert.equal(r.thread, FRESH_ID, "the worker is back on its original kimi session");
    assert.equal(events.filter((e) => e.type === "cached" && e.kind === "session").length, 2,
      "both journaled turns replayed as cache hits");

    const calls = await promptCalls();
    assert.equal(calls.length, 1, "exactly ONE spawn — the replayed prefix costs zero kimi runs");
    assert.equal(calls[0][calls[0].indexOf("-S") + 1], FRESH_ID, "the live steer resumed the journaled session id");
    assert.equal(calls[0][calls[0].indexOf("-p") + 1], "gamma", "…sending only the new prompt");
  }

  // ── 3) --resume with a DEAD journaled session: fall back to a fresh session,
  //      context rebuilt from the journaled prompts (no crash, no stale replay) ──
  {
    await clearCalls();
    const dead = (await readFile(jpath, "utf8")).replaceAll(FRESH_ID, DEAD_ID);
    await writeFile(jpath, dead);
    const j = new Journal(jpath, { reuse: true });
    await j.load();
    const r = await runWorkflowSource([
      'export const meta = { name: "int" };',
      'const s = await agent.start("alpha", { label: "w" });',
      'const a = await s.wait();',
      'const b = await s.steer("beta");',
      'const c = await s.steer("gamma");',
      'const d = await s.steer("delta");',
      'return { a: a.result, d: d.result };',
    ].join("\n"), { journal: j });

    assert.equal(r.a, "ok:fresh", "the journaled prefix still replays free");
    assert.equal(r.d, "ok:fresh", "the new steer recovered on a FRESH session after the dead -S");

    const calls = await promptCalls();
    assert.equal(calls.length, 2, "one failed -S attempt + one fresh fallback");
    assert.equal(calls[0][calls[0].indexOf("-S") + 1], DEAD_ID, "the dead journaled id was tried first");
    assert.equal(calls[1].includes("-S"), false, "the fallback starts fresh");
    const fallbackPrompt = calls[1][calls[1].indexOf("-p") + 1];
    assert.match(fallbackPrompt, /Previous turns in this session:/, "the fallback rebuilds context");
    assert.match(fallbackPrompt, /Q: alpha[\s\S]*Q: beta[\s\S]*Q: gamma[\s\S]*delta/,
      "…from the journaled prompts, ending with the new turn");
  }

  // ── 4) cancel(): the live kimi child is SIGTERMed quickly, status is cancelled ──
  {
    await clearCalls();
    const t0 = Date.now();
    const r = await runWorkflowSource([
      'export const meta = { name: "int-cancel" };',
      'const s = await agent.start("SLOWMODE hang", { label: "slow" });',
      'const snap = await s.cancel();',
      'return { status: snap.status, session: s.status };',
    ].join("\n"), {});
    const elapsed = Date.now() - t0;

    assert.equal(r.status, "cancelled", "cancel() yields a cancelled snapshot from a REAL killed subprocess");
    assert.equal(r.session, "cancelled", "the session lands in status cancelled");
    assert.ok(elapsed < 5000, `the ~8s child died early (took ${elapsed}ms) — cancel is a real interrupt`);
  }

  console.log("kimi-session.integration.test: all checks passed");
} finally {
  await shutdownClient();
  resetMeter();
  await rm(dir, { recursive: true, force: true });
  await rm(jdir, { recursive: true, force: true });
}
