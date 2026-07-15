// Single source of truth for the test suite. Globs every runner/test/*.test.js
// (plus offline.js, which predates the naming convention) and runs each in its
// own child process with a labeled banner, so a new *.test.js file is picked up
// automatically -- by `npm test` at the root, in runner/, and in CI, which all
// point here. Everything this runs is offline: no Kimi binary, no credentials,
// no network, no model spend (the session/spawn suites drive a fake kimi).
//
//   node runner/test/all.js

import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const DIR = dirname(fileURLToPath(import.meta.url));

// offline.js first (fast unit checks), then every *.test.js alphabetically.
// handshake.js is deliberately excluded: it is the `npm run doctor` probe and
// needs a real kimi binary.
const suites = [
  "offline.js",
  ...readdirSync(DIR).filter((f) => f.endsWith(".test.js")).sort(),
];

const failures = [];
for (const suite of suites) {
  console.log(`\n=== ${suite} ===`);
  const r = spawnSync(process.execPath, [join(DIR, suite)], { stdio: "inherit" });
  if (r.status !== 0) failures.push(`${suite} (exit ${r.status ?? `signal ${r.signal}`})`);
}

console.log("");
if (failures.length > 0) {
  console.error(`FAILED ${failures.length}/${suites.length} suites:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`all ${suites.length} suites passed ✓`);
