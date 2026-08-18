import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { ensureRunLogDir, runLogFile } from "../logging/logs";

/**
 * Re-invokes *this* program to run the detached supervisor, so it works whether
 * we're a compiled standalone binary or running from source under `bun`.
 *
 * In a compiled binary `Bun.main` is a virtual `/$bunfs/…` path and `execPath`
 * is the real executable, so we spawn the executable directly. Under `bun` from
 * source, `execPath` is `bun` and we must pass the entry script as the first arg.
 */
function selfInvocation(): { cmd: string; args: string[] } {
  const compiled = Bun.main.startsWith("/$bunfs/");
  return compiled
    ? { cmd: process.execPath, args: [] }
    : { cmd: process.execPath, args: [Bun.main] };
}

/**
 * Spawns the supervisor for a run as a detached background process that outlives
 * the CLI. stdout/stderr are redirected to the run log; the child is unref'd so
 * the parent can exit. Returns the child pid.
 */
export function spawnSupervisor(runId: string): number {
  ensureRunLogDir(runId);
  const fd = openSync(runLogFile(runId), "a");
  const { cmd, args } = selfInvocation();
  const child = spawn(cmd, [...args, "__supervise", runId], {
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
