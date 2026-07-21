// Detect the installed `kimi` CLI version and flag drift from the version this
// runner's prompt bindings were verified against. Cheap, best-effort: a
// mismatch is a warning (CLI flags are usually stable), not a hard failure.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

// Bump when the runner is re-verified against a newer Kimi CLI. Soft pin: drift
// only WARNS (the argv contract is stable across these releases), never fails.
// 0.27.0: argv contract re-verified — -p / --output-format stream-json / --model
// with configured ids / -S resume, plus `kimi provider list --json` as the source
// of usable model ids (now including the max-only kimi-code/k3 frontier tier).
export const VERIFIED_KIMI_VERSION = "0.27.0";

// Versions whose contract was verified EQUIVALENT on 0.23.3 and 0.27.0:
// the argv (`-p` / `--output-format stream-json` / `--model <configured id>` /
// `-S` resume) plus the stream-json `session.resume_hint` line were byte-identical
// on every release checked, so drift between any two of them is a non-event. This
// keeps the currently-runnable 0.23.3 CLI from warning even though the pin is
// 0.27.0. Anything OUTSIDE this set is genuinely unverified and still warns.
export const KNOWN_COMPATIBLE_VERSIONS = ["0.23.3", "0.27.0"];

export async function detectKimiVersion() {
  try {
    const { stdout } = await exec("kimi", ["--version"], { timeout: 10_000 });
    const m = String(stdout).match(/(\d+\.\d+\.\d+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// Returns a warning string if `found` differs from the verified version, else null.
// No warning when `found` is the pin, is undetected, or is in the known-compatible
// set alongside the pin (0.23.3 ⇄ 0.27.0 were verified byte-identical) — only a
// genuinely-unverified version drifts.
export function versionDriftNote(found, pinned = VERIFIED_KIMI_VERSION) {
  if (!found || found === pinned) return null;
  if (KNOWN_COMPATIBLE_VERSIONS.includes(found) && KNOWN_COMPATIBLE_VERSIONS.includes(pinned)) return null;
  return (
    `kimi ${found} detected; this runner's prompt bindings were verified against ${pinned}. ` +
    `Calls should still work, but if they fail, check the --prompt and --output-format flags.`
  );
}
