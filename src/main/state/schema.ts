import { createHash } from "node:crypto";

/**
 * Schema history. Every migration is a single SQL string executed inside one
 * transaction together with its `schema_migrations` row and the PRAGMA bump.
 * Adding a column is a new migration; never edit an applied one, because its
 * checksum is recorded and verified.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const V1 = `
CREATE TABLE schema_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  checksum    TEXT NOT NULL,
  applied_at  TEXT NOT NULL
);

CREATE TABLE meta (
  key         TEXT PRIMARY KEY,
  value_json  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- A project is identified independently of its path. The path identity is what
-- detects aliases; the project id survives relocation.
CREATE TABLE projects (
  id               TEXT PRIMARY KEY CHECK (id GLOB 'prj_[a-z0-9]*'),
  name             TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  root_path        TEXT NOT NULL,
  canonical_path   TEXT NOT NULL,
  fs_dev           INTEGER NOT NULL,
  fs_ino           INTEGER NOT NULL,
  repository_kind  TEXT NOT NULL DEFAULT 'none'
                   CHECK (repository_kind IN ('none', 'git', 'git_worktree')),
  repository_root  TEXT,
  worktree_name    TEXT,
  archived         INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  pinned           INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  removed_at       TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  revision         INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);
CREATE UNIQUE INDEX projects_live_canonical
  ON projects (canonical_path) WHERE removed_at IS NULL;

-- Path history. One active identity per project; an identity may be active for
-- only one project, so two aliases of one folder cannot become two records.
CREATE TABLE project_paths (
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path           TEXT NOT NULL,
  canonical_path TEXT NOT NULL,
  fs_dev         INTEGER NOT NULL,
  fs_ino         INTEGER NOT NULL,
  active         INTEGER NOT NULL CHECK (active IN (0, 1)),
  recorded_at    TEXT NOT NULL,
  PRIMARY KEY (project_id, canonical_path)
);
CREATE UNIQUE INDEX project_paths_active_identity
  ON project_paths (fs_dev, fs_ino) WHERE active = 1;
CREATE UNIQUE INDEX project_paths_one_active
  ON project_paths (project_id) WHERE active = 1;

-- Machine-local. Never exported: the executable path, port, and workspace are
-- specific to this Mac and this user.
CREATE TABLE runtime_bindings (
  project_id        TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  workspace         TEXT NOT NULL,
  canonical_workspace TEXT NOT NULL,
  executable        TEXT NOT NULL,
  engine_version    TEXT,
  engine_commit     TEXT,
  port              INTEGER,
  state             TEXT NOT NULL
                    CHECK (state IN ('starting', 'running', 'stopping', 'stopped', 'failed')),
  updated_at        TEXT NOT NULL
);

-- Engine session history stays authoritative in Codewhale. These are IDs and
-- projections only, never a competing transcript.
CREATE TABLE threads (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  engine_thread_id  TEXT,
  title             TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX threads_project ON threads (project_id);

CREATE TABLE turns (
  id                TEXT PRIMARY KEY,
  thread_id         TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  status            TEXT NOT NULL,
  provider          TEXT,
  model             TEXT,
  permission_posture TEXT,
  started_at        TEXT NOT NULL,
  ended_at          TEXT
);
CREATE INDEX turns_thread ON turns (thread_id);

CREATE TABLE submissions (
  operation_key   TEXT PRIMARY KEY,
  project_id      TEXT REFERENCES projects(id) ON DELETE CASCADE,
  thread_id       TEXT NOT NULL,
  turn_id         TEXT,
  status          TEXT NOT NULL CHECK (status IN (
                    'queued', 'sending', 'accepted', 'running', 'completed',
                    'failed', 'interrupted', 'canceled', 'outcome_unknown')),
  submitted_at    TEXT NOT NULL,
  reconciled      INTEGER NOT NULL DEFAULT 0 CHECK (reconciled IN (0, 1)),
  note            TEXT
);
CREATE INDEX submissions_project ON submissions (project_id, submitted_at);

CREATE TABLE tasks (
  id          TEXT PRIMARY KEY CHECK (id GLOB 'tsk_[a-z0-9]*'),
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title       TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  prompt      TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN (
                'pending', 'running', 'paused', 'blocked', 'completed',
                'failed', 'interrupted')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  revision    INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);
CREATE INDEX tasks_project_status ON tasks (project_id, status);

CREATE TABLE task_dependencies (
  task_id             TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at          TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id)
);

CREATE TABLE requirement_evidence (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id         TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  requirement_id  TEXT NOT NULL,
  path            TEXT NOT NULL,
  digest          TEXT,
  note            TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX requirement_evidence_project ON requirement_evidence (project_id, requirement_id);

CREATE TABLE attempts (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id            TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  problem_id         TEXT NOT NULL,
  requirement        TEXT NOT NULL,
  symptom            TEXT,
  hypothesis         TEXT NOT NULL,
  action             TEXT NOT NULL,
  observed           TEXT NOT NULL,
  material_progress  INTEGER NOT NULL CHECK (material_progress IN (0, 1)),
  evidence_json      TEXT NOT NULL DEFAULT '[]',
  created_at         TEXT NOT NULL
);
CREATE INDEX attempts_problem ON attempts (project_id, problem_id, created_at);

CREATE TABLE decisions (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE events (
  thread_id    TEXT NOT NULL,
  seq          INTEGER NOT NULL CHECK (seq >= 1),
  kind         TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  timestamp    TEXT NOT NULL,
  recorded_at  TEXT NOT NULL,
  PRIMARY KEY (thread_id, seq)
);

CREATE TABLE event_cursors (
  thread_id  TEXT PRIMARY KEY,
  last_seq   INTEGER NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE usage_records (
  id                TEXT PRIMARY KEY,
  project_id        TEXT REFERENCES projects(id) ON DELETE CASCADE,
  thread_id         TEXT,
  turn_id           TEXT,
  provider          TEXT NOT NULL,
  model             TEXT NOT NULL,
  input_tokens      INTEGER,
  output_tokens     INTEGER,
  cached_tokens     INTEGER,
  reasoning_tokens  INTEGER,
  cost_usd          REAL,
  cost_complete     INTEGER NOT NULL CHECK (cost_complete IN (0, 1)),
  captured_at       TEXT NOT NULL
);
CREATE INDEX usage_project ON usage_records (project_id, captured_at);

CREATE TABLE capability_snapshots (
  id              TEXT PRIMARY KEY,
  engine_version  TEXT NOT NULL,
  engine_commit   TEXT NOT NULL,
  digest          TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  captured_at     TEXT NOT NULL
);

CREATE TABLE settings (
  scope       TEXT PRIMARY KEY,
  version     INTEGER NOT NULL CHECK (version >= 1),
  value_json  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE settings_versions (
  scope        TEXT NOT NULL,
  version      INTEGER NOT NULL CHECK (version >= 1),
  value_json   TEXT NOT NULL,
  recorded_at  TEXT NOT NULL,
  PRIMARY KEY (scope, version)
);

CREATE TABLE drafts (
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  thread_id   TEXT NOT NULL,
  text        TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (project_id, thread_id)
);

CREATE TABLE artifacts (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id          TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  digest           TEXT NOT NULL,
  rel_path         TEXT NOT NULL UNIQUE,
  size_bytes       INTEGER NOT NULL CHECK (size_bytes >= 0),
  media_type       TEXT NOT NULL,
  source           TEXT NOT NULL,
  retention_class  TEXT NOT NULL CHECK (retention_class IN ('temporary', 'diagnostic', 'evidence')),
  created_at       TEXT NOT NULL
);
CREATE INDEX artifacts_project ON artifacts (project_id, created_at);
CREATE INDEX artifacts_digest ON artifacts (digest);
`;

// v2 exists to prove the upgrade path with real data already present: project
// identity fields used by the catalog and design system.
const V2 = `
ALTER TABLE projects ADD COLUMN accent TEXT;
ALTER TABLE projects ADD COLUMN monogram TEXT;
`;

// v3 replaces the short-lived task status set with the spec §8.2 state machine
// and adds the records the work board needs: one execution owner, acceptance
// criteria, recorded steps, run receipts, and a transition audit.
//
// The `tasks` table must be rebuilt because SQLite cannot alter a CHECK
// constraint. The migration runner disables foreign keys around the transaction
// (the documented rebuild procedure) so dependent rows are not cascaded away;
// integrity and foreign-key checks run again before the migration is recorded.
const V3 = `
CREATE TABLE tasks_v3 (
  id                       TEXT PRIMARY KEY CHECK (id GLOB 'tsk_[a-z0-9]*'),
  project_id               TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title                    TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  prompt                   TEXT NOT NULL,
  status                   TEXT NOT NULL CHECK (status IN (
                             'pending', 'running', 'verifying', 'completed',
                             'blocked', 'interrupted', 'skipped')),
  execution_owner          TEXT NOT NULL DEFAULT 'mona_queue'
                           CHECK (execution_owner IN ('mona_queue', 'native_workflow')),
  requirements_json        TEXT NOT NULL DEFAULT '[]',
  next_step                TEXT,
  verification_fingerprint TEXT,
  verification_stale       INTEGER NOT NULL DEFAULT 0 CHECK (verification_stale IN (0, 1)),
  stale_reason             TEXT,
  completed_at             TEXT,
  imported_from            TEXT,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL,
  revision                 INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);
INSERT INTO tasks_v3 (id, project_id, title, prompt, status, created_at, updated_at, revision)
SELECT id, project_id, title, prompt,
       CASE status WHEN 'paused' THEN 'interrupted' WHEN 'failed' THEN 'interrupted' ELSE status END,
       created_at, updated_at, revision
FROM tasks;
DROP TABLE tasks;
ALTER TABLE tasks_v3 RENAME TO tasks;
CREATE INDEX tasks_project_status ON tasks (project_id, status);

-- One mutating run per workspace, enforced by the database rather than by
-- convention. A verifying task is not mutating, so only 'running' is excluded.
CREATE UNIQUE INDEX tasks_one_running_per_project
  ON tasks (project_id) WHERE status = 'running';

CREATE TABLE task_acceptance (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  ordinal       INTEGER NOT NULL CHECK (ordinal >= 0),
  text          TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 1000),
  kind          TEXT NOT NULL CHECK (kind IN ('check', 'human')),
  satisfied     INTEGER NOT NULL DEFAULT 0 CHECK (satisfied IN (0, 1)),
  satisfied_by  TEXT CHECK (satisfied_by IN ('check', 'human')),
  evidence_path TEXT,
  updated_at    TEXT NOT NULL,
  UNIQUE (task_id, ordinal)
);
CREATE INDEX task_acceptance_task ON task_acceptance (task_id, ordinal);

CREATE TABLE task_steps (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  ordinal       INTEGER NOT NULL CHECK (ordinal >= 0),
  label         TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 500),
  state         TEXT NOT NULL DEFAULT 'pending'
                CHECK (state IN ('pending', 'running', 'completed', 'skipped')),
  evidence_path TEXT,
  recorded_at   TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (task_id, ordinal)
);
CREATE INDEX task_steps_task ON task_steps (task_id, ordinal);

CREATE TABLE task_runs (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  owner       TEXT NOT NULL CHECK (owner IN ('mona_queue', 'native_workflow')),
  state       TEXT NOT NULL CHECK (state IN ('running', 'completed', 'failed', 'interrupted')),
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  note        TEXT
);
CREATE UNIQUE INDEX task_runs_one_mutating_per_project
  ON task_runs (project_id) WHERE state = 'running';
CREATE INDEX task_runs_task ON task_runs (task_id, started_at);

CREATE TABLE task_events (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  actor       TEXT NOT NULL CHECK (actor IN ('human', 'mona_queue', 'native_workflow', 'reconciler')),
  reason      TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX task_events_task ON task_events (task_id, created_at);
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "core-project-state", sql: V1 },
  { version: 2, name: "project-identity-fields", sql: V2 },
  { version: 3, name: "task-board-and-continuity", sql: V3 },
];

export const CURRENT_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

export const REQUIRED_TABLES: readonly string[] = [
  "artifacts",
  "attempts",
  "capability_snapshots",
  "decisions",
  "drafts",
  "event_cursors",
  "events",
  "meta",
  "project_paths",
  "projects",
  "requirement_evidence",
  "runtime_bindings",
  "schema_migrations",
  "settings",
  "settings_versions",
  "submissions",
  "task_acceptance",
  "task_dependencies",
  "task_events",
  "task_runs",
  "task_steps",
  "tasks",
  "threads",
  "turns",
  "usage_records",
];

const V3_TABLES: readonly string[] = ["task_acceptance", "task_events", "task_runs", "task_steps"];

/** Tables a database at `version` must have. Older targets predate v3. */
export function requiredTablesFor(version: number): readonly string[] {
  return version >= 3 ? REQUIRED_TABLES : REQUIRED_TABLES.filter((t) => !V3_TABLES.includes(t));
}

export function migrationChecksum(migration: Migration): string {
  return createHash("sha256")
    .update(String(migration.version))
    .update("\0")
    .update(migration.sql)
    .digest("hex");
}
