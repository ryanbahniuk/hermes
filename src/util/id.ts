import { randomBytes } from "node:crypto";

/** Short, human-scannable id like `run_1a2b3c4d`. */
export function id(prefix: string): string {
  return `${prefix}_${randomBytes(4).toString("hex")}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
