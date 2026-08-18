import { getDb } from "./connection";
import { id, nowIso } from "../util/id";

export type RunStatus =
  | "planning"
  | "implementing"
  | "coordinating"
  | "reconciling"
  | "done"
  | "failed";

export type TaskStatus =
  | "pending"
  | "implementing"
  | "proposing"
  | "paused"
  | "reconciling"
  | "done"
  | "failed";

export interface RunRow {
  id: string;
  problem: string;
  status: RunStatus;
  planner_model: string | null;
  cost: number;
  supervisor_pid: number | null;
  created_at: string;
  updated_at: string;
}

export interface TaskRow {
  id: string;
  run_id: string;
  project_name: string;
  worktree_path: string | null;
  status: TaskStatus;
  model: string | null;
  runtime: string | null;
  resume_ref: string | null;
  cost: number;
  diff_ref: string | null;
  prompt: string | null;
  created_at: string;
  updated_at: string;
}

// ---- runs -----------------------------------------------------------------

export function createRun(input: { problem: string; plannerModel?: string | null }): RunRow {
  const runId = id("run");
  const now = nowIso();
  getDb()
    .prepare(
      `INSERT INTO runs (id, problem, status, planner_model, cost, supervisor_pid, created_at, updated_at)
       VALUES (?, ?, 'planning', ?, 0, NULL, ?, ?)`,
    )
    .run(runId, input.problem, input.plannerModel ?? null, now, now);
  return getRun(runId)!;
}

export function getRun(runId: string): RunRow | undefined {
  return getDb().prepare(`SELECT * FROM runs WHERE id = ?`).get(runId) as RunRow | undefined;
}

export function listRuns(): RunRow[] {
  return getDb().prepare(`SELECT * FROM runs ORDER BY created_at DESC`).all() as RunRow[];
}

export function setRunStatus(runId: string, status: RunStatus): void {
  getDb()
    .prepare(`UPDATE runs SET status = ?, updated_at = ? WHERE id = ?`)
    .run(status, nowIso(), runId);
}

export function setSupervisorPid(runId: string, pid: number | null): void {
  getDb()
    .prepare(`UPDATE runs SET supervisor_pid = ?, updated_at = ? WHERE id = ?`)
    .run(pid, nowIso(), runId);
}

// ---- tasks ----------------------------------------------------------------

export function createTask(input: {
  runId: string;
  projectName: string;
  model?: string | null;
  runtime?: string | null;
  worktreePath?: string | null;
  prompt?: string | null;
}): TaskRow {
  const taskId = id("task");
  const now = nowIso();
  getDb()
    .prepare(
      `INSERT INTO tasks (id, run_id, project_name, worktree_path, status, model, runtime, resume_ref, cost, diff_ref, prompt, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, NULL, 0, NULL, ?, ?, ?)`,
    )
    .run(
      taskId,
      input.runId,
      input.projectName,
      input.worktreePath ?? null,
      input.model ?? null,
      input.runtime ?? null,
      input.prompt ?? null,
      now,
      now,
    );
  return getTask(taskId)!;
}

export function getTask(taskId: string): TaskRow | undefined {
  return getDb().prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as TaskRow | undefined;
}

export function listTasks(runId?: string): TaskRow[] {
  const db = getDb();
  return runId
    ? (db.prepare(`SELECT * FROM tasks WHERE run_id = ? ORDER BY created_at`).all(runId) as TaskRow[])
    : (db.prepare(`SELECT * FROM tasks ORDER BY created_at DESC`).all() as TaskRow[]);
}

export function setTaskStatus(taskId: string, status: TaskStatus): void {
  getDb()
    .prepare(`UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?`)
    .run(status, nowIso(), taskId);
}

// ---- shared context (versioned) -------------------------------------------

export interface SharedContextRow {
  run_id: string;
  version: number;
  content: string;
  authored_by: string;
  created_at: string;
}

/** Returns the latest shared-context version for a run, if any. */
export function getSharedContext(runId: string): SharedContextRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM shared_context WHERE run_id = ? ORDER BY version DESC LIMIT 1`)
    .get(runId) as SharedContextRow | undefined;
}

/** Appends the next version of the shared context; returns the new version number. */
export function putSharedContext(runId: string, content: string, authoredBy: string): number {
  const current = getSharedContext(runId);
  const version = (current?.version ?? 0) + 1;
  getDb()
    .prepare(
      `INSERT INTO shared_context (run_id, version, content, authored_by, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(runId, version, content, authoredBy, nowIso());
  return version;
}

// ---- amendments -----------------------------------------------------------

export type AmendmentStatus = "proposed" | "accepted" | "rejected";

export interface AmendmentRow {
  id: string;
  run_id: string;
  proposed_by: string;
  proposal: string;
  status: AmendmentStatus;
  resolution: string | null;
  created_at: string;
  resolved_at: string | null;
}

export function createAmendment(input: { runId: string; taskId: string; proposal: string }): AmendmentRow {
  const amendmentId = id("amend");
  getDb()
    .prepare(
      `INSERT INTO amendments (id, run_id, proposed_by, proposal, status, resolution, created_at, resolved_at)
       VALUES (?, ?, ?, ?, 'proposed', NULL, ?, NULL)`,
    )
    .run(amendmentId, input.runId, input.taskId, input.proposal, nowIso());
  return getDb().prepare(`SELECT * FROM amendments WHERE id = ?`).get(amendmentId) as AmendmentRow;
}

export function listAmendments(runId: string): AmendmentRow[] {
  return getDb()
    .prepare(`SELECT * FROM amendments WHERE run_id = ? ORDER BY created_at`)
    .all(runId) as AmendmentRow[];
}

export function resolveAmendment(id: string, status: AmendmentStatus, resolution: string): void {
  getDb()
    .prepare(`UPDATE amendments SET status = ?, resolution = ?, resolved_at = ? WHERE id = ?`)
    .run(status, resolution, nowIso(), id);
}

export function setResumeRef(taskId: string, ref: string): void {
  getDb()
    .prepare(`UPDATE tasks SET resume_ref = ?, updated_at = ? WHERE id = ?`)
    .run(ref, nowIso(), taskId);
}

export function setTaskCost(taskId: string, cost: number): void {
  getDb()
    .prepare(`UPDATE tasks SET cost = ?, updated_at = ? WHERE id = ?`)
    .run(cost, nowIso(), taskId);
}

export function setRunCost(runId: string, cost: number): void {
  getDb()
    .prepare(`UPDATE runs SET cost = ?, updated_at = ? WHERE id = ?`)
    .run(cost, nowIso(), runId);
}
