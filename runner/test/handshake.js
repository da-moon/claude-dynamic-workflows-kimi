// Preflight (`npm run doctor`):
//   1. detect Kimi CLI version (warn on drift from the verified pin)
//   2. list the CONFIGURED models (`kimi provider list --json` -- the ids
//      `kimi --model` actually accepts)
//   3. resolve the frontier pick and verify it is in the configured set
//   4. run ONE minimal model-pinned turn (`kimi -p ... --model <frontier>`) --
//      this is the exact spawn shape every workflow agent uses, so a green
//      handshake means `run-workflow --frontier` can actually complete turns
//   5. reconnect -- after shutdown, getClient() refreshes the model list.
//
// Pass --offline to skip the live turn (steps 1-3 and 5 only, no tokens).

import { getClient, shutdownClient, kimiAgent } from "../src/kimiAgent.js";
import { pickFrontier } from "../src/modelMap.js";
import { detectKimiVersion, versionDriftNote, VERIFIED_KIMI_VERSION } from "../src/kimiVersion.js";

const offline = process.argv.includes("--offline");

try {
  const client = await getClient();
  console.log("state:", client.readyState);
  const ver = await detectKimiVersion();
  console.log("kimi version:", ver ?? "(unknown)", `(runner verified against ${VERIFIED_KIMI_VERSION})`);
  const drift = versionDriftNote(ver);
  if (drift) console.error(drift);

  const models = await client.listModels();
  console.log("configured models:", models.length, models.length ? `(${models.join(", ")})` : "");
  if (!models.length) {
    throw new Error("no configured models -- check `kimi provider list --json` / config.toml");
  }

  // The exact resolution `run-workflow --frontier` performs: the pick must be a
  // configured id, or every agent turn would die with config.invalid.
  const frontier = pickFrontier(models);
  console.log("frontier pick:", frontier ?? "(none)");
  if (!frontier || !models.includes(frontier)) {
    throw new Error(
      `frontier pick '${frontier}' is not in the configured model set (${models.join(", ")})`,
    );
  }

  // One tiny real turn pinned to the frontier model -- proves the -p /
  // --output-format stream-json / --model bindings end to end.
  if (offline) {
    console.log("model-pinned turn: skipped (--offline)");
  } else {
    const reply = await kimiAgent("Reply with exactly: OK", {
      model: frontier,
      retries: 0,
      timeoutMs: 120_000,
    });
    console.log(`model-pinned turn (${frontier}):`, JSON.stringify(reply));
    if (!/OK/i.test(String(reply ?? ""))) {
      throw new Error(`model-pinned turn returned unexpected text: ${JSON.stringify(reply)}`);
    }
  }

  // Reconnect proof.
  await shutdownClient();
  const client2 = await getClient();
  console.log("reconnected:", client2.readyState, "| new instance:", client2 !== client);
} catch (e) {
  console.error("handshake failed:", e?.message ?? e);
  process.exitCode = 1;
} finally {
  await shutdownClient();
}
