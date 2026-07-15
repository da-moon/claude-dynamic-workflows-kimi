// Offline unit checks for the protocol-level session driver (kimiSession.js):
// KimiSessionDriver + startKimiSession. No network, no tokens.
//
// The runtime-level orchestration (agent.start/waitAny/steer) is covered in
// offline.js via a fake `startSession` seam, and the full runtime→driver→spawn
// wiring in kimi-session.integration.test.js; THIS file targets the driver layer.
//
// The driver rides kimi's real persisted sessions: it captures the session id
// from the first turn (via the runAgent `onSessionId` callback) and passes it
// back as `resumeSessionId` (-S) on follow-up turns — no transcript re-send.
// When no session id is available (a fake runAgent that never reports one, or a
// journaled session kimi deleted), it falls back to prepending the transcript.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KimiSessionDriver, startKimiSession } from "../src/kimiSession.js";
import { resetMeter } from "../src/meter.js";

resetMeter();

// ── fake kimiAgent seam ───────────────────────────────────────────────────────
// We replace the real subprocess call with a deterministic echo so these tests
// run offline and fast. Every call's (prompt, opts) is recorded for assertions.
let fakeResponses = [];
let fakeIndex = 0;
let fakeCalls = [];

async function fakeKimiAgent(prompt, opts = {}) {
  fakeCalls.push({ prompt, opts });
  const response = fakeResponses[fakeIndex++] ?? `echo: ${prompt.slice(0, 40)}`;
  if (response instanceof Error) throw response;
  return response;
}

// Like the real kimiAgent: reports a persisted-session id after each turn.
function sessionfulFake(sessionId) {
  return async (prompt, opts = {}) => {
    const text = await fakeKimiAgent(prompt, opts);
    opts.onSessionId?.(sessionId);
    return text;
  };
}

function resetFake(responses) {
  fakeResponses = responses ?? [];
  fakeIndex = 0;
  fakeCalls = [];
}

try {
  // 1) startKimiSession resolves model/systemPrompt and returns a driver.
  {
    resetFake();
    const driver = await startKimiSession({ systemPrompt: "You are terse.", model: "kimi-latest", runAgent: fakeKimiAgent });
    assert.ok(driver instanceof KimiSessionDriver, "startKimiSession returns a KimiSessionDriver");
    assert.equal(driver.model, "kimi-latest");
    assert.equal(driver.systemPrompt, "You are terse.");
    assert.equal(driver.resumed, false);
    assert.equal(driver.kimiSessionId, null, "no persisted session until the first turn reports one");
  }

  // 2) beginTurn runs a prompt and returns a completion that resolves to a turn outcome.
  {
    resetFake(["first result"]);
    const driver = new KimiSessionDriver({ model: "kimi-k2", systemPrompt: "sys", cwd: process.cwd(), runAgent: fakeKimiAgent });
    const { turnId, completion } = await driver.beginTurn("hello");
    assert.ok(turnId, "turn id is assigned");
    const outcome = await completion;
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.result, "first result");
    assert.equal(outcome.model, "kimi-k2");
    assert.ok(outcome.ms >= 0);
  }

  // 3) Without a reported session id, the transcript grows across turns and is
  //    prepended to each steer (the context-rebuild fallback path).
  {
    resetFake(["one", "two"]);
    const driver = new KimiSessionDriver({ model: "kimi-k2", systemPrompt: "sys", cwd: process.cwd(), runAgent: fakeKimiAgent });
    await (await driver.beginTurn("first")).completion;
    await (await driver.beginTurn("second")).completion;
    assert.equal(driver._transcript.length, 4, "two user + two assistant turns");
    assert.equal(driver._transcript[0].role, "user");
    assert.equal(driver._transcript[1].role, "assistant");
    assert.match(fakeCalls[1].prompt, /Previous turns in this session:/, "no session id -> the steer prepends the transcript");
    assert.equal(fakeCalls[1].opts.resumeSessionId, undefined, "no session id -> no -S resume requested");
  }

  // 3b) With a reported session id, follow-up turns resume the persisted kimi
  //     session (-S) and send ONLY the new prompt — never the transcript.
  {
    resetFake(["one", "two"]);
    const driver = new KimiSessionDriver({ model: "kimi-k2", systemPrompt: "sys", cwd: process.cwd(), runAgent: sessionfulFake("session_11111111-2222-3333-4444-555555555555") });
    await (await driver.beginTurn("first")).completion;
    assert.equal(driver.kimiSessionId, "session_11111111-2222-3333-4444-555555555555", "the resume_hint session id is captured");
    assert.equal(driver.threadId, "session_11111111-2222-3333-4444-555555555555", "threadId becomes the persisted id (journaled for --resume)");
    await (await driver.beginTurn("second")).completion;
    assert.equal(fakeCalls[0].opts.resumeSessionId, undefined, "first turn starts a fresh session");
    assert.match(fakeCalls[0].prompt, /sys/, "first turn carries the system prompt");
    assert.equal(fakeCalls[1].opts.resumeSessionId, "session_11111111-2222-3333-4444-555555555555", "follow-up turn resumes with -S");
    assert.doesNotMatch(fakeCalls[1].prompt, /Previous turns in this session:/, "resumed turn does NOT embed the transcript");
    assert.doesNotMatch(fakeCalls[1].prompt, /one/, "resumed turn does NOT re-send prior results");
    assert.doesNotMatch(fakeCalls[1].prompt, /sys/, "resumed turn does NOT re-send the system prompt");
    assert.equal(driver._transcript.length, 4, "the transcript is still kept (journal replay identity / fallback)");
  }

  // 4) beginTurn rejects if a turn is already active.
  {
    resetFake([new Promise(() => {})]); // never resolves
    const driver = new KimiSessionDriver({ model: "kimi-k2", systemPrompt: "sys", cwd: process.cwd(), runAgent: fakeKimiAgent });
    await driver.beginTurn("block");
    await assert.rejects(driver.beginTurn("block-again"), /beginTurn called while a turn is active/, "active turn guard");
  }

  // 5) Failed kimiAgent turn resolves to failed outcome (does not throw).
  {
    resetFake([new Error("boom")]);
    const driver = new KimiSessionDriver({ model: "kimi-k2", systemPrompt: "sys", cwd: process.cwd(), runAgent: fakeKimiAgent });
    const outcome = await (await driver.beginTurn("fail")).completion;
    assert.equal(outcome.status, "failed");
    assert.match(outcome.error, /boom/);
  }

  // 6) Schema prompts return parsed JSON.
  {
    resetFake(['{ "answer": 42 }']);
    const driver = new KimiSessionDriver({ model: "kimi-k2", systemPrompt: "sys", cwd: process.cwd(), runAgent: fakeKimiAgent });
    const outcome = await (await driver.beginTurn("schema", { schema: { type: "object", properties: { answer: { type: "integer" } } } })).completion;
    assert.equal(outcome.status, "completed");
    assert.deepEqual(outcome.result, { answer: 42 });
  }

  // 7) startKimiSession with replayPrefix rebuilds the transcript for warm resume:
  //    the first live turn prepends it (no session id was journaled).
  {
    resetFake(["third"]);
    const driver = await startKimiSession({
      systemPrompt: "sys",
      model: "kimi-k2",
      runAgent: fakeKimiAgent,
      replayPrefix: [
        { prompt: "first", result: "one" },
        { prompt: "second", result: "two" },
      ],
    });
    assert.equal(driver.resumed, true);
    assert.equal(driver._transcript.length, 4);
    const outcome = await (await driver.beginTurn("third")).completion;
    assert.equal(outcome.status, "completed");
    assert.match(fakeCalls[0].prompt, /Q: first[\s\S]*A: one[\s\S]*Q: second[\s\S]*A: two/, "the rebuilt transcript is prepended to the first live turn");
  }

  // 7b) startKimiSession with a REAL journaled kimi session id re-attaches via -S:
  //     resumed, no transcript prepend, the very first live turn resumes the session.
  {
    resetFake(["third"]);
    const sid = "session_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const driver = await startKimiSession({
      systemPrompt: "sys",
      model: "kimi-k2",
      runAgent: fakeKimiAgent,
      resumeThreadId: sid,
      replayPrefix: [{ prompt: "first", result: "one" }],
    });
    assert.equal(driver.resumed, true);
    assert.equal(driver.kimiSessionId, sid, "the journaled session id is re-armed for -S");
    assert.equal(driver.threadId, sid);
    await (await driver.beginTurn("third")).completion;
    assert.equal(fakeCalls[0].opts.resumeSessionId, sid, "the first live turn resumes the persisted session");
    assert.doesNotMatch(fakeCalls[0].prompt, /Previous turns/, "no transcript prepend when kimi holds the context");
  }

  // 7c) Old-scheme journal (synthetic thread id, no recorded prompts): neither -S
  //     nor a transcript rebuild is possible — clean invalidation (resumed:false),
  //     so the runtime re-runs every turn live.
  {
    resetFake();
    const driver = await startKimiSession({
      systemPrompt: "sys",
      model: "kimi-k2",
      runAgent: fakeKimiAgent,
      resumeThreadId: "kimi-session-1700000000-abc123",
      replayPrefix: [{ result: "one", promptHash: "deadbeef" }], // no prompt recorded
    });
    assert.equal(driver.resumed, false, "unrebuildable old-scheme journal -> clean invalidation");
    assert.equal(driver.kimiSessionId, null, "a synthetic kimi-session-* id is never passed to -S");
    assert.equal(driver._transcript.length, 0);
  }

  // 7d) Journaled session id that kimi no longer has: the turn falls back ONCE to
  //     a fresh session with the transcript prepended (context rebuilt), and the
  //     fresh session's id re-arms -S for later turns.
  {
    resetFake();
    const freshId = "session_ffffffff-0000-1111-2222-333333333333";
    const runAgent = async (prompt, opts = {}) => {
      fakeCalls.push({ prompt, opts });
      if (opts.resumeSessionId === "session_dead0000-dead-dead-dead-deaddeaddead") {
        throw new Error('Kimi exited with code 1; stderr=error: failed to run prompt: Session "session_dead0000-dead-dead-dead-deaddeaddead" not found.');
      }
      opts.onSessionId?.(freshId);
      return "recovered";
    };
    const driver = await startKimiSession({
      systemPrompt: "sys",
      model: "kimi-k2",
      runAgent,
      resumeThreadId: "session_dead0000-dead-dead-dead-deaddeaddead",
      replayPrefix: [{ prompt: "first", result: "one" }],
    });
    const outcome = await (await driver.beginTurn("second")).completion;
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.result, "recovered");
    assert.equal(fakeCalls.length, 2, "exactly one -S attempt + one fresh fallback");
    assert.match(fakeCalls[1].prompt, /Q: first[\s\S]*A: one/, "the fallback turn rebuilds context from the transcript");
    assert.equal(fakeCalls[1].opts.resumeSessionId, undefined, "the fallback starts a fresh session");
    assert.equal(driver.kimiSessionId, freshId, "the fresh session id re-arms -S for later turns");
  }

  // 8) interruptCurrent() aborts the live turn: the runAgent signal fires, and the
  //    completion resolves with status "interrupted" (runtime maps it to cancelled).
  {
    resetFake();
    const runAgent = (prompt, opts = {}) =>
      new Promise((_res, rej) => {
        opts.signal.addEventListener("abort", () => {
          const err = new Error("Kimi turn interrupted (cancelled)");
          err.interrupted = true;
          rej(err);
        }, { once: true });
      });
    const driver = new KimiSessionDriver({ model: "kimi-k2", systemPrompt: "sys", cwd: process.cwd(), runAgent });
    const { completion } = await driver.beginTurn("slow");
    await driver.interruptCurrent();
    const outcome = await completion;
    assert.equal(outcome.status, "interrupted", "an aborted turn resolves interrupted, not failed");
    assert.equal(outcome.error, null, "interruption is not an error");
    assert.equal(driver._transcript.length, 0, "an interrupted turn never enters the transcript");
    await driver.interruptCurrent(); // idle -> no-op, must not throw
  }

  console.log("kimi-session checks passed");
} finally {
  resetFake();
  resetMeter();
}
