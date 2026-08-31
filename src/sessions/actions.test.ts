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

// Apply migrations so the runs table exists.
db();

// A pid that (practically) never exists — a stand-in for a dead supervisor.
const DEAD_PID = 2_147_483_646;

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("stopRun", () => {
  test("clears a stalled run (non-terminal, dead supervisor) to failed", () => {
    const run = createRun({ problem: "stalled" });
    setRunStatus(run.id, "implementing");
    setSupervisorPid(run.id, DEAD_PID);

    const result = stopRun(getRun(run.id)!);

    expect(result).toBe("cleared");
    const after = getRun(run.id)!;
    expect(after.status).toBe("failed");
    expect(after.supervisor_pid).toBeNull();
  });

  test("clears a stalled run with no recorded pid", () => {
    const run = createRun({ problem: "no-pid" });
    setRunStatus(run.id, "planning");

    const result = stopRun(getRun(run.id)!);

    expect(result).toBe("cleared");
    expect(getRun(run.id)!.status).toBe("failed");
  });

  test("is a no-op on an already-terminal run", () => {
    for (const status of ["done", "failed"] as const) {
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

  test("SIGTERMs a live supervisor and clears its pid, leaving status non-terminal", async () => {
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
    // The supervisor is the one that marks a run terminal; stopRun leaves it be.
    expect(after.status).toBe("implementing");

    await child.exited;
  });
});
