import { rmSync } from "node:fs";
import type { TackConfig } from "../config/schema";
import {
  clearSessionLiveness,
  deleteSession as deleteSessionRow,
  getSession,
  listRunsBySession,
  listTasks,
  setRunStatus,
  setSessionStatus,
  setSupervisorPid,
  type RunRow,
  type SessionStatus,
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
 * A run is TERMINAL when its *stored* status is done/failed/stopped — it's
 * finished and nothing is (or should be) still writing to it. This is the
 * stored-status test, deliberately NOT liveness: a "stalled" run (non-terminal
 * status but a dead supervisor) is NOT terminal, so it still blocks archiving
 * until it's explicitly stopped. Mirrors the terminal check in {@link stopRun}
 * and `runLive` — the single vocabulary of "done with this run".
 */
export function isRunTerminal(run: RunRow): boolean {
  return run.status === "done" || run.status === "failed" || run.status === "stopped";
}

/** True when every run in the list is terminal (vacuously true for none). */
export function allRunsTerminal(runs: RunRow[]): boolean {
  return runs.every(isRunTerminal);
}

/**
 * Whether a session may be archived: every run it dispatched is terminal. Shared
 * by {@link archiveSession}'s gate and the UI's offered affordance so the two can
 * never diverge on when archive is allowed. A session with no runs is archivable.
 */
export function sessionArchivable(sessionId: string): boolean {
  return allRunsTerminal(listRunsBySession(sessionId));
}

/**
 * Archive a session: a soft, reversible state that hides it from the default
 * listings while keeping ALL of its DB records (unlike {@link deleteSession},
 * which purges rows + worktrees + logs). Archiving does NOT clean up runs/
 * worktrees/logs — its precondition is that they're already done, so we gate on
 * every run being terminal and refuse (naming the offenders) otherwise. A live
 * "active" session may still be archived — the gate is on runs, not liveness — and
 * moves straight to "archived". Returns the id and the status it superseded.
 */
export function archiveSession(sessionId: string): { id: string; priorStatus: SessionStatus } {
  const s = getSession(sessionId);
  if (!s) throw new Error(`No such session: ${sessionId}`);
  if (s.status === "archived") throw new Error(`Session ${sessionId} is already archived.`);

  const offenders = listRunsBySession(sessionId).filter((r) => !isRunTerminal(r));
  if (offenders.length > 0) {
    const list = offenders.map((r) => `${r.id} (${r.status})`).join(", ");
    throw new Error(
      `Cannot archive session ${sessionId}: ${offenders.length} run${offenders.length === 1 ? " is" : "s are"} ` +
        `still active — ${list}. Stop or finish them first (e.g. \`tack run stop <id>\`).`,
    );
  }

  setSessionStatus(sessionId, "archived");
  return { id: sessionId, priorStatus: s.status };
}

/**
 * Restore an archived session, flipping it back to "active" (recoverable, since
 * archiving kept every record). This restores the stored status only; whether it
 * reads live or "dead" is decided by liveness (pid + heartbeat), and with no live
 * process attached a just-unarchived session reads "dead" until reopened. Throws
 * if the session isn't currently archived — there's nothing to restore. Reopening
 * an archived session by id also reactivates it (see PlannerSession.goLive), so
 * this is for restoring without opening.
 */
export function unarchiveSession(sessionId: string): { id: string; priorStatus: SessionStatus } {
  const s = getSession(sessionId);
  if (!s) throw new Error(`No such session: ${sessionId}`);
  if (s.status !== "archived") {
    throw new Error(`Session ${sessionId} is not archived (status: ${s.status}).`);
  }
  setSessionStatus(sessionId, "active");
  return { id: sessionId, priorStatus: s.status };
}

/**
 * Stops every run the session dispatched via the shared {@link stopRun} logic:
 * live supervisors are SIGTERM'd and their runs settled as `stopped`; stalled
 * (non-terminal, dead-supervisor) runs are likewise marked `stopped`; already-
 * terminal runs are left untouched. Returns how many live supervisors were
 * signalled.
 */
export function stopSessionRuns(sessionId: string): number {
  let stopped = 0;
  for (const r of listRunsBySession(sessionId)) {
    if (stopRun(r) === "stopped") stopped++;
  }
  return stopped;
}

/**
 * Kill a session: stop its live run supervisors, then clear the session's own
 * liveness markers (pid + heartbeat) so `sessionLive` reads "dead" immediately —
 * even if the interactive process is still alive, which is the point of a kill.
 * The status stays "active"; liveness alone distinguishes live from dead. Keeps
 * all of its data (runs, tasks, logs, worktrees) — reopening reactivates it.
 * Returns how many run supervisors were signalled.
 */
export function killSession(sessionId: string): { stopped: number } {
  const stopped = stopSessionRuns(sessionId);
  clearSessionLiveness(sessionId);
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
 * - `"stopped"`  — a live supervisor was SIGTERM'd and the run settled `stopped`;
 * - `"cleared"`  — a stalled run (non-terminal but its supervisor is dead) was
 *                  forced to a terminal `stopped` state so it stops reading as live;
 * - `"not-running"` — a no-op: the run is already terminal (done/failed/stopped).
 */
export type StopRunResult = "stopped" | "cleared" | "not-running";

/**
 * Stop a single non-terminal run as a deliberate, user-initiated stop — so it
 * settles `stopped`, never `failed` (which stays reserved for genuine crashes).
 *
 * We record the `stopped` status *before* clearing the pid so the run is already
 * terminal by the time the SIGTERM lands: the supervisor's own terminal writes
 * respect an existing `stopped` status and won't clobber it back to `failed`
 * (see {@link settleTerminalStatus} in the supervisor). If the supervisor is
 * alive we SIGTERM it; if the run is stalled — non-terminal yet its supervisor
 * is already dead — it would never reach a terminal state on its own, so we
 * settle it here. A run that is already terminal is left untouched.
 */
export function stopRun(run: RunRow): StopRunResult {
  if (run.status === "done" || run.status === "failed" || run.status === "stopped") {
    return "not-running";
  }
  if (isAlive(run.supervisor_pid)) {
    try {
      process.kill(run.supervisor_pid!, "SIGTERM");
      setRunStatus(run.id, "stopped");
      setSupervisorPid(run.id, null);
      return "stopped";
    } catch {
      // Raced: the supervisor exited between the liveness check and the signal.
      // Fall through and settle it as a stalled run.
    }
  }
  setRunStatus(run.id, "stopped");
  setSupervisorPid(run.id, null);
  return "cleared";
}
