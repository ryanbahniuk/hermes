import { describe, expect, test } from "bun:test";
import type { RunRow, SessionCost, SessionPrRow, SessionRow } from "../../db";
import { patchRow, withoutSessionBlock, type Row } from "./rows";

// Minimal fixtures — only the fields the row helpers touch matter; the rest are
// filled to satisfy the row shape so these read like the real `buildRows` output.
function sessionRow(id: string, over: Partial<SessionRow> = {}): Row {
  const session = {
    id,
    title: null,
    planner_model: null,
    runtime: null,
    resume_ref: null,
    status: "active",
    cost: 0,
    pid: null,
    heartbeat_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...over,
  } as SessionRow;
  const cost: SessionCost = { total: 0 } as SessionCost;
  return { key: `s:${id}`, kind: "session", session, cost, allRunsTerminal: true };
}

function runRow(id: string, sessionId: string): Row {
  const run = {
    id,
    problem: "p",
    status: "implementing",
    planner_model: null,
    cost: 0,
    supervisor_pid: null,
    session_id: sessionId,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  } as RunRow;
  return { key: `r:${id}`, kind: "run", run, taskCount: 0 };
}

function prRow(id: string): Row {
  const pr = { id, number: 1, url: "u", title: "t", state: "open" } as SessionPrRow;
  return { key: `pr:${id}`, kind: "pr", pr };
}

describe("withoutSessionBlock", () => {
  // A tree: session A (+ run, pr), session B (+ run), session C.
  const tree = (): Row[] => [
    sessionRow("A"),
    runRow("a1", "A"),
    prRow("ap"),
    sessionRow("B"),
    runRow("b1", "B"),
    sessionRow("C"),
  ];

  test("drops a session and its contiguous run + pr children", () => {
    const out = withoutSessionBlock(tree(), 0);
    expect(out.map((r) => r.key)).toEqual(["s:B", "r:b1", "s:C"]);
  });

  test("drops a middle session block without touching its neighbors", () => {
    const out = withoutSessionBlock(tree(), 3); // session B at index 3
    expect(out.map((r) => r.key)).toEqual(["s:A", "r:a1", "pr:ap", "s:C"]);
  });

  test("drops a trailing childless session", () => {
    const out = withoutSessionBlock(tree(), 5); // session C, no children
    expect(out.map((r) => r.key)).toEqual(["s:A", "r:a1", "pr:ap", "s:B", "r:b1"]);
  });

  test("a session with no children removes only itself", () => {
    const rows = [sessionRow("A"), sessionRow("B")];
    expect(withoutSessionBlock(rows, 0).map((r) => r.key)).toEqual(["s:B"]);
  });
});

describe("patchRow", () => {
  test("replaces only the target row, preserving identity of the rest", () => {
    const rows = [sessionRow("A"), runRow("a1", "A")];
    const closed = sessionRow("A", { status: "closed" });
    const out = patchRow(rows, 0, closed);
    expect(out[0]).toBe(closed);
    expect(out[1]).toBe(rows[1]); // untouched rows keep referential identity
    expect((out[0] as { kind: "session"; session: SessionRow }).session.status).toBe("closed");
  });
});
