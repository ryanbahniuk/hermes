import { getDb } from "./connection";
import { migrate } from "./migrate";

let migrated = false;

/** Returns the shared connection, applying migrations on first use. */
export function db() {
  const connection = getDb();
  if (!migrated) {
    migrate(connection);
    migrated = true;
  }
  return connection;
}

export * from "./repositories";
