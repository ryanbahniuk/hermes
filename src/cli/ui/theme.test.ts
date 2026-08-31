import { describe, expect, test } from "bun:test";
import type { RunRow, SessionRow } from "../../db";
import { runActions, runLive, sessionActions, sessionLive, statusColor } from "./theme";

// A pid that (practically) never exists, so isAlive() is false — a stand-in for
// a session whose interactive process was killed or crashed.
const DEAD_PID = 2_147_483_646;

function row(over: Partial<SessionRow>): SessionRow {
  return {
    id: "sess_test",
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
  };
}

function runRow(over: Partial<RunRow>): RunRow {
  return {
    id: "run_test",
    problem: "p",
    status: "planning",
    planner_model: null,
    cost: 0,
    supervisor_pid: null,
    session_id: "sess_test",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("sessionLive", () => {
  test("closed sessions read closed, regardless of pid/heartbeat", () => {
    const live = sessionLive(row({ status: "closed", pid: process.pid, heartbeat_at: new Date().toISOString() }));
    expect(live.label).toBe("closed");
    expect(live.color).toBe("gray");
  });

  test("live process with a fresh heartbeat is active", () => {
    const live = sessionLive(row({ pid: process.pid, heartbeat_at: new Date().toISOString() }));
    expect(live.label).toBe("active");
    expect(live.color).toBe("green");
  });

  test("a dead pid reads dead even with a fresh heartbeat", () => {
    const live = sessionLive(row({ pid: DEAD_PID, heartbeat_at: new Date().toISOString() }));
    expect(live.label).toBe("dead");
    expect(live.color).toBe("yellow");
  });

  test("a stale heartbeat reads dead even if the pid is alive", () => {
    const stale = new Date(Date.now() - 10 * 60_000).toISOString();
    const live = sessionLive(row({ pid: process.pid, heartbeat_at: stale }));
    expect(live.label).toBe("dead");
  });

  test("never-attached session (no pid/heartbeat) reads dead", () => {
    const live = sessionLive(row({ pid: null, heartbeat_at: null }));
    expect(live.label).toBe("dead");
  });
});

describe("statusColor", () => {
  test("maps stopped to a distinct blue, apart from failed/done/stalled", () => {
    expect(statusColor("stopped")).toBe("blue");
    expect(statusColor("failed")).toBe("red");
    expect(statusColor("done")).toBe("green");
    expect(statusColor("stalled")).toBe("yellow");
  });
});

describe("runLive", () => {
  test("a stopped run is terminal: label stopped, blue, dimmed", () => {
    const live = runLive(runRow({ status: "stopped", supervisor_pid: process.pid }));
    expect(live.label).toBe("stopped");
    expect(live.color).toBe("blue");
    expect(live.dim).toBe(true);
  });

  test("done and failed stay terminal", () => {
    expect(runLive(runRow({ status: "done" })).dim).toBe(true);
    expect(runLive(runRow({ status: "failed" })).dim).toBe(true);
  });

  test("a live in-flight run reads running", () => {
    const live = runLive(runRow({ status: "implementing", supervisor_pid: process.pid }));
    expect(live.label).toBe("running");
    expect(live.dim).toBe(false);
  });
});

describe("runActions", () => {
  const keys = (r: RunRow) => runActions(r).map((a) => a.key);

  test("a running run (live supervisor) offers stop", () => {
    const actions = runActions(runRow({ status: "implementing", supervisor_pid: process.pid }));
    expect(actions).toEqual([{ key: "x", hint: "stop" }]);
  });

  test("a stalled run (non-terminal, dead supervisor) offers stop", () => {
    const actions = runActions(runRow({ status: "implementing", supervisor_pid: DEAD_PID }));
    expect(actions).toEqual([{ key: "x", hint: "stop" }]);
  });

  test("a done run offers nothing", () => {
    expect(keys(runRow({ status: "done", supervisor_pid: DEAD_PID }))).toEqual([]);
  });

  test("a failed run offers nothing", () => {
    expect(keys(runRow({ status: "failed", supervisor_pid: process.pid }))).toEqual([]);
  });

  test("a stopped run is terminal and offers nothing", () => {
    expect(keys(runRow({ status: "stopped", supervisor_pid: process.pid }))).toEqual([]);
  });
});

describe("sessionActions", () => {
  const keys = (s: SessionRow) => sessionActions(s).map((a) => a.key);

  test("an active session offers both kill and delete", () => {
    const actions = sessionActions(
      row({ pid: process.pid, heartbeat_at: new Date().toISOString() }),
    );
    expect(actions).toEqual([
      { key: "x", hint: "kill" },
      { key: "d", hint: "delete" },
    ]);
  });

  test("a dead session offers only delete", () => {
    expect(keys(row({ pid: DEAD_PID, heartbeat_at: new Date().toISOString() }))).toEqual(["d"]);
  });

  test("a closed session offers only delete", () => {
    expect(
      keys(row({ status: "closed", pid: process.pid, heartbeat_at: new Date().toISOString() })),
    ).toEqual(["d"]);
  });
});
