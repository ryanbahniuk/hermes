import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point all Tack state at a throwaway home BEFORE the db modules read paths.ts,
// so these tests never touch the developer's real ~/.tack database. The dynamic
// imports below are deferred until after the env var is set.
const home = mkdtempSync(join(tmpdir(), "tack-actions-"));
process.env.TACK_HOME = home;

const { db, createRun, getRun, setRunStatus, setSupervisorPid } = await import("../db");
const { stopRun } = await import("./actions");
const { settleTerminalStatus } = await import("../orchestrator/supervise");

// Apply migrations so the runs table exists.
db();

// A pid that (practically) never exists — a stand-in for a dead supervisor.
const DEAD_PID = 2_147_483_646;

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("stopRun", () => {
  test("settles a stalled run (non-terminal, dead supervisor) as stopped, not failed", () => {
    const run = createRun({ problem: "stalled" });
    setRunStatus(run.id, "implementing");
    setSupervisorPid(run.id, DEAD_PID);

    const result = stopRun(getRun(run.id)!);

    expect(result).toBe("cleared");
    const after = getRun(run.id)!;
    // A user-initiated stop reads as `stopped`; `failed` is reserved for crashes.
    expect(after.status).toBe("stopped");
    expect(after.supervisor_pid).toBeNull();
  });

  test("settles a stalled run with no recorded pid as stopped", () => {
    const run = createRun({ problem: "no-pid" });
    setRunStatus(run.id, "planning");

    const result = stopRun(getRun(run.id)!);

    expect(result).toBe("cleared");
    expect(getRun(run.id)!.status).toBe("stopped");
  });

  test("is a no-op on an already-terminal run", () => {
    for (const status of ["done", "failed", "stopped"] as const) {
      const run = createRun({ problem: status });
      setRunStatus(run.id, status);
      setSupervisorPid(run.id, DEAD_PID);

      const result = stopRun(getRun(run.id)!);

      expect(result).toBe("not-running");
      const after = getRun(run.id)!;
      expect(after.status).toBe(status);
      // A terminal run is left untouched, stale pid and all.
      expect(after.supervisor_pid).toBe(DEAD_PID);
    }
  });

  test("SIGTERMs a live supervisor, settles the run stopped, and clears its pid", async () => {
    // A real child process gives us a genuinely-alive pid to signal, without
    // risking the test runner itself.
    const child = Bun.spawn(["sleep", "30"]);
    const run = createRun({ problem: "live" });
    setRunStatus(run.id, "implementing");
    setSupervisorPid(run.id, child.pid);

    const result = stopRun(getRun(run.id)!);

    expect(result).toBe("stopped");
    const after = getRun(run.id)!;
    expect(after.supervisor_pid).toBeNull();
    // stopRun records the terminal `stopped` up front so the SIGTERM'd
    // supervisor can't clobber the user's intent back to `failed`.
    expect(after.status).toBe("stopped");

    await child.exited;
  });
});

// The supervisor's guard against clobbering a user-initiated stop. It shares the
// same DB connection as the tests above (one TACK_HOME per process).
describe("settleTerminalStatus", () => {
  test("does not clobber a user-initiated stop back to failed", () => {
    const run = createRun({ problem: "stopped-then-supervisor-loses-race" });
    // stopRun already settled it as `stopped`; the SIGTERM'd supervisor is still
    // winding down and tries to record its own terminal outcome.
    setRunStatus(run.id, "stopped");

    settleTerminalStatus(run.id, "failed");

    expect(getRun(run.id)!.status).toBe("stopped");
  });

  test("records failed for a genuine crash (nobody set stopped)", () => {
    const run = createRun({ problem: "genuine-failure" });
    setRunStatus(run.id, "implementing");

    settleTerminalStatus(run.id, "failed");

    expect(getRun(run.id)!.status).toBe("failed");
  });

  test("records done for a clean finish", () => {
    const run = createRun({ problem: "clean-finish" });
    setRunStatus(run.id, "reconciling");

    settleTerminalStatus(run.id, "done");

    expect(getRun(run.id)!.status).toBe("done");
  });
});
