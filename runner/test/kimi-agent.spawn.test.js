// Spawn-boundary tests for kimiAgent: the argv contract with kimi 0.23.3 and
// the stream-json parser. A fake `kimi` executable is prepended to PATH; it
// answers `kimi provider list --json` with the real configured-model shape and
// answers prompt turns by (a) recording its argv and (b) replaying
// fixtures/kimi-stream.ndjson — the byte-for-byte output of a real
// `kimi -p ... --output-format stream-json --model kimi-code/kimi-for-coding-highspeed`
// turn on 0.23.3 (assistant tool_calls line, tool result line, final assistant
// content, meta session.resume_hint). Fully offline.
//
// The contract this locks down (all empirically verified on kimi 0.23.3):
//   - argv is `-p <prompt> --output-format stream-json [--model <configured id>]`
//   - NEVER -y/--yolo/--auto: `kimi -p` hard-errors with
//     "error: Cannot combine --prompt with --yolo." (headless -p already
//     auto-approves everything, so those flags are both fatal and redundant)
//   - the returned text is the LAST assistant line with string `content`;
//     tool_calls lines and tool results are ignored, and the trailing
//     `session.resume_hint` meta line only supplies the persisted session id
//   - model ids come from `kimi provider list --json` -> `.models` keys, and
//     aliases like "opus" resolve onto that configured set.

import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { kimiAgent, getClient, shutdownClient } from "../src/kimiAgent.js";
import { resetMeter, tokensSpent } from "../src/meter.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "kimi-stream.ndjson");

const dir = await mkdtemp(join(tmpdir(), "wf-fake-kimi-"));
const argvLog = join(dir, "argv.ndjson");

// The fake `kimi`. Plain CommonJS on purpose: it lives in a tmpdir with no
// package.json, so node treats the extensionless file as CJS.
await writeFile(
  join(dir, "kimi"),
  `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "provider") {
  // Shape of \`kimi provider list --json\` on kimi-code 0.27.0 (the CONFIGURED set),
  // including the max-only k3 frontier tier that opus / --frontier now map onto.
  process.stdout.write(JSON.stringify({
    providers: { "managed:kimi-code": { type: "kimi" } },
    models: {
      "kimi-code/k3": { provider: "managed:kimi-code", model: "k3" },
      "kimi-code/kimi-for-coding": { provider: "managed:kimi-code", model: "kimi-for-coding" },
      "kimi-code/kimi-for-coding-highspeed": { provider: "managed:kimi-code", model: "kimi-for-coding-highspeed" },
    },
  }) + "\\n");
  process.exit(0);
}
fs.appendFileSync(process.env.KIMI_FAKE_ARGV, JSON.stringify(args) + "\\n");
process.stdout.write(fs.readFileSync(process.env.KIMI_FAKE_FIXTURE, "utf8"));
`,
);
await chmod(join(dir, "kimi"), 0o755);

process.env.PATH = dir + delimiter + process.env.PATH;
process.env.KIMI_FAKE_ARGV = argvLog;
process.env.KIMI_FAKE_FIXTURE = FIXTURE;

const promptCalls = async () =>
  (await readFile(argvLog, "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

try {
  // Make sure the model list is (re)loaded through the fake PATH.
  await shutdownClient();
  await getClient();

  // 1) Default turn: argv contract + parser over the real wire fixture.
  {
    const progress = [];
    const text = await kimiAgent("Say the magic word", {
      retries: 0,
      onProgress: (t) => progress.push(t),
    });
    assert.equal(text, "DONE", "returns the LAST assistant content line (not tool output, not the meta line)");
    assert.equal(progress.at(-1), "DONE", "onProgress surfaces the latest assistant content");

    const calls = await promptCalls();
    assert.equal(calls.length, 1, "exactly one kimi prompt spawn");
    const args = calls[0];
    assert.equal(args[0], "-p", "headless prompt flag first");
    assert.match(args[1], /Say the magic word/, "prompt text is the -p value");
    const of = args.indexOf("--output-format");
    assert.notEqual(of, -1, "--output-format is passed");
    assert.equal(args[of + 1], "stream-json", "stream-json output");
    for (const banned of ["-y", "--yolo", "--auto"]) {
      assert.equal(
        args.includes(banned),
        false,
        `${banned} must never be passed: kimi 0.23.3 errors 'Cannot combine --prompt with --yolo.'`,
      );
    }
    assert.equal(args.includes("--model"), false, "no model requested -> kimi config default (no --model)");
  }

  // 2) Alias turn: "opus" resolves onto the configured set from provider list.
  {
    await rm(argvLog, { force: true });
    const text = await kimiAgent("ping", { model: "opus", retries: 0 });
    assert.equal(text, "DONE");
    const [args] = await promptCalls();
    const m = args.indexOf("--model");
    assert.notEqual(m, -1, "--model is passed for an explicit model");
    assert.equal(args[m + 1], "kimi-code/k3", "opus -> configured k3 frontier tier, provider-prefixed");
  }

  // 3) Pinned turn: pinnedModel overrides the per-call model and passes through
  //    when it is an exactly-configured id.
  {
    await rm(argvLog, { force: true });
    const text = await kimiAgent("ping", {
      model: "haiku",
      pinnedModel: "kimi-code/kimi-for-coding-highspeed",
      retries: 0,
    });
    assert.equal(text, "DONE");
    const [args] = await promptCalls();
    const m = args.indexOf("--model");
    assert.equal(args[m + 1], "kimi-code/kimi-for-coding-highspeed", "pin wins and passes through untouched");
  }

  // 4) A completed turn feeds the run-wide meter (budget.spent() / --budget):
  //    the Kimi CLI reports no usage, so the meter runs on estimates — but it
  //    must MOVE, or budget enforcement is dead.
  {
    resetMeter();
    assert.equal(tokensSpent(), 0);
    await kimiAgent("bill me", { retries: 0 });
    assert.ok(tokensSpent() > 0, "a completed turn records estimated tokens into the meter");
    resetMeter();
  }

  // 5) Effort suppression for k3. k3 is the max-only frontier tier: its reasoning
  //    effort is automatic (no --effort knob), so buildFullPrompt must NOT prepend
  //    a "(thinking effort: X)" hint when the RESOLVED model is k3 — but must keep
  //    it for a non-k3 model given the SAME effort. Asserted on the real recorded
  //    -p prompt, through resolveModel + buildFullPrompt + spawn.
  {
    // k3 arm: "opus" resolves onto the configured kimi-code/k3.
    await rm(argvLog, { force: true });
    await kimiAgent("investigate the crash", { model: "opus", effort: "high", retries: 0 });
    const [k3Args] = await promptCalls();
    assert.equal(k3Args[k3Args.indexOf("--model") + 1], "kimi-code/k3", "sanity: opus resolved to the k3 tier");
    assert.doesNotMatch(
      k3Args[1],
      /\(thinking effort:/,
      "k3 turn with effort:'high' -> the effort hint is SUPPRESSED (max-only, automatic effort)",
    );

    // non-k3 arm: "haiku" resolves onto kimi-code/kimi-for-coding-highspeed. Same
    // effort, and the hint IS present — proving the suppression is k3-specific.
    await rm(argvLog, { force: true });
    await kimiAgent("investigate the crash", { model: "haiku", effort: "high", retries: 0 });
    const [nonK3Args] = await promptCalls();
    assert.equal(
      nonK3Args[nonK3Args.indexOf("--model") + 1],
      "kimi-code/kimi-for-coding-highspeed",
      "sanity: haiku resolved to a non-k3 model",
    );
    assert.match(
      nonK3Args[1],
      /\(thinking effort: high\)/,
      "non-k3 turn with the same effort KEEPS the '(thinking effort: high)' hint",
    );
  }

  console.log("kimi-agent.spawn.test: all checks passed");
} finally {
  await shutdownClient();
  await rm(dir, { recursive: true, force: true });
}
