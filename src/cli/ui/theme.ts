import type { RunRow } from "../../db";
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

/** A short USD string, e.g. `$0.0421`. */
export function usd(n: number): string {
  return `$${n.toFixed(4)}`;
}
