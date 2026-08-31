import { spawnSync } from "node:child_process";
import type { TackConfig } from "../config/schema";
import {
  listRunsBySession,
  listSessionPrs,
  listTasks,
  upsertSessionPr,
  type SessionPrRow,
} from "../db";
import { sessionIdFromPrBranch } from "../worktree/worktree";

/** One PR as reported by `gh pr list --json`. */
interface GhPr {
  number: number;
  url: string;
  title: string;
  state: string; // OPEN | MERGED | CLOSED
  headRefName: string;
}

export interface DiscoverResult {
  prs: SessionPrRow[];
  /** Project repos we couldn't query (no `gh`, not a GitHub remote, etc.). */
  skipped: Array<{ project: string; reason: string }>;
  ghMissing: boolean;
}

/** Is the `gh` CLI available on PATH? */
function ghAvailable(): boolean {
  const r = spawnSync("gh", ["--version"], { encoding: "utf8" });
  return r.status === 0;
}

/** Lists PRs in a repo via `gh`, or throws with a short reason on failure. */
function ghPrList(repoPath: string): GhPr[] {
  const r = spawnSync(
    "gh",
    ["pr", "list", "--state", "all", "--limit", "200", "--json", "number,url,title,state,headRefName"],
    { cwd: repoPath, encoding: "utf8" },
  );
  if (r.status !== 0) {
    throw new Error((r.stderr || r.stdout || "gh pr list failed").trim().split("\n")[0]);
  }
  try {
    return JSON.parse(r.stdout || "[]") as GhPr[];
  } catch {
    return [];
  }
}

/**
 * Discovers the PRs a session produced by scanning the GitHub repos it touched
 * for branches following our `tack/pr/<sessionId>/…` nomenclature (see
 * `sessionPrBranch`), then records each in `session_prs`. Best-effort: repos
 * without `gh`/a GitHub remote are reported in `skipped`, not fatal. Returns the
 * session's PRs (freshly refreshed) plus what was skipped.
 */
export function discoverSessionPrs(config: TackConfig, sessionId: string): DiscoverResult {
  const skipped: DiscoverResult["skipped"] = [];

  if (!ghAvailable()) {
    return { prs: listSessionPrs(sessionId), skipped, ghMissing: true };
  }

  // Which config projects did this session touch, and via which run? A project
  // may appear in several runs — keep the most recent (runs come newest-first).
  const runIdByProject = new Map<string, string>();
  for (const run of listRunsBySession(sessionId)) {
    for (const task of listTasks(run.id)) {
      if (!runIdByProject.has(task.project_name)) runIdByProject.set(task.project_name, run.id);
    }
  }

  for (const [projectName, runId] of runIdByProject) {
    const project = config.projects.find((p) => p.name === projectName);
    if (!project) {
      skipped.push({ project: projectName, reason: "no longer in config" });
      continue;
    }
    let prs: GhPr[];
    try {
      prs = ghPrList(project.path);
    } catch (err) {
      skipped.push({ project: projectName, reason: (err as Error).message });
      continue;
    }
    for (const pr of prs) {
      if (sessionIdFromPrBranch(pr.headRefName) !== sessionId) continue;
      upsertSessionPr({
        sessionId,
        url: pr.url,
        runId,
        projectName,
        number: pr.number,
        title: pr.title,
        state: pr.state.toLowerCase(),
        headBranch: pr.headRefName,
      });
    }
  }

  return { prs: listSessionPrs(sessionId), skipped, ghMissing: false };
}
