import { homedir } from "node:os";
import { join } from "node:path";

/** Root for all Hermes state. Override with HERMES_HOME (used by tests). */
export const HERMES_HOME =
  process.env.HERMES_HOME ?? join(homedir(), ".hermes");

export const CONFIG_PATH = join(HERMES_HOME, "hermes.config.ts");
export const DB_PATH = join(HERMES_HOME, "hermes.db");
export const LOGS_DIR = join(HERMES_HOME, "logs");
