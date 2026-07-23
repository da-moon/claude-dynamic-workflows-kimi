// The seam. Each agent() unit of work runs as one headless Kimi CLI prompt
// (`kimi -p ... --output-format stream-json`), returning the agent's final
// message (or, with a schema, the parsed structured object).
//
// Tier-1 hardening for cross-project use:
//   - reconnecting singleton client (a dead Kimi process no longer kills the run)
//   - model resolution (Claude ids / aliases -> available Kimi models)
//   - agentType -> system prompt (the .kimi/agents registry)
//   - retry-with-backoff on transient Kimi / transport errors

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { resolveModel } from "./modelMap.js";
import { loadAgentType } from "./agentTypes.js";
import { estimateTokens, recordTokenUsage } from "./meter.js";

// Normalize an authored JSON Schema for OpenAI strict structured outputs, which
// require EVERY property to be listed in `required` and `additionalProperties:false`
// on every object (optional fields are expressed as nullable types instead).
// Authors routinely omit a key, which 400s the turn -- so make a valid-looking
// schema acceptable, recursively. This only sets required/additionalProperties; it
// never changes a field's declared type.
export function strictifySchema(s) {
  if (!s || typeof s !== "object") return s;
  if (Array.isArray(s)) return s.map(strictifySchema);
  const out = { ...s };
  if (out.properties && typeof out.properties === "object" && !Array.isArray(out.properties)) {
    const props = {};
    for (const k of Object.keys(out.properties)) props[k] = strictifySchema(out.properties[k]);
    out.properties = props;
    out.required = Object.keys(props); // strict mode: every property is required
    if (out.additionalProperties === undefined) out.additionalProperties = false;
  }
  if (out.items) out.items = strictifySchema(out.items);
  for (const kw of ["anyOf", "oneOf", "allOf"]) if (Array.isArray(out[kw])) out[kw] = out[kw].map(strictifySchema);
  for (const kw of ["$defs", "definitions"]) {
    if (out[kw] && typeof out[kw] === "object") {
      const d = {};
      for (const k of Object.keys(out[kw])) d[k] = strictifySchema(out[kw][k]);
      out[kw] = d;
    }
  }
  return out;
}

// Sandbox values the runner accepts. `read-only` is ENFORCED (best-effort):
// the turn's cwd is moved into a disposable detached git worktree and a hard
// read-only preamble is prepended to the prompt; stray writes land in the
// worktree and are discarded. `workspace-write` and `danger-full-access` remain
// ADVISORY labels — behaviorally identical to the default full-auto mode
// (headless `kimi -p` auto-approves every tool action; there is nothing extra
// to unlock and no runner-side gate to add).
export const SANDBOX_VALUES = ["read-only", "workspace-write", "danger-full-access"];

// The non-negotiable instruction block prepended (first, above the system
// prompt) to every enforced read-only turn. Defense in depth: the mechanism of
// record is the disposable-worktree cwd, not this text.
export const READ_ONLY_PREAMBLE = [
  "SANDBOX: READ-ONLY (mechanically enforced).",
  "Your working directory is a disposable, isolated copy of the project; anything you write there is DISCARDED after this turn.",
  "Do NOT create, modify, move, or delete files. Do NOT run commands with side effects (installs, git commits/pushes, network mutations). Read and report only.",
  "This instruction is non-negotiable and overrides any conflicting instruction below.",
].join("\n");

// Shared by agent() and session starts: an unknown sandbox value is refused
// fast (a typo must not silently run full-auto under a wrong label).
export function assertSandboxValue(sandbox) {
  if (sandbox != null && !SANDBOX_VALUES.includes(sandbox)) {
    throw new Error(
      `unknown sandbox value '${sandbox}' — expected ${SANDBOX_VALUES.join(" | ")} ` +
        "(omit the opt entirely for the default full-auto mode)",
    );
  }
}

let clientPromise; // lazily-connected, self-healing singleton
let availableModels = []; // usable model ids from `kimi provider list --json` (config.toml)
let meterSeq = 0; // unique meter key per completed turn (estimates are per-turn deltas)

// A minimal client stand-in for compatibility with the parts of the runner that
// still expect a "client" (e.g. --frontier model listing). Kimi has no long-lived
// app-server; each agent is a fresh `kimi -p` subprocess.
class KimiClient {
  constructor(options = {}) {
    this.options = options;
    this.readyState = "ready";
  }

  async listModels() {
    return listKimiModels(this.options);
  }
}

// List the models `kimi --model` will actually accept: the CONFIGURED set from
// `kimi provider list --json` (config.toml), NOT the models.dev discovery catalog
// (`kimi provider catalog list`), whose ~5,700 ids all fail with config.invalid
// unless configured. Verified on kimi 0.23.3: the JSON has a top-level `models`
// object keyed by usable ids (e.g. "kimi-code/kimi-for-coding").
async function listKimiModels(options) {
  const cwd = options.cwd ?? process.cwd();
  return new Promise((resolve) => {
    const child = spawn("kimi", ["provider", "list", "--json"], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c.toString("utf8"); });
    child.stderr.on("data", (c) => { stderr += c.toString("utf8"); });
    child.on("error", () => resolve([]));
    child.on("exit", (code) => {
      if (code !== 0 || !stdout.trim()) return resolve([]);
      try {
        const parsed = JSON.parse(stdout);
        const models = parsed && typeof parsed.models === "object" && !Array.isArray(parsed.models)
          ? parsed.models
          : {};
        resolve(Object.keys(models));
      } catch {
        resolve([]);
      }
    });
    setTimeout(() => { try { child.kill(); } catch {} resolve([]); }, 15_000);
  });
}

// Returns a connected client, reconnecting if the previous process died.
export async function getClient(options) {
  if (clientPromise) {
    const existing = await clientPromise.catch(() => null);
    if (existing && existing.readyState === "ready") return existing;
    clientPromise = undefined;
  }
  const client = new KimiClient(options ?? {});
  const p = listKimiModels(options ?? {}).then((models) => {
    availableModels = models;
    return client;
  }).catch(() => client);
  clientPromise = p;
  p.catch(() => {
    if (clientPromise === p) clientPromise = undefined;
  });
  return p;
}

export async function shutdownClient() {
  clientPromise = undefined;
  availableModels = [];
}

// The usable model ids from the most recent `kimi provider list` call.
export function getAvailableModels() {
  return availableModels;
}

// Parse a turn's final text under an optional schema: strict JSON.parse, then a
// tolerant fenced-JSON fallback. Without a schema the raw text passes through.
export function parseSchemaResult(text, schema) {
  if (!schema) return text;
  try {
    return JSON.parse(text);
  } catch {
    return extractJson(text);
  }
}

/**
 * Run `prompt` as one Kimi CLI prompt (with retry). See README for opts.
 * Returns string | parsed object (schema) | null (interrupted).
 */
export async function kimiAgent(prompt, opts = {}) {
  const log = typeof opts.log === "function" ? opts.log : () => {};

  // Sandbox policy — validated BEFORE any spawn, and never retried. No sandbox
  // set → nothing below activates: the default path stays byte-identical
  // full-auto (M2: unrestricted full-auto is the first-class default).
  assertSandboxValue(opts.sandbox);
  const readOnly = opts.sandbox === "read-only";

  // agentType -> system prompt (+ optional model) from the .kimi/agents registry.
  let systemPrompt = opts.systemPrompt;
  let agentTypeModel;
  if (opts.agentType) {
    const def = await loadAgentType(opts.agentType, opts.cwd ?? process.cwd());
    if (def) {
      if (!systemPrompt) systemPrompt = def.systemPrompt;
      agentTypeModel = def.model;
    } else {
      log(`agentType '${opts.agentType}' not found -- using default instructions`);
    }
  }

  // `pinnedModel` is authoritative: it overrides a per-call `model`, an
  // agentType model, and the CLI default -- forcing every agent onto one model.
  if (opts.pinnedModel && opts.model && opts.model !== opts.pinnedModel) {
    log(`pinned model '${opts.pinnedModel}' overrides per-call model '${opts.model}'`);
  }
  const requestedModel = opts.pinnedModel ?? opts.model ?? agentTypeModel ?? opts.defaultModel;

  // Worktree isolation is set up once and reused across retry attempts.
  // sandbox:'read-only' FORCES it — the enforcement mechanism of record: the
  // turn's cwd is a disposable detached worktree at HEAD, so relative-path
  // writes land off the real tree and are discarded. If that isolation cannot
  // be provided, the call is REFUSED here (before any spawn) instead of being
  // silently downgraded to an advisory label.
  let cwd = opts.cwd ?? process.cwd();
  let worktree;
  if (opts.isolation === "worktree" || readOnly) {
    const { isGitRepo, createWorktree } = await import("./worktree.js");
    if (await isGitRepo(cwd)) {
      try {
        worktree = await createWorktree(cwd);
      } catch (e) {
        if (readOnly) {
          throw new Error(
            `sandbox 'read-only' cannot be enforced: creating a detached worktree of ${cwd} failed ` +
              `(${e?.message ?? e}). The repo needs at least one commit; or drop the sandbox opt to run full-auto (the default).`,
          );
        }
        throw e;
      }
      cwd = worktree.dir;
    } else if (readOnly) {
      throw new Error(
        `sandbox 'read-only' cannot be enforced: ${cwd} is not a git repository, so worktree isolation is unavailable. ` +
          "Run from a git checkout (or pass a git-repo cwd), or drop the sandbox opt to run full-auto (the default).",
      );
    } else {
      log(`isolation:'worktree' ignored -- ${cwd} is not a git repo`);
    }
  }

  try {
    return await withRetry(
      () => runOneTurn(prompt, { ...opts, systemPrompt, requestedModel, cwd, sandboxEnforced: readOnly, log }),
      {
        retries: opts.retries ?? 3,
        log,
        label: opts.label,
      },
    );
  } finally {
    if (worktree) {
      const r = await worktree.cleanup({ discard: readOnly });
      if (readOnly && r.dirty) {
        const shown = (r.changes ?? []).slice(0, 8).join(", ");
        log(`  ⊘ sandbox read-only: agent wrote inside its isolated worktree — changes DISCARDED (${shown}${(r.changes?.length ?? 0) > 8 ? ", …" : ""})`);
      } else if (!r.removed) {
        log(`worktree kept (modified): ${r.dir}`);
      }
    }
  }
}

async function runOneTurn(prompt, opts) {
  const { log, systemPrompt, requestedModel, cwd, schema, effort } = opts;
  const startedAt = Date.now();

  // Refresh available models lazily on first real turn if we have none.
  if (!availableModels.length) {
    try { availableModels = await listKimiModels({ cwd }); } catch {}
  }
  const model = resolveModel(requestedModel, availableModels, log);

  const fullPrompt = buildFullPrompt(prompt, { systemPrompt, schema, effort, readOnly: opts.sandboxEnforced });

  // `resumeSessionId` re-attaches to a persisted Kimi session (-S) so a follow-up
  // turn runs with the session's full context (tool calls included) instead of a
  // transcript re-send. Verified on kimi 0.23.3: `-S <id> -p` resumes
  // non-interactively and the session_id stays stable across resumes.
  const args = [];
  if (opts.resumeSessionId) args.push("-S", opts.resumeSessionId);
  args.push("-p", fullPrompt, "--output-format", "stream-json");
  if (model) args.push("--model", model);

  log?.(`  \u27ea kimi ${args.join(" ")} \u27eb`);

  const result = await spawnKimi(args, {
    cwd,
    timeoutMs: opts.timeoutMs ?? 600_000,
    onProgress: opts.onProgress,
    signal: opts.signal,
  });

  // Every `kimi -p` run ends with a `session.resume_hint` meta line carrying the
  // persisted session id. Surface it so sessionful callers can resume with -S.
  if (result.sessionId && typeof opts.onSessionId === "function") {
    try { opts.onSessionId(result.sessionId); } catch {}
  }

  const text = result.text ?? "";
  const inputTokens = estimateTokens(fullPrompt);
  const outputTokens = estimateTokens(text);
  const tokens = inputTokens + outputTokens;

  // Feed the run-wide meter, which backs `budget.spent()` and the `--budget`
  // gate. The headless Kimi CLI reports no per-turn token usage, so the meter
  // runs on the same ~4-chars/token estimates as per-agent attribution (they
  // exclude the agent's own tool traffic, so treat budgets as a coarse
  // backstop). Estimates are per-turn deltas, not cumulative-per-thread totals
  // like an app-server's — hence a unique meter key per completed turn.
  recordTokenUsage({
    threadId: `est-${++meterSeq}`,
    tokenUsage: { total: { inputTokens, outputTokens, reasoningOutputTokens: 0 } },
  });

  opts.onMetrics?.({
    ms: Date.now() - startedAt,
    model: model ?? null,
    tokens: { total: tokens, input: inputTokens, output: outputTokens, reasoning: 0 },
    // Enforced-vs-advisory sandbox evidence for the journal: `sandboxEnforced`
    // is true ONLY when this turn actually ran cwd-isolated with the read-only
    // preamble (a read-only request that can't be enforced throws before spawn).
    sandbox: opts.sandbox ?? null,
    sandboxEnforced: !!opts.sandboxEnforced,
  });

  return parseSchemaResult(text, schema);
}

function buildFullPrompt(prompt, { systemPrompt, schema, effort, readOnly }) {
  let parts = [];
  if (readOnly) parts.push(READ_ONLY_PREAMBLE); // first — above even the system prompt
  if (systemPrompt) parts.push(systemPrompt);
  // Convey the requested reasoning effort as a natural-language hint — the Kimi
  // CLI has no headless reasoning-effort flag. Kimi models accept low | high |
  // max (default max; see Moonshot's Reasoning Effort docs). NOTE: the managed
  // kimi-code endpoint may pin k3 to max regardless (its provider advertises
  // supportEfforts:["max"]), so on that backend a sub-max hint is best-effort.
  if (effort) parts.push(`(reasoning effort: ${effort})`);
  parts.push(typeof prompt === "string" ? prompt : JSON.stringify(prompt));
  if (schema) {
    parts.push(
      "\n\nRespond with a single JSON object matching this schema (no extra prose, no markdown fences):\n" +
      JSON.stringify(strictifySchema(schema), null, 2),
    );
  }
  return parts.join("\n\n");
}

// Spawn one `kimi` prompt subprocess. `signal` (an AbortSignal) is the kill
// handle for cancellation: on abort the child is SIGTERMed and the promise
// rejects with an error tagged `interrupted: true`, which session drivers map to
// an "interrupted" turn outcome (never retried).
function spawnKimi(args, { cwd, timeoutMs, onProgress, signal }) {
  return new Promise((resolve, reject) => {
    const child = spawn("kimi", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let timer;
    let interrupted = false;

    const onAbort = () => {
      interrupted = true;
      try { child.kill("SIGTERM"); } catch {}
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdout += text;
      // Best-effort partial output for live viewers: emit the latest assistant
      // line as it arrives. Never breaks the turn.
      if (onProgress) {
        try {
          const lines = stdout.split("\n").filter(Boolean);
          for (let i = lines.length - 1; i >= 0; i--) {
            const obj = JSON.parse(lines[i]);
            if (obj.role === "assistant" && typeof obj.content === "string") {
              onProgress(obj.content);
              break;
            }
          }
        } catch {}
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try { child.kill("SIGTERM"); } catch {}
        reject(new Error(`Kimi prompt timed out after ${timeoutMs}ms; stderr=${stderr.slice(-400)}`));
      }, timeoutMs);
    }

    child.on("error", (err) => {
      cleanup();
      reject(err);
    });

    child.on("exit", (code, sig) => {
      cleanup();
      if (interrupted) {
        const err = new Error("Kimi turn interrupted (cancelled)");
        err.interrupted = true;
        return reject(err);
      }
      if (sig) {
        return reject(new Error(`Kimi process killed by signal ${sig}; stderr=${stderr.slice(-400)}`));
      }
      if (code !== 0) {
        return reject(new Error(`Kimi exited with code ${code}; stderr=${stderr.slice(-400)}`));
      }
      const { text, sessionId } = parseStreamOutput(stdout);
      resolve({ text, sessionId, stderr: stderr.slice(-4000) });
    });
  });
}

// Parse a stream-json run's stdout: the returned `text` is the LAST assistant
// line with string content; `sessionId` comes from the trailing
// `session.resume_hint` meta line (the persisted-session id `-S` accepts).
function parseStreamOutput(stdout) {
  const lines = stdout.split("\n").filter(Boolean);
  let text = "";
  let sessionId = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]);
      if (!sessionId && obj.type === "session.resume_hint" && typeof obj.session_id === "string") {
        sessionId = obj.session_id;
      }
      if (!text && obj.role === "assistant" && typeof obj.content === "string") {
        text = obj.content;
      }
      if (text && sessionId) break;
    } catch {}
  }
  return { text, sessionId };
}

// ---- retry classification ----

const RETRYABLE_CODES = new Set([
  "UsageLimitExceeded",
  "HttpConnectionFailed",
  "ResponseStreamConnectionFailed",
  "ResponseStreamDisconnected",
  "ResponseTooManyFailedAttempts",
  "InternalServerError",
]);
const RETRYABLE_MSG =
  /(Transport is not connected|app-server exited|timed out|ECONNRESET|EPIPE|socket hang up|stream (disconnected|connection)|killed by signal|exited with code)/i;
// Permanent, deterministic failures (checked BEFORE the retryable patterns):
// misconfigured models (`config.invalid: Model "..." is not configured`), bad
// flags, impossible flag combinations ("Cannot combine --prompt with --yolo"),
// and a `-S` resume of a session kimi no longer has (`Session "..." not found.`)
// fail identically on every attempt — retrying only burns backoff time.
const NONRETRYABLE_MSG =
  /(BadRequest|Unauthorized|ContextWindowExceeded|invalid request|outputSchema|did not return|config\.invalid|is not configured|unknown option|Cannot combine|Session ".*" not found)/i;

function errorCode(e) {
  const ci = e?.kimiErrorInfo;
  if (!ci) return null;
  return typeof ci === "string" ? ci : Object.keys(ci)[0] ?? null;
}

export function isRetryable(e) {
  if (e?.interrupted) return false; // a cancelled turn must stay cancelled
  const code = errorCode(e);
  if (code) return RETRYABLE_CODES.has(code);
  const msg = String(e?.message ?? "");
  if (NONRETRYABLE_MSG.test(msg)) return false;
  return RETRYABLE_MSG.test(msg); // unknown errors are NOT retried (conservative)
}

async function withRetry(fn, { retries, log, label }) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= retries || !isRetryable(e)) throw e;
      attempt++;
      const backoff = Math.min(30_000, 1000 * 2 ** (attempt - 1));
      const wait = backoff + Math.floor(Math.random() * 250);
      log(`  \u27f3 retry ${attempt}/${retries} (${label ?? 'agent'}): ${String(e?.message ?? e).slice(0, 140)} -- waiting ${wait}ms`);
      await sleep(wait);
    }
  }
}

// Tolerate a model that wraps JSON in prose or ```json fences despite the schema prompt.
function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {}
  }
  return null;
}
