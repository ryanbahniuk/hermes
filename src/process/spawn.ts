import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ensureRunLogDir, runLogFile } from "../logging/logs";

const SUPERVISOR_ENTRY = fileURLToPath(
  new URL("../../bin/supervisor.ts", import.meta.url),
);

/**
 * Spawns the supervisor for a run as a detached background process that outlives
 * the CLI. stdout/stderr are redirected to the run log; the child is unref'd so
 * the parent can exit. Returns the child pid.
 */
export function spawnSupervisor(runId: string): number {
  ensureRunLogDir(runId);
  const fd = openSync(runLogFile(runId), "a");
  const child = spawn("bun", [SUPERVISOR_ENTRY, runId], {
    detached: true,
    stdio: ["ignore", fd, fd],
    env: process.env,
  });
  child.unref();
  if (child.pid === undefined) {
    throw new Error("Failed to spawn supervisor process");
  }
  return child.pid;
}

/** True if a process with this pid currently exists. */
export function isAlive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
