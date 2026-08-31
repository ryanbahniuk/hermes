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

export type SessionStatus = "active" | "closed";

export interface RunRow {
  id: string;
  problem: string;
  status: RunStatus;
  planner_model: string | null;
  cost: number;
  supervisor_pid: number | null;
  session_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionRow {
  id: string;
  title: string | null;
  planner_model: string | null;
  runtime: string | null;
  resume_ref: string | null;
  status: SessionStatus;
  cost: number;
  created_at: string;
  updated_at: string;
}

export interface SessionMessageRow {
  id: string;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
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

export function createRun(input: {
  problem: string;
  plannerModel?: string | null;
  sessionId?: string | null;
}): RunRow {
  const runId = id("run");
  const now = nowIso();
  getDb()
    .prepare(
      `INSERT INTO runs (id, problem, status, planner_model, cost, supervisor_pid, session_id, created_at, updated_at)
       VALUES (?, ?, 'planning', ?, 0, NULL, ?, ?, ?)`,
    )
    .run(runId, input.problem, input.plannerModel ?? null, input.sessionId ?? null, now, now);
  return getRun(runId)!;
}

/** Runs dispatched by a given planning session, newest first. */
export function listRunsBySession(sessionId: string): RunRow[] {
  return getDb()
    .prepare(`SELECT * FROM runs WHERE session_id = ? ORDER BY created_at DESC`)
    .all(sessionId) as RunRow[];
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

/**
 * Deletes a run and everything that hangs off it — tasks, shared-context
 * versions, and amendments all cascade via their `ON DELETE CASCADE` foreign
 * keys. Does not touch worktrees/logs on disk (callers clean those up first).
 */
export function deleteRun(runId: string): void {
  getDb().prepare(`DELETE FROM runs WHERE id = ?`).run(runId);
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

// ---- planning sessions ----------------------------------------------------

export function createSession(input: {
  plannerModel?: string | null;
  runtime?: string | null;
  title?: string | null;
}): SessionRow {
  const sessionId = id("sess");
  const now = nowIso();
  getDb()
    .prepare(
      `INSERT INTO sessions (id, title, planner_model, runtime, resume_ref, status, cost, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, 'active', 0, ?, ?)`,
    )
    .run(sessionId, input.title ?? null, input.plannerModel ?? null, input.runtime ?? null, now, now);
  return getSession(sessionId)!;
}

export function getSession(sessionId: string): SessionRow | undefined {
  return getDb().prepare(`SELECT * FROM sessions WHERE id = ?`).get(sessionId) as
    | SessionRow
    | undefined;
}

export function listSessions(): SessionRow[] {
  return getDb().prepare(`SELECT * FROM sessions ORDER BY updated_at DESC`).all() as SessionRow[];
}

export function setSessionResumeRef(sessionId: string, ref: string): void {
  getDb()
    .prepare(`UPDATE sessions SET resume_ref = ?, updated_at = ? WHERE id = ?`)
    .run(ref, nowIso(), sessionId);
}

export function setSessionTitle(sessionId: string, title: string): void {
  getDb()
    .prepare(`UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?`)
    .run(title, nowIso(), sessionId);
}

export function setSessionStatus(sessionId: string, status: SessionStatus): void {
  getDb()
    .prepare(`UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?`)
    .run(status, nowIso(), sessionId);
}

/**
 * Adds `delta` USD to a session's *planner-conversation* cost (the `sessions.cost`
 * column). The cost of delegated work is tracked on tasks/runs and folded in at
 * read time by `sessionTotalCost` — not stored here, so background runs stay the
 * single source of truth for their own cost. Returns the new planner cost.
 */
export function addSessionCost(sessionId: string, delta: number): number {
  getDb()
    .prepare(`UPDATE sessions SET cost = cost + ?, updated_at = ? WHERE id = ?`)
    .run(delta, nowIso(), sessionId);
  return (getSession(sessionId)?.cost ?? 0) as number;
}

export interface SessionCost {
  /** Cost of the planning conversation itself (planner turns). */
  planner: number;
  /** Aggregate cost of every task across every run this session dispatched. */
  work: number;
  /** planner + work — the total spend attributable to the session. */
  total: number;
}

/**
 * The session's true cost: the planning conversation plus the aggregate cost of
 * all runs/tasks it spawned. Derived on read (summing leaf task costs) so it
 * always reflects what background workers have reported.
 */
export function sessionTotalCost(sessionId: string): SessionCost {
  const planner = getSession(sessionId)?.cost ?? 0;
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(t.cost), 0) AS c
         FROM tasks t JOIN runs r ON t.run_id = r.id
        WHERE r.session_id = ?`,
    )
    .get(sessionId) as { c: number };
  const work = row.c;
  return { planner, work, total: planner + work };
}

/**
 * Deletes a session and all of its data. `session_messages` cascade from the
 * session row, but `runs` only carry a plain `session_id` column (no foreign
 * key), so we delete them explicitly here — each run in turn cascades to its
 * tasks, shared-context, and amendments. Runs on time in one transaction.
 * On-disk artifacts (worktrees, logs) are the caller's responsibility.
 */
export function deleteSession(sessionId: string): void {
  const db = getDb();
  db.transaction(() => {
    const runs = db
      .prepare(`SELECT id FROM runs WHERE session_id = ?`)
      .all(sessionId) as { id: string }[];
    const delRun = db.prepare(`DELETE FROM runs WHERE id = ?`);
    for (const r of runs) delRun.run(r.id);
    db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
  })();
}

// ---- session PRs ----------------------------------------------------------

export interface SessionPrRow {
  id: string;
  session_id: string;
  run_id: string | null;
  project_name: string | null;
  number: number | null;
  url: string;
  title: string | null;
  state: string | null;
  head_branch: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Records (or refreshes) a PR discovered for a session, keyed on `(session_id,
 * url)` so re-running discovery updates the row in place — its state/title stay
 * current — rather than piling up duplicates. Returns the stored row.
 */
export function upsertSessionPr(input: {
  sessionId: string;
  url: string;
  runId?: string | null;
  projectName?: string | null;
  number?: number | null;
  title?: string | null;
  state?: string | null;
  headBranch?: string | null;
}): SessionPrRow {
  const now = nowIso();
  getDb()
    .prepare(
      `INSERT INTO session_prs
         (id, session_id, run_id, project_name, number, url, title, state, head_branch, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, url) DO UPDATE SET
         run_id       = COALESCE(excluded.run_id, session_prs.run_id),
         project_name = COALESCE(excluded.project_name, session_prs.project_name),
         number       = COALESCE(excluded.number, session_prs.number),
         title        = COALESCE(excluded.title, session_prs.title),
         state        = COALESCE(excluded.state, session_prs.state),
         head_branch  = COALESCE(excluded.head_branch, session_prs.head_branch),
         updated_at   = excluded.updated_at`,
    )
    .run(
      id("pr"),
      input.sessionId,
      input.runId ?? null,
      input.projectName ?? null,
      input.number ?? null,
      input.url,
      input.title ?? null,
      input.state ?? null,
      input.headBranch ?? null,
      now,
      now,
    );
  return getDb()
    .prepare(`SELECT * FROM session_prs WHERE session_id = ? AND url = ?`)
    .get(input.sessionId, input.url) as SessionPrRow;
}

/** PRs recorded for a session, newest first. */
export function listSessionPrs(sessionId: string): SessionPrRow[] {
  return getDb()
    .prepare(`SELECT * FROM session_prs WHERE session_id = ? ORDER BY created_at DESC`)
    .all(sessionId) as SessionPrRow[];
}

export function addSessionMessage(input: {
  sessionId: string;
  role: "user" | "assistant";
  content: string;
}): SessionMessageRow {
  const messageId = id("msg");
  getDb()
    .prepare(
      `INSERT INTO session_messages (id, session_id, role, content, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(messageId, input.sessionId, input.role, input.content, nowIso());
  return getDb()
    .prepare(`SELECT * FROM session_messages WHERE id = ?`)
    .get(messageId) as SessionMessageRow;
}

export function listSessionMessages(sessionId: string): SessionMessageRow[] {
  return getDb()
    .prepare(`SELECT * FROM session_messages WHERE session_id = ? ORDER BY created_at`)
    .all(sessionId) as SessionMessageRow[];
}
