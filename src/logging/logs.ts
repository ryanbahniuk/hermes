import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { LOGS_DIR } from "../paths";

export function runLogDir(runId: string): string {
  return join(LOGS_DIR, runId);
}

export function runLogFile(runId: string): string {
  return join(runLogDir(runId), "run.log");
}

export function taskLogFile(runId: string, taskId: string): string {
  return join(runLogDir(runId), `${taskId}.log`);
}

export function sessionLogDir(): string {
  return join(LOGS_DIR, "sessions");
}

/** Full transcript log for a planning session — including tool calls, which the chat view no longer renders. */
export function sessionLogFile(sessionId: string): string {
  return join(sessionLogDir(), `${sessionId}.log`);
}

export function ensureRunLogDir(runId: string): void {
  mkdirSync(runLogDir(runId), { recursive: true });
}

/** Appends a timestamped line to a log file. */
export function appendLog(file: string, line: string): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`);
}

export function readLog(file: string): string {
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

/** Prints the file, then polls for and prints appended bytes until interrupted. */
export function followLog(file: string): void {
  process.stdout.write(readLog(file));
  let offset = existsSync(file) ? statSync(file).size : 0;

  const drain = () => {
    if (!existsSync(file)) return;
    const size = statSync(file).size;
    if (size < offset) offset = 0; // file was truncated/rotated
    if (size === offset) return;
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(size - offset);
      readSync(fd, buf, 0, buf.length, offset);
      process.stdout.write(buf);
      offset = size;
    } finally {
      closeSync(fd);
    }
  };

  const interval = setInterval(drain, 300);
  const stop = () => {
    clearInterval(interval);
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
