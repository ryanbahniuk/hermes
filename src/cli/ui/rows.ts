import type { RunRow, SessionCost, SessionPrRow, SessionRow } from "../../db";

// A dashboard row is either a session header or one of its runs, flattened into
// a single navigable list so a single cursor can walk the whole tree.
export type Row =
  | {
      key: string;
      kind: "session";
      session: SessionRow;
      cost: SessionCost;
      /** Every run terminal → archive is eligible. Computed here so it's the one source. */
      allRunsTerminal: boolean;
    }
  | { key: string; kind: "run"; run: RunRow; taskCount: number }
  | { key: string; kind: "pr"; pr: SessionPrRow };

/**
 * Drop a session and its contiguous child rows (its runs and PRs) from the row
 * list. `buildRows` always emits a session immediately followed by its own runs
 * then PRs before the next session, so the block is exactly `index` up to (but
 * not including) the next session row. Used for the optimistic removal that makes
 * delete/archive-while-hidden feel instant — the poll rebuild is still the source
 * of truth and reconciles if the background teardown fails.
 */
export function withoutSessionBlock(rows: Row[], index: number): Row[] {
  let end = index + 1;
  while (end < rows.length && rows[end].kind !== "session") end++;
  return [...rows.slice(0, index), ...rows.slice(end)];
}

/** Optimistically patch a single row in place (identity-preserving for the rest). */
export function patchRow(rows: Row[], index: number, next: Row): Row[] {
  return rows.map((r, i) => (i === index ? next : r));
}
