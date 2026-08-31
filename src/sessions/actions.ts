import { rmSync } from "node:fs";
import type { TackConfig } from "../config/schema";
import {
  deleteSession as deleteSessionRow,
  listRunsBySession,
  listTasks,
  setRunStatus,
  setSessionStatus,
  setSupervisorPid,
  type RunRow,
} from "../db";
import { runLogDir } from "../logging/logs";
import { isAlive } from "../process/spawn";
import { purgeRunWorktrees } from "../worktree/worktree";

/**
 * The destructive session/run operations, extracted from the CLI command bodies
 * so the `stable` dashboard and `tack session|run …` commands share one source
 * of truth. Everything here is UI-agnostic: it mutates DB rows / disk and
 * returns a small result, leaving the console output (or TUI refresh) to callers.
 */

/**
 * SIGTERMs the live supervisor of every run the session dispatched, clearing
 * each stopped run's recorded pid. Returns how many supervisors were signalled.
 * Terminal/already-dead runs are left untouched.
 */
export function stopSessionRuns(sessionId: string): number {
  let stopped = 0;
  for (const r of listRunsBySession(sessionId)) {
    if (!isAlive(r.supervisor_pid)) continue;
    try {
      process.kill(r.supervisor_pid!, "SIGTERM");
      setSupervisorPid(r.id, null);
      stopped++;
    } catch {
      // Already gone between the liveness check and the signal — nothing to do.
    }
  }
  return stopped;
}

/**
 * Kill a session: stop its live run supervisors and mark it closed. Keeps all of
 * its data (runs, tasks, logs, worktrees) — reopening reactivates it. Returns how
 * many run supervisors were signalled.
 */
export function killSession(sessionId: string): { stopped: number } {
  const stopped = stopSessionRuns(sessionId);
  setSessionStatus(sessionId, "closed");
  return { stopped };
}

/**
 * Permanently delete a session: stop its runs, purge each run's git worktrees +
 * branches and logs, then erase every DB row (runs cascade to tasks/context/
 * amendments; the session cascades to its messages).
 *
 * `config` supplies the project name→repo path map so worktree branches can be
 * pruned from the right repos; omitting it (or passing one that no longer lists a
 * project) just falls back to the directory-level worktree sweep. Returns how
 * many supervisors were stopped and how many runs were removed.
 */
export function deleteSession(
  sessionId: string,
  config?: TackConfig,
): { stopped: number; runs: number } {
  // 1. Stop anything still running so we don't delete rows out from under a live
  //    supervisor (which would keep writing to a now-orphaned run).
  const stopped = stopSessionRuns(sessionId);

  // 2. Best-effort disk cleanup per run: git worktrees + branches, then logs.
  const projectRepos = new Map<string, string>(
    config ? config.projects.map((p) => [p.name, p.path]) : [],
  );
  const runs = listRunsBySession(sessionId);
  for (const r of runs) {
    const projects = [...new Set(listTasks(r.id).map((t) => t.project_name))]
      .filter((name) => projectRepos.has(name))
      .map((name) => ({ name, repo: projectRepos.get(name)! }));
    purgeRunWorktrees(r.id, projects);
    rmSync(runLogDir(r.id), { recursive: true, force: true });
  }

  // 3. Erase every DB row.
  deleteSessionRow(sessionId);

  return { stopped, runs: runs.length };
}

/**
 * Outcome of {@link stopRun}:
 * - `"stopped"`  — a live supervisor was SIGTERM'd (it will mark the run terminal);
 * - `"cleared"`  — a stalled run (non-terminal but its supervisor is dead) was
 *                  forced to a terminal `failed` state so it stops reading as live;
 * - `"not-running"` — a no-op: the run is already terminal (done/failed).
 */
export type StopRunResult = "stopped" | "cleared" | "not-running";

/**
 * Stop a single non-terminal run. If its supervisor is alive, SIGTERM it and
 * clear the recorded pid (the supervisor then marks the run terminal itself).
 * If the run is stalled — non-terminal yet its supervisor is already dead — it
 * will never reach a terminal state on its own, so mark it `failed` and clear
 * the stale pid. A run that is already terminal is left untouched.
 */
export function stopRun(run: RunRow): StopRunResult {
  if (run.status === "done" || run.status === "failed") return "not-running";
  if (isAlive(run.supervisor_pid)) {
    try {
      process.kill(run.supervisor_pid!, "SIGTERM");
      setSupervisorPid(run.id, null);
      return "stopped";
    } catch {
      // Raced: the supervisor exited between the liveness check and the signal.
      // Fall through and settle it as a stalled run.
    }
  }
  setRunStatus(run.id, "failed");
  setSupervisorPid(run.id, null);
  return "cleared";
}
