// Worktree isolation for agent() calls that mutate files in parallel — the
// equivalent of the native runtime's `isolation:'worktree'`. We create a
// detached git worktree at HEAD and run the `kimi -p` prompt with its cwd pointed
// there. On completion the worktree is removed *only if unchanged* (mirrors
// "auto-cleaned if unchanged"); if the agent left changes, the worktree is kept
// and its path reported so the work isn't silently discarded.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exec = promisify(execFile);

async function git(cwd, args) {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

export async function isGitRepo(cwd) {
  try {
    return (await git(cwd, ["rev-parse", "--is-inside-work-tree"])) === "true";
  } catch {
    return false;
  }
}

// Whether the repo containing `cwd` has a commit at HEAD. A freshly-`git init`ed
// repo has an unborn HEAD, so `worktree add --detach … HEAD` fails — callers that
// need worktree isolation (enforced read-only) can probe this up front and refuse
// fast instead of failing on the first agent call.
export async function hasHeadCommit(cwd) {
  try {
    await git(cwd, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a detached worktree at HEAD of the repo containing `repoCwd`.
 * Returns { dir, cleanup }, where cleanup({ discard }) removes the worktree and
 * returns { removed, dir, dirty, changes }.
 *
 * Default (`isolation:'worktree'` semantics): a DIRTY worktree is kept and its
 * path reported, so an agent's work isn't silently thrown away.
 * `discard:true` (enforced `sandbox:'read-only'` semantics): a dirty worktree is
 * removed anyway — stray writes from a read-only agent are contained and
 * dropped — with the touched paths returned in `changes` for reporting.
 */
export async function createWorktree(repoCwd) {
  const root = await git(repoCwd, ["rev-parse", "--show-toplevel"]);
  const base = await mkdtemp(join(tmpdir(), "wf-worktree-"));
  const dir = join(base, "wt");
  await git(root, ["worktree", "add", "--detach", dir, "HEAD"]);

  return {
    dir,
    async cleanup({ discard = false } = {}) {
      let dirty = false;
      let changes = [];
      try {
        const porcelain = await git(dir, ["status", "--porcelain"]);
        dirty = porcelain.length > 0;
        if (dirty) changes = porcelain.split("\n").map((l) => l.slice(3)).filter(Boolean);
      } catch {}
      if (dirty && !discard) return { removed: false, dirty: true, dir, changes };
      try {
        await git(root, ["worktree", "remove", "--force", dir]);
      } catch {}
      try {
        await rm(base, { recursive: true, force: true });
      } catch {}
      return { removed: true, dirty, dir, changes };
    },
  };
}
