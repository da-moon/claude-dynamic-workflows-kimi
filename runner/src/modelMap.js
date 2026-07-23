// Map a model id requested by a workflow (often a Claude id, or a bare
// opus/sonnet/haiku alias from a Claude-authored script or an agentType
// definition) onto a model the local Kimi CLI actually exposes.

export function modelId(m) {
  if (typeof m === "string") return m;
  if (m && typeof m === "object") return m.id ?? m.slug ?? m.model ?? m.name ?? null;
  return null;
}

// Claude tier -> ordered Kimi preferences (first configured match wins).
// The usable set comes from `kimi provider list --json` (config.toml); ids are
// provider-prefixed. Verified on kimi-code 0.27.0: kimi-code/k3 (the max-only
// frontier tier, model "k3", 1M ctx), kimi-code/kimi-for-coding, and
// kimi-code/kimi-for-coding-highspeed. Tier map: opus -> k3; sonnet & haiku ->
// the highspeed coding model. Preferences are bare model names matched exactly
// or after the provider prefix; later entries cover other/older installs.
const FAMILY_PREFERENCES = {
  opus: ["k3", "kimi-for-coding", "kimi-latest", "kimi-k2-6", "kimi-k2-5", "kimi-k2"],
  sonnet: ["kimi-for-coding-highspeed", "kimi-for-coding", "kimi-latest", "kimi-k2-5", "kimi-k2-6", "kimi-k2"],
  haiku: ["kimi-for-coding-highspeed", "kimi-for-coding", "kimi-lite", "kimi-k2-5", "kimi-latest", "kimi-k2"],
};

// Common aliases that may be used in scripts or agent definitions: ordered
// preference lists, first configured match wins (first entry when the model
// list is unavailable). "kimi"/"frontier" lead with k3, the strongest tier.
const MODEL_ALIASES = {
  "kimi": ["k3", "kimi-for-coding", "kimi-latest"],
  "frontier": ["k3", "kimi-for-coding", "kimi-latest"],
};

// Match a bare preference name against the configured list: exact id, or the
// model name after a provider prefix ("kimi-for-coding" matches
// "kimi-code/kimi-for-coding" and "~kimi-code~kimi-for-coding" forms).
function findConfigured(name, available) {
  return available.find((m) => m === name || m.endsWith(`/${name}`) || m.endsWith(`~${name}`));
}

// Matches Claude full ids ("claude-opus-4-8") and bare aliases ("opus").
function claudeFamily(id) {
  const s = String(id).toLowerCase();
  if (/opus/.test(s)) return "opus";
  if (/sonnet/.test(s)) return "sonnet";
  if (/haiku/.test(s)) return "haiku";
  return null;
}

function isKimiModel(id) {
  return /^kimi-/i.test(String(id));
}

// True for the k3 frontier tier: the bare model "k3", or a provider-prefixed
// id ending in "/k3" / "~k3" (e.g. "kimi-code/k3"). Used by pickFrontier to rank
// k3 as the strongest configured tier. k3 accepts reasoning effort low/high/max
// (default max) per Moonshot's docs, so the runner injects the effort hint for it
// like any other model; note the managed kimi-code endpoint advertises
// supportEfforts:["max"] and may pin k3 to max regardless.
//
// It keys purely on the "/k3" / "~k3" / exact-"k3" suffix and is
// PROVIDER-AGNOSTIC: a foreign "openai/k3" WOULD match, while a raw-API
// "kimi-k3" (a hyphen, not a provider separator) would NOT. That looseness is
// deliberate and accepted because this plugin only ever drives Kimi and this
// box's configured id is "kimi-code/k3" — so a provider allow-list would buy
// nothing over the suffix test.
export function isK3(id) {
  const v = String(id ?? "").toLowerCase();
  return v === "k3" || v.endsWith("/k3") || v.endsWith("~k3");
}

/**
 * Resolve `requested` to a Kimi model id (or undefined to use Kimi's config
 * default).
 *   undefined / "inherit" / "default" -> undefined
 *   Claude id or alias                -> mapped family preference (best available)
 *   already-available id              -> as-is
 *   unknown but unavailable           -> undefined (config default) + warn
 * If `available` is empty (`kimi provider list` unavailable), Claude ids still map to
 * their top preference and other ids pass through unchanged.
 */
export function resolveModel(requested, available = [], log = () => {}) {
  if (!requested || /^(inherit|default)$/i.test(requested)) return undefined;

  const family = claudeFamily(requested);
  if (family) {
    const prefs = FAMILY_PREFERENCES[family] || [];
    const pick = available.length
      ? (prefs.map((p) => findConfigured(p, available)).find(Boolean) ??
         available.find((m) => isKimiModel(m) && !/mini|spark/i.test(m)) ??
         available[0])
      : prefs[0];
    if (pick) {
      log(`model: '${requested}' (Claude) -> '${pick}'`);
      return pick;
    }
    return undefined;
  }

  // An exactly-configured id passes through untouched.
  if (available.includes(requested)) return requested;

  // Expand API aliases BEFORE suffix matching, so "frontier" resolves to its
  // intended target instead of suffix-matching an unrelated id (e.g. a
  // hypothetical "someprovider/frontier").
  const aliasPrefs = MODEL_ALIASES[String(requested).toLowerCase()];
  if (aliasPrefs) {
    const pick = available.length
      ? aliasPrefs.map((p) => findConfigured(p, available)).find(Boolean)
      : aliasPrefs[0];
    if (pick) {
      log(`model: '${requested}' -> '${pick}'`);
      return pick;
    }
  } else {
    // Accept a bare id when the configured list has it with a provider prefix
    // (e.g. "kimi-for-coding" matches "kimi-code/kimi-for-coding").
    const bareMatch = findConfigured(requested, available);
    if (bareMatch) return bareMatch;
    if (!available.length) return requested; // can't validate -- trust it
  }

  log(`model: '${requested}' not configured in Kimi -> using config default (have: ${available.join(", ")})`);
  return undefined;
}

// Pick the frontier model from the CONFIGURED model list (`kimi provider list`):
// the newest, strongest general model. Prefers "k3" (the max-only frontier tier
// on kimi-code 0.27.0 — so --frontier pins k3 whenever it is configured), then
// "kimi-latest", then "kimi-for-coding" (ties broken toward the plain id over
// -highspeed), then the newest kimi-k2-* model, then any other model, excluding
// mini/spark variants.
export function pickFrontier(models = []) {
  const id = (m) => (typeof m === "string" ? m : m?.id ?? m?.model ?? m?.slug ?? m?.name);
  const versionParts = (s) => {
    const mt = String(s).match(/(\d+(?:\.\d+)?)/);
    return mt ? mt[1].split(".").map(Number) : [-1];
  };
  const compareVersionDesc = (left, right) => {
    const a = versionParts(left);
    const b = versionParts(right);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const delta = (b[i] ?? 0) - (a[i] ?? 0);
      if (delta) return delta;
    }
    return 0;
  };
  const strength = (s) => {
    const value = String(s).toLowerCase();
    if (isK3(value)) return 6; // k3: the max-only frontier tier — outranks everything, incl. kimi-latest
    if (value === "kimi-latest" || value.endsWith("/kimi-latest") || value.endsWith("~kimi-latest")) return 5;
    if (/kimi-for-coding/.test(value)) return 4; // both variants; length tiebreak prefers the plain id
    if (/k2\.6/.test(value) || /k2-6/.test(value)) return 3;
    if (/k2\.5/.test(value) || /k2-5/.test(value)) return 2;
    if (/k2/.test(value)) return 1;
    return 0;
  };
  const eligible = models
    .map((m) => ({
      id: id(m),
      isDefault: typeof m === "object" && !!m?.isDefault,
      hidden: typeof m === "object" && !!m?.hidden,
    }))
    .filter((m) => m.id && !m.hidden && !/(mini|spark)/i.test(m.id));
  if (!eligible.length) return undefined;
  eligible.sort(
    (a, b) =>
      strength(b.id) - strength(a.id) ||
      compareVersionDesc(a.id, b.id) ||
      Number(b.isDefault) - Number(a.isDefault) ||
      a.id.length - b.id.length,
  );
  return eligible[0].id;
}
