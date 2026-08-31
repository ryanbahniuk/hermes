import { describe, expect, test } from "bun:test";
import type { SessionRow } from "../../db";
import { sessionLive } from "./theme";

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
