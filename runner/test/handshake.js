// Cheap transport checks (no model turn, no tokens):
//   1. detect Kimi CLI version
//   2. list available models from the provider catalog
//   3. reconnect -- after shutdown, getClient() refreshes the model list.

import { getClient, shutdownClient } from "../src/kimiAgent.js";
import { detectKimiVersion, versionDriftNote, VERIFIED_KIMI_VERSION } from "../src/kimiVersion.js";

try {
  const client = await getClient();
  console.log("state:", client.readyState);
  const ver = await detectKimiVersion();
  console.log("kimi version:", ver ?? "(unknown)", `(runner verified against ${VERIFIED_KIMI_VERSION})`);
  const drift = versionDriftNote(ver);
  if (drift) console.error(drift);
  const models = await client.listModels();
  console.log("models exposed:", models.length);
  const sample = models.slice(0, 6).map((m) =>
    typeof m === "string" ? m : m?.id ?? m?.slug ?? m?.model ?? m?.name ?? JSON.stringify(m).slice(0, 48),
  );
  console.log("sample:", sample);

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
