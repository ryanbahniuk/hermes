import type { Database } from "bun:sqlite";
import { nowIso } from "../util/id";

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const migrations: Migration[] = [
  {
    version: 1,
    name: "init",
    sql: `
      CREATE TABLE runs (
        id             TEXT PRIMARY KEY,
        problem        TEXT NOT NULL,
        status         TEXT NOT NULL,
        planner_model  TEXT,
        cost           REAL NOT NULL DEFAULT 0,
        supervisor_pid INTEGER,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );

      CREATE TABLE tasks (
        id            TEXT PRIMARY KEY,
        run_id        TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        project_name  TEXT NOT NULL,
        worktree_path TEXT,
        status        TEXT NOT NULL,
        model         TEXT,
        runtime       TEXT,
        resume_ref    TEXT,
        cost          REAL NOT NULL DEFAULT 0,
        diff_ref      TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );

      CREATE TABLE shared_context (
        run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        version     INTEGER NOT NULL,
        content     TEXT NOT NULL,
        authored_by TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        PRIMARY KEY (run_id, version)
      );

      CREATE TABLE amendments (
        id          TEXT PRIMARY KEY,
        run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        proposed_by TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        proposal    TEXT NOT NULL,
        status      TEXT NOT NULL,
        resolution  TEXT,
        created_at  TEXT NOT NULL,
        resolved_at TEXT
      );

      CREATE INDEX idx_tasks_run ON tasks(run_id);
      CREATE INDEX idx_amendments_run ON amendments(run_id);
    `,
  },
  {
    version: 2,
    name: "task_prompt",
    sql: `ALTER TABLE tasks ADD COLUMN prompt TEXT;`,
  },
  {
    version: 3,
    name: "planning_sessions",
    sql: `
      CREATE TABLE sessions (
        id             TEXT PRIMARY KEY,
        title          TEXT,
        planner_model  TEXT,
        runtime        TEXT,
        resume_ref     TEXT,          -- claude SDK session id (null for hermes)
        status         TEXT NOT NULL, -- active | closed
        cost           REAL NOT NULL DEFAULT 0,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );

      CREATE TABLE session_messages (
        id         TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role       TEXT NOT NULL,     -- user | assistant
        content    TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX idx_session_messages_session ON session_messages(session_id);

      ALTER TABLE runs ADD COLUMN session_id TEXT;
    `,
  },
];

/** Applies any pending migrations in a single transaction. */
export function migrate(db: Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (
       version    INTEGER PRIMARY KEY,
       name       TEXT NOT NULL,
       applied_at TEXT NOT NULL
     )`,
  );
  const row = db.prepare(`SELECT MAX(version) AS v FROM _migrations`).get() as {
    v: number | null;
  };
  const current = row.v ?? 0;
  const pending = migrations
    .filter((m) => m.version > current)
    .sort((a, b) => a.version - b.version);
  if (pending.length === 0) return;

  const record = db.prepare(
    `INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)`,
  );
  db.transaction(() => {
    for (const m of pending) {
      db.exec(m.sql);
      record.run(m.version, m.name, nowIso());
    }
  })();
}
