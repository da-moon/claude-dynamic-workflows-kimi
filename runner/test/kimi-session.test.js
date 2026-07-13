// Offline unit checks for the protocol-level session driver (kimiSession.js):
// KimiSessionDriver + startKimiSession. No network, no tokens.
//
// The runtime-level orchestration (agent.start/waitAny/steer) is covered in
// offline.js via a fake `startSession` seam; THIS file targets the driver layer
// beneath it. Kimi CLI has no lightweight persistent thread API, so the driver
// keeps a transcript and prepends it to each steer prompt.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KimiSessionDriver, startKimiSession } from "../src/kimiSession.js";
import { resetMeter } from "../src/meter.js";

resetMeter();

// ── fake kimiAgent seam ───────────────────────────────────────────────────────
// We replace the real subprocess call with a deterministic echo so these tests
// run offline and fast.
let fakeResponses = [];
let fakeIndex = 0;

async function fakeKimiAgent(prompt) {
  const response = fakeResponses[fakeIndex++] ?? `echo: ${prompt.slice(0, 40)}`;
  if (response instanceof Error) throw response;
  return response;
}

function resetFake(responses) {
  fakeResponses = responses ?? [];
  fakeIndex = 0;
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

  // 3) Transcript grows across turns so steering retains context.
  {
    resetFake(["one", "two"]);
    const driver = new KimiSessionDriver({ model: "kimi-k2", systemPrompt: "sys", cwd: process.cwd(), runAgent: fakeKimiAgent });
    await (await driver.beginTurn("first")).completion;
    await (await driver.beginTurn("second")).completion;
    assert.equal(driver._transcript.length, 4, "two user + two assistant turns");
    assert.equal(driver._transcript[0].role, "user");
    assert.equal(driver._transcript[1].role, "assistant");
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

  // 7) startKimiSession with replayPrefix rebuilds transcript for warm resume.
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
  }

  console.log("kimi-session checks passed");
} finally {
  resetFake();
  resetMeter();
}
