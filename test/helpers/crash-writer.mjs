// Crash-injection helper. It uses the same SQLite engine and file format the
// product uses, and dies at a precise point relative to a write transaction:
//   before  — opened the database, no transaction
//   during  — BEGIN IMMEDIATE plus an uncommitted insert, then SIGKILL
//   after   — committed insert, then SIGKILL
// The parent test observes what survives on reopen.
import { DatabaseSync } from "node:sqlite";

const [dbPath, mode, projectId] = process.argv.slice(2);
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = FULL");
const now = new Date().toISOString();

if (mode === "before") {
  process.stdout.write("ready\n");
  process.kill(process.pid, "SIGKILL");
} else if (mode === "during" || mode === "after") {
  db.exec("BEGIN IMMEDIATE");
  db.prepare(
    "INSERT INTO tasks (id, project_id, title, prompt, status, created_at, updated_at, revision) " +
      "VALUES (?, ?, ?, ?, 'pending', ?, ?, 1)",
  ).run(`tsk_crash${mode}01`, projectId, `crash ${mode}`, "crash-injection", now, now);
  if (mode === "after") {
    db.exec("COMMIT");
    process.stdout.write("committed\n");
  } else {
    process.stdout.write("ready\n");
  }
  setInterval(() => {}, 1_000);
} else {
  process.stderr.write("unknown mode\n");
  process.exit(2);
}
