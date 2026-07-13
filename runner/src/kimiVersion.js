// Detect the installed `kimi` CLI version and flag drift from the version this
// runner's prompt bindings were verified against. Cheap, best-effort: a
// mismatch is a warning (CLI flags are usually stable), not a hard failure.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

// Bump when the runner is re-verified against a newer Kimi CLI.
export const VERIFIED_KIMI_VERSION = "0.23.6";

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
export function versionDriftNote(found, pinned = VERIFIED_KIMI_VERSION) {
  if (!found || found === pinned) return null;
  return (
    `kimi ${found} detected; this runner's prompt bindings were verified against ${pinned}. ` +
    `Calls should still work, but if they fail, check the --prompt and --output-format flags.`
  );
}
