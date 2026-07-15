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
  // Shape of \`kimi provider list --json\` on kimi 0.23.3 (the CONFIGURED set).
  process.stdout.write(JSON.stringify({
    providers: { "managed:kimi-code": { type: "kimi" } },
    models: {
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
    assert.equal(args[m + 1], "kimi-code/kimi-for-coding", "opus -> configured id, provider-prefixed");
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

  console.log("kimi-agent.spawn.test: all checks passed");
} finally {
  await shutdownClient();
  await rm(dir, { recursive: true, force: true });
}
