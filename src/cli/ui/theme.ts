import type { RunRow, SessionRow } from "../../db";
import { isAlive } from "../../process/spawn";

/** A status rendered as a colored label — the shared vocabulary of the TUIs. */
export interface Live {
  label: string;
  color: string;
  /** Render dimmed (terminal states that are no longer moving). */
  dim: boolean;
}

/** Maps a run/task lifecycle status to a color. */
export function statusColor(status: string): string {
  switch (status) {
    case "done":
      return "green";
    case "failed":
      return "red";
    case "stalled":
      return "yellow";
    case "pending":
      return "gray";
    default:
      return "cyan";
  }
}

/**
 * A run's *live* status: terminal runs report their stored status; in-flight
 * runs are "running" only while their supervisor pid is alive, else "stalled".
 * This is the single source of truth shared by the dashboard and the chat view.
 */
export function runLive(r: RunRow): Live {
  const terminal = r.status === "done" || r.status === "failed";
  if (terminal) {
    return { label: r.status, color: r.status === "done" ? "green" : "red", dim: true };
  }
  return isAlive(r.supervisor_pid)
    ? { label: "running", color: "green", dim: false }
    : { label: "stalled", color: "yellow", dim: false };
}

/**
 * A session is dead if its heartbeat hasn't ticked within this window. It's a
 * few multiples of the planner's ~15s HEARTBEAT_INTERVAL_MS (see PlannerSession),
 * so a couple of missed beats — a busy turn, GC pause — don't flash "dead".
 */
const SESSION_STALE_MS = 60_000;

/**
 * A session's *live* status, mirroring `runLive` for sessions. A closed session
 * reports "closed"; otherwise it's "active" only while its recorded pid is alive
 * AND its heartbeat is fresh. A session whose interactive process was killed or
 * crashed goes stale and reads "dead" — no longer masquerading as active.
 */
export function sessionLive(s: SessionRow): Live {
  if (s.status === "closed") {
    return { label: "closed", color: "gray", dim: true };
  }
  const fresh =
    s.heartbeat_at != null && Date.now() - Date.parse(s.heartbeat_at) < SESSION_STALE_MS;
  return isAlive(s.pid) && fresh
    ? { label: "active", color: "green", dim: false }
    : { label: "dead", color: "yellow", dim: false };
}

/** A destructive action offered on a dashboard row: its key and hint verb. */
export interface RowAction {
  /** The keybinding that fires it. */
  key: "x" | "d";
  /** The verb shown next to the key, e.g. "stop", "kill", "delete". */
  hint: string;
}

/**
 * The destructive actions valid for a run *in its current live state* — the
 * single source of truth behind the per-row hint, the footer, and the key
 * handler. A run can only be stopped while it's still in flight (running or
 * stalled); a terminal run (done/failed) offers nothing.
 */
export function runActions(r: RunRow): RowAction[] {
  const { label } = runLive(r);
  const terminal = label === "done" || label === "failed";
  return terminal ? [] : [{ key: "x", hint: "stop" }];
}

/**
 * The destructive actions valid for a session *in its current live state*. Kill
 * only makes sense on an active session (a dead/closed one has nothing live to
 * signal); delete is always available regardless of liveness.
 */
export function sessionActions(s: SessionRow): RowAction[] {
  const actions: RowAction[] = [];
  if (sessionLive(s).label === "active") actions.push({ key: "x", hint: "kill" });
  actions.push({ key: "d", hint: "delete" });
  return actions;
}

/** Renders a row's actions as a hint string, e.g. `x kill · d delete`. */
export function actionHint(actions: RowAction[]): string {
  return actions.map((a) => `${a.key} ${a.hint}`).join(" · ");
}

/** A short USD string, e.g. `$0.0421`. */
export function usd(n: number): string {
  return `$${n.toFixed(4)}`;
}
