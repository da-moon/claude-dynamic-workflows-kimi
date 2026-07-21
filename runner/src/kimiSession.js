// Long-lived Kimi worker sessions: the driver behind the workflow-facing
// `agent.start()` / `session.steer()` API (the orchestration, budget, concurrency,
// events and journaling live in runtime.js).
//
// Sessions ride kimi's REAL persisted sessions (verified on kimi 0.23.3): every
// `kimi -p` run ends with a `session.resume_hint` meta line carrying a stable
// `session_<uuid>` id, and `kimi -S <id> -p` resumes that session non-interactively
// with FULL context (tool calls included). The driver captures the id on the first
// turn and passes `-S <id>` on every follow-up turn — prompts are never re-sent.
//
// The conversation transcript is still kept in memory, but ONLY as (a) the
// journal-replay identity for `--resume` and (b) a context-rebuild fallback when
// no resumable kimi session exists (a fake runAgent in tests, or a journaled
// session kimi has since deleted): in that case one turn prepends the transcript
// to re-establish context, then the freshly captured session id takes over.

import { setTimeout as sleep } from "node:timers/promises";
import { kimiAgent, parseSchemaResult, strictifySchema, assertSandboxValue, READ_ONLY_PREAMBLE } from "./kimiAgent.js";
import { resolveModel, isK3 } from "./modelMap.js";
import { loadAgentType } from "./agentTypes.js";
import { estimateTokens } from "./meter.js";

const DEFAULT_TURN_TIMEOUT_MS = 600_000;

// Shape of the persisted-session ids kimi emits in `session.resume_hint` (the
// only ids `-S` accepts). Old journals recorded synthetic `kimi-session-*` ids,
// which kimi rejects — those must never be passed to `-S`.
const KIMI_SESSION_ID_RE = /^session_[0-9a-fA-F-]+$/;

/**
 * Open a Kimi session for a long-lived worker. Resolves the agentType/system
 * prompt, the model, and (if requested) a git worktree ONCE -- all of which are
 * thread-level and persist across follow-up turns.
 *
 * Returns a KimiSessionDriver: a thin handle that can begin turns, interrupt the
 * active turn, and clean up. It does NOT touch the concurrency semaphore,
 * budget, events, or journal -- runtime.js wraps it with all of that.
 */
export async function startKimiSession(opts = {}) {
  const log = typeof opts.log === "function" ? opts.log : () => {};
  const runAgent = opts.runAgent ?? kimiAgent;
  // agentType -> developer instructions (+ optional fallback model), same as agent().
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

  // pinnedModel is authoritative (forces every agent onto one model), same as agent().
  const requestedModel = opts.pinnedModel ?? opts.model ?? agentTypeModel ?? opts.defaultModel;

  // Sandbox policy — same contract as agent(): validated up front, and a
  // read-only request that can't be mechanically honored is REFUSED at start
  // (never silently downgraded to an advisory label). Enforcement is
  // session-level: the worktree cwd persists across every follow-up turn, and
  // the read-only preamble rides the thread's system prompt (established on the
  // first turn; persisted-session context carries it into -S resumes).
  assertSandboxValue(opts.sandbox);
  const readOnly = opts.sandbox === "read-only";
  if (readOnly) {
    systemPrompt = systemPrompt ? `${READ_ONLY_PREAMBLE}\n\n${systemPrompt}` : READ_ONLY_PREAMBLE;
  }

  // Worktree isolation: created once, kept across every follow-up turn, removed
  // only by cleanup() (session.close / runtime finalization) -- never per-turn.
  // sandbox:'read-only' forces it (the enforcement mechanism of record).
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

  const model = resolveModel(requestedModel, [], log);
  const driver = new KimiSessionDriver({ model, systemPrompt, cwd, worktree, log, runAgent, sandboxEnforced: readOnly });

  // Warm-context resume (--resume): a prior run journaled this worker's turns.
  // Preferred path: the journal recorded a REAL kimi session id (resumeThreadId)
  // — re-attach with `-S <id>`; kimi holds the full context (tool calls included).
  // Fallback path: rebuild the transcript from the journaled prompts/results so
  // the first live turn can re-establish context by prepending it. Both paths
  // need the transcript rebuilt (it also backs the -S "session not found"
  // fallback), so replay it whenever the journal recorded the prompts.
  const rebuildable =
    opts.replayPrefix?.length &&
    opts.replayPrefix.every((t) => t.prompt != null && t.result != null);
  if (rebuildable) {
    for (const turn of opts.replayPrefix) {
      driver._appendToTranscript(turn.prompt, turn.result);
    }
    driver.resumed = true;
  }
  if (opts.resumeThreadId && KIMI_SESSION_ID_RE.test(opts.resumeThreadId)) {
    driver.kimiSessionId = opts.resumeThreadId;
    driver.threadId = opts.resumeThreadId;
    driver.resumed = true;
  } else if (opts.replayPrefix?.length && !rebuildable) {
    // Old-scheme journal (promptHash only, synthetic thread id): neither a real
    // -S resume nor a transcript rebuild is possible. Clean invalidation — the
    // runtime sees resumed:false and re-runs every turn live.
    log(
      "session resume: journal has no kimi session id and predates prompt recording — re-running turns live",
    );
  }

  return driver;
}

// Protocol-only session handle. One active turn at a time (enforced by the runtime
// wrapper; defended here too). Every turn's completion promise ALWAYS resolves --
// never rejects -- to a TurnOutcome, so the wrapper can race many of them cleanly.
//
//   TurnOutcome = {
//     status: "completed" | "interrupted" | "failed",
//     result, text, error, model, tokens, ms, turnId
//   }
export class KimiSessionDriver {
  constructor({ model, systemPrompt, cwd, worktree, log, runAgent = kimiAgent, sandboxEnforced = false }) {
    this.model = model ?? null;
    this.systemPrompt = systemPrompt ?? null;
    this.cwd = cwd ?? process.cwd();
    this._worktree = worktree;
    this.sandboxEnforced = !!sandboxEnforced; // read-only worktree containment active for this session
    this._log = typeof log === "function" ? log : () => {};
    this._runAgent = runAgent;
    this._active = false;
    this.resumed = false;
    // Placeholder until the first turn's `session.resume_hint` reveals the real
    // persisted-session id; then threadId/kimiSessionId become that id and every
    // follow-up turn resumes it with `-S` (no transcript re-send).
    this.threadId = `kimi-session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.kimiSessionId = null;
    this.currentTurnId = null;
    this._transcript = [];
    this._turnAbort = null; // AbortController for the active turn (the kill handle)
  }

  _appendToTranscript(prompt, result) {
    this._transcript.push({ role: "user", content: typeof prompt === "string" ? prompt : JSON.stringify(prompt) });
    this._transcript.push({ role: "assistant", content: typeof result === "string" ? result : JSON.stringify(result) });
  }

  // Start a turn on the session. Returns { turnId, completion } once the turn has
  // STARTED (so the caller can return a handle without waiting). `completion`
  // settles when the turn ends. Throws only if the turn could not be started.
  async beginTurn(prompt, turnOpts = {}) {
    if (this._active) throw new Error("internal: beginTurn called while a turn is active");
    const turnId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this._active = true;
    this.currentTurnId = turnId;
    const controller = new AbortController();
    this._turnAbort = controller;

    const startedAt = Date.now();
    let fullPrompt = this._buildPrompt(prompt, turnOpts.schema, turnOpts.effort, {
      // With a resumable kimi session the context lives server-side in the
      // persisted session — send ONLY the new turn (no system prompt re-send,
      // no transcript prepend). Otherwise (first turn, or no session id yet)
      // send system prompt + transcript to establish/rebuild context.
      bare: !!this.kimiSessionId,
    });

    const runOnce = (resumeSessionId) =>
      this._runAgent(fullPrompt, {
        cwd: this.cwd,
        model: turnOpts.model ?? this.model,
        // systemPrompt/schema/effort are already baked into fullPrompt by
        // _buildPrompt — do NOT pass them down, or kimiAgent would embed the
        // schema/effort a second time AND parse the schema result itself
        // (returning an object this driver's parseSchemaResult would choke on).
        // The driver owns prompt construction and result parsing for its turns.
        systemPrompt: null,
        timeoutMs: turnOpts.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
        onProgress: turnOpts.onProgress,
        log: this._log,
        retries: 0, // turn-level retries are handled by the runtime wrapper
        resumeSessionId: resumeSessionId ?? undefined,
        signal: controller.signal,
        onSessionId: (sid) => {
          if (typeof sid === "string" && KIMI_SESSION_ID_RE.test(sid)) {
            this.kimiSessionId = sid;
            this.threadId = sid; // journaled per turn — the --resume re-attach key
          }
        },
      });

    const completion = (async () => {
      try {
        let text;
        try {
          text = await runOnce(this.kimiSessionId);
        } catch (e) {
          // A journaled session id kimi no longer has (`Session "..." not found.`):
          // fall back ONCE to a fresh session, rebuilding context by prepending
          // the transcript. The fresh run's resume_hint re-arms -S for later turns.
          const notFound = /Session ".*" not found/i.test(String(e?.message ?? ""));
          if (!this.kimiSessionId || !notFound || controller.signal.aborted) throw e;
          this._log(`kimi session ${this.kimiSessionId} not found — rebuilding context from the transcript`);
          this.kimiSessionId = null;
          fullPrompt = this._buildPrompt(prompt, turnOpts.schema, turnOpts.effort, { bare: false });
          text = await runOnce(null);
        }
        const result = turnOpts.schema ? parseSchemaResult(text, turnOpts.schema) : text;
        this._appendToTranscript(prompt, result);
        const tokens = estimateTokens(fullPrompt) + estimateTokens(text);
        return {
          status: "completed",
          result,
          text,
          error: null,
          model: this.model,
          tokens,
          ms: Date.now() - startedAt,
          turnId,
        };
      } catch (e) {
        const interrupted = e?.interrupted || controller.signal.aborted;
        return {
          status: interrupted ? "interrupted" : "failed",
          result: null,
          text: null,
          error: interrupted ? null : String(e?.message ?? e),
          model: this.model,
          tokens: estimateTokens(fullPrompt),
          ms: Date.now() - startedAt,
          turnId,
        };
      } finally {
        this._active = false;
        if (this._turnAbort === controller) this._turnAbort = null;
      }
    })();

    return { turnId, completion };
  }

  _buildPrompt(prompt, schema, effort, { bare = false } = {}) {
    const parts = [];
    if (!bare) {
      if (this.systemPrompt) parts.push(this.systemPrompt);
      if (this._transcript.length) {
        parts.push("Previous turns in this session:");
        for (const turn of this._transcript) {
          parts.push(`${turn.role === "user" ? "Q" : "A"}: ${turn.content}`);
        }
        parts.push("Now respond to the next turn.");
      }
    }
    // k3 is max-only (automatic reasoning effort, no --effort knob): suppress the
    // "(thinking effort: X)" hint for it, exactly as kimiAgent.buildFullPrompt does.
    if (effort && !isK3(this.model)) parts.push(`(thinking effort: ${effort})`);
    parts.push(typeof prompt === "string" ? prompt : JSON.stringify(prompt));
    if (schema) {
      // Same strict normalization as one-shot agent() turns (kimiAgent.buildFullPrompt),
      // so a session turn's schema prompt is byte-for-byte the same contract.
      parts.push(
        "\n\nRespond with a single JSON object matching this schema (no extra prose, no markdown fences):\n" +
        JSON.stringify(strictifySchema(schema), null, 2),
      );
    }
    return parts.join("\n\n");
  }

  // Interrupt the active turn: abort the turn's controller, which SIGTERMs the
  // live kimi subprocess. The turn's completion promise resolves with status
  // "interrupted" (the runtime maps it to "cancelled" when the workflow asked).
  // No-op if nothing is running.
  async interruptCurrent() {
    if (this._active && this._turnAbort) {
      this._log(`interrupting active turn on ${this.threadId}`);
      this._turnAbort.abort();
    }
  }

  // Remove the worktree (if any) -- kept across all turns, removed only here.
  // An enforced read-only session DISCARDS stray writes (that's the containment
  // contract); an isolation:'worktree' session keeps a dirty worktree as before.
  async cleanup() {
    if (this._worktree) {
      try {
        const r = await this._worktree.cleanup({ discard: this.sandboxEnforced });
        if (this.sandboxEnforced && r.dirty) {
          const shown = (r.changes ?? []).slice(0, 8).join(", ");
          this._log(`  ⊘ sandbox read-only: session wrote inside its isolated worktree — changes DISCARDED (${shown}${(r.changes?.length ?? 0) > 8 ? ", …" : ""})`);
        } else if (!r.removed) {
          this._log(`worktree kept (modified): ${r.dir}`);
        }
      } catch (e) {
        this._log(`worktree cleanup failed: ${e?.message ?? e}`);
      }
      this._worktree = undefined;
    }
  }
}
