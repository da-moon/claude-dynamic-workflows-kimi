// Long-lived Kimi worker sessions: the driver behind the workflow-facing
// `agent.start()` / `session.steer()` API (the orchestration, budget, concurrency,
// events and journaling live in runtime.js).
//
// Kimi CLI does not expose a lightweight persistent thread API like Codex's
// `thread/resume`. In v1 we implement sessions by keeping the conversation
// transcript and prepending it to each steer prompt. This is deterministic and
// journal-resumable: on `--resume` we replay the cached completed turns by
// rebuilding the transcript from the journal entries.

import { setTimeout as sleep } from "node:timers/promises";
import { kimiAgent, parseSchemaResult } from "./kimiAgent.js";
import { resolveModel } from "./modelMap.js";
import { loadAgentType } from "./agentTypes.js";
import { estimateTokens } from "./meter.js";

const DEFAULT_TURN_TIMEOUT_MS = 600_000;

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

  // Worktree isolation: created once, kept across every follow-up turn, removed
  // only by cleanup() (session.close / runtime finalization) -- never per-turn.
  let cwd = opts.cwd ?? process.cwd();
  let worktree;
  if (opts.isolation === "worktree") {
    const { isGitRepo, createWorktree } = await import("./worktree.js");
    if (await isGitRepo(cwd)) {
      worktree = await createWorktree(cwd);
      cwd = worktree.dir;
    } else {
      log(`isolation:'worktree' ignored -- ${cwd} is not a git repo`);
    }
  }

  const model = resolveModel(requestedModel, [], log);
  const driver = new KimiSessionDriver({ model, systemPrompt, cwd, worktree, log, runAgent });

  // Warm-context resume: a prior run journaled this worker's transcript. Rebuild
  // it so the next steer sees the previous turns. If no replay prefix exists the
  // driver starts with an empty transcript.
  if (opts.replayPrefix?.length) {
    for (const turn of opts.replayPrefix) {
      if (turn.prompt != null && turn.result != null) {
        driver._appendToTranscript(turn.prompt, turn.result);
      }
    }
    driver.resumed = true;
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
  constructor({ model, systemPrompt, cwd, worktree, log, runAgent = kimiAgent }) {
    this.model = model ?? null;
    this.systemPrompt = systemPrompt ?? null;
    this.cwd = cwd ?? process.cwd();
    this._worktree = worktree;
    this._log = typeof log === "function" ? log : () => {};
    this._runAgent = runAgent;
    this._active = false;
    this.resumed = false;
    this.threadId = `kimi-session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.currentTurnId = null;
    this._transcript = [];
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

    const startedAt = Date.now();
    const fullPrompt = this._buildPrompt(prompt, turnOpts.schema, turnOpts.effort);

    const completion = (async () => {
      try {
        const text = await this._runAgent(fullPrompt, {
          cwd: this.cwd,
          model: turnOpts.model ?? this.model,
          systemPrompt: null, // already baked into fullPrompt
          schema: turnOpts.schema,
          effort: turnOpts.effort,
          timeoutMs: turnOpts.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
          onProgress: turnOpts.onProgress,
          log: this._log,
          retries: 0, // turn-level retries are handled by the runtime wrapper
        });
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
        return {
          status: "failed",
          result: null,
          text: null,
          error: String(e?.message ?? e),
          model: this.model,
          tokens: estimateTokens(fullPrompt),
          ms: Date.now() - startedAt,
          turnId,
        };
      } finally {
        this._active = false;
      }
    })();

    return { turnId, completion };
  }

  _buildPrompt(prompt, schema, effort) {
    const parts = [];
    if (this.systemPrompt) parts.push(this.systemPrompt);
    if (this._transcript.length) {
      parts.push("Previous turns in this session:");
      for (const turn of this._transcript) {
        parts.push(`${turn.role === "user" ? "Q" : "A"}: ${turn.content}`);
      }
      parts.push("Now respond to the next turn.");
    }
    if (effort) parts.push(`(thinking effort: ${effort})`);
    parts.push(typeof prompt === "string" ? prompt : JSON.stringify(prompt));
    if (schema) {
      parts.push(
        "\n\nRespond with a single JSON object matching this schema (no extra prose, no markdown fences):\n" +
        JSON.stringify(schema, null, 2),
      );
    }
    return parts.join("\n\n");
  }

  // Interrupt the active turn. For a subprocess-based session this is best-effort
  // (the process is killed). The turn's completion promise resolves with status
  // "interrupted". No-op if nothing is running.
  async interruptCurrent() {
    if (this._active) {
      // The subprocess is not held on this driver, so we cannot directly kill it.
      // Mark that cancellation was requested; the completion will still resolve
      // normally but the runtime wrapper maps interrupted/failed as needed.
      this._log(`interrupt requested for ${this.threadId} (best-effort with subprocess sessions)`);
    }
  }

  // Remove the worktree (if any) -- kept across all turns, removed only here.
  async cleanup() {
    if (this._worktree) {
      try {
        const r = await this._worktree.cleanup();
        if (!r.removed) this._log(`worktree kept (modified): ${r.dir}`);
      } catch (e) {
        this._log(`worktree cleanup failed: ${e?.message ?? e}`);
      }
      this._worktree = undefined;
    }
  }
}
