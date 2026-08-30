import { homedir } from "node:os";
import { join } from "node:path";

/** Root for all Tack state. Override with TACK_HOME (used by tests). */
export const TACK_HOME =
  process.env.TACK_HOME ?? join(homedir(), ".tack");

export const CONFIG_PATH = join(TACK_HOME, "tack.config.ts");
export const DB_PATH = join(TACK_HOME, "tack.db");
export const LOGS_DIR = join(TACK_HOME, "logs");

/** Expands a leading `~` to the user's home directory. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}
