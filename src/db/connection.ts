import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DB_PATH } from "../paths";

let instance: Database | null = null;

/** Opens (once) and returns the shared SQLite connection. */
export function getDb(path = DB_PATH): Database {
  if (instance) return instance;
  mkdirSync(dirname(path), { recursive: true });
  instance = new Database(path, { create: true });
  instance.exec("PRAGMA journal_mode = WAL;");
  instance.exec("PRAGMA foreign_keys = ON;");
  return instance;
}
