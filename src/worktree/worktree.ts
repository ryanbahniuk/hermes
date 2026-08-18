import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { HERMES_HOME } from "../paths";

export interface Worktree {
  repo: string;
  path: string;
  branch: string;
}

function git(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim()}`);
  }
  return (r.stdout ?? "").trim();
}

export function worktreesRoot(runId: string): string {
  return join(HERMES_HOME, "worktrees", runId);
}

/**
 * Guards against a misconfigured project path: `git` commands walk up to any
 * ancestor repo, so we require the path to BE a git repository root.
 */
function assertRepoRoot(repo: string): void {
  const top = git(["rev-parse", "--show-toplevel"], repo); // throws if not a repo
  if (realpathSync(top) !== realpathSync(repo)) {
    throw new Error(`project path is not a git repository root: ${repo} (nearest repo root is ${top})`);
  }
}

/** Creates a fresh git worktree on a new `hermes/<run>/<project>` branch off HEAD. */
export function createWorktree(repo: string, runId: string, projectName: string): Worktree {
  assertRepoRoot(repo);
  const root = worktreesRoot(runId);
  mkdirSync(root, { recursive: true });
  const path = join(root, projectName);
  const branch = `hermes/${runId}/${projectName}`;
  git(["worktree", "add", "-b", branch, path, "HEAD"], repo);
  return { repo, path, branch };
}

/** Reuses an existing worktree at the expected path, else creates one (resume-safe). */
export function ensureWorktree(repo: string, runId: string, projectName: string): Worktree {
  const path = join(worktreesRoot(runId), projectName);
  if (existsSync(path)) {
    return { repo, path, branch: `hermes/${runId}/${projectName}` };
  }
  return createWorktree(repo, runId, projectName);
}

export function removeWorktree(wt: Worktree): void {
  git(["worktree", "remove", wt.path, "--force"], wt.repo);
}
