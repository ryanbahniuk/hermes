import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { TACK_HOME } from "../paths";

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
  return join(TACK_HOME, "worktrees", runId);
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

/** Creates a fresh git worktree on a new `tack/<run>/<project>` branch off HEAD. */
export function createWorktree(repo: string, runId: string, projectName: string): Worktree {
  assertRepoRoot(repo);
  const root = worktreesRoot(runId);
  mkdirSync(root, { recursive: true });
  const path = join(root, projectName);
  const branch = `tack/${runId}/${projectName}`;
  git(["worktree", "add", "-b", branch, path, "HEAD"], repo);
  return { repo, path, branch };
}

/** Reuses an existing worktree at the expected path, else creates one (resume-safe). */
export function ensureWorktree(repo: string, runId: string, projectName: string): Worktree {
  const path = join(worktreesRoot(runId), projectName);
  if (existsSync(path)) {
    return { repo, path, branch: `tack/${runId}/${projectName}` };
  }
  return createWorktree(repo, runId, projectName);
}

export function removeWorktree(wt: Worktree): void {
  git(["worktree", "remove", wt.path, "--force"], wt.repo);
}

/** Runs a git command, swallowing failure — for best-effort teardown. */
function tryGit(args: string[], cwd: string): void {
  spawnSync("git", args, { cwd, encoding: "utf8" });
}

/**
 * Best-effort teardown of everything a run's worktrees left behind: for each
 * project it touched, the git worktree and its `tack/<run>/<project>` branch,
 * then the run's whole worktrees directory. Normal task completion already
 * removes worktrees as it goes, so this only bites when a run was killed
 * mid-flight — every step tolerates already-gone pieces. `projects` supplies the
 * repo root for each project name (from config); projects no longer in config
 * are still swept from disk by the final directory removal.
 */
export function purgeRunWorktrees(
  runId: string,
  projects: Array<{ name: string; repo: string }>,
): void {
  const root = worktreesRoot(runId);
  for (const p of projects) {
    const path = join(root, p.name);
    const branch = `tack/${runId}/${p.name}`;
    if (existsSync(path)) tryGit(["worktree", "remove", path, "--force"], p.repo);
    tryGit(["worktree", "prune"], p.repo);
    tryGit(["branch", "-D", branch], p.repo);
  }
  rmSync(root, { recursive: true, force: true });
}
