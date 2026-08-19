import { homedir } from "node:os";
import { join } from "node:path";

/** Root for all Hermes state. Override with HERMES_HOME (used by tests). */
export const HERMES_HOME =
  process.env.HERMES_HOME ?? join(homedir(), ".hermes");

export const CONFIG_PATH = join(HERMES_HOME, "hermes.config.ts");
export const DB_PATH = join(HERMES_HOME, "hermes.db");
export const LOGS_DIR = join(HERMES_HOME, "logs");

/** Expands a leading `~` to the user's home directory. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}
