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

// v4 makes the three-attempt rule a property of stored state rather than a
// convention. A problem has one stable row per active (project, task,
// requirement) pair; attempts are linked to it; counters live on the problem so
// a new session reads the same numbers. The partial unique indexes are what stop
// a re-worded symptom or a reopened session from silently creating a second
// problem, and the CHECK on no_progress_attempts caps the counter at three.
const V4 = `
ALTER TABLE tasks ADD COLUMN active_turn_id TEXT;

CREATE TABLE problems (
  id                   TEXT PRIMARY KEY CHECK (id GLOB 'prb_[a-z0-9]*'),
  project_id           TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id              TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  requirement          TEXT NOT NULL CHECK (length(requirement) BETWEEN 1 AND 40),
  symptom              TEXT NOT NULL CHECK (length(symptom) BETWEEN 1 AND 4000),
  symptom_fingerprint  TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open', 'blocked', 'resolved')),
  total_attempts       INTEGER NOT NULL DEFAULT 0 CHECK (total_attempts >= 0),
  no_progress_attempts INTEGER NOT NULL DEFAULT 0
                       CHECK (no_progress_attempts BETWEEN 0 AND 3),
  help_needed          TEXT,
  blocked_at           TEXT,
  resolved_at          TEXT,
  resolution           TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  revision             INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);
CREATE UNIQUE INDEX problems_active_task
  ON problems (project_id, task_id, requirement)
  WHERE status <> 'resolved' AND task_id IS NOT NULL;
CREATE UNIQUE INDEX problems_active_fingerprint
  ON problems (project_id, symptom_fingerprint)
  WHERE status <> 'resolved' AND task_id IS NULL;
CREATE INDEX problems_project_status ON problems (project_id, status);

-- Append-only audit. An acknowledgement is recorded here and changes no
-- counter; only an attempt with evidence, a human resolution, or a new-evidence
-- reopen can change the problem's lifecycle.
CREATE TABLE problem_events (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  problem_id    TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN (
                  'created', 'attempt', 'progress_reset', 'blocked',
                  'acknowledged', 'reopened', 'resolved')),
  actor         TEXT NOT NULL CHECK (actor IN ('agent', 'human', 'mona_queue')),
  reason        TEXT,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  created_at    TEXT NOT NULL
);
CREATE INDEX problem_events_problem ON problem_events (problem_id, created_at);
`;

// v5 makes cost a durable ledger with explicit provenance. A turn is recorded
// once (partial unique index) so a replay cannot double-charge; the engine's
// cumulative thread total is stored as an exact delta; rates are versioned rows
// rather than code constants; budgets are user-set and evaluated locally.
// Existing rows are preserved and mapped to the closest honest cost state.
const V5 = `
CREATE TABLE rate_cards (
  id                  TEXT PRIMARY KEY,
  provider            TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 100),
  model               TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
  currency            TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  unit                TEXT NOT NULL DEFAULT 'per_million_tokens'
                      CHECK (unit = 'per_million_tokens'),
  cache_hit_pico      INTEGER CHECK (cache_hit_pico IS NULL OR cache_hit_pico >= 0),
  cache_miss_pico     INTEGER CHECK (cache_miss_pico IS NULL OR cache_miss_pico >= 0),
  output_pico         INTEGER CHECK (output_pico IS NULL OR output_pico >= 0),
  tool_call_pico      INTEGER CHECK (tool_call_pico IS NULL OR tool_call_pico >= 0),
  reasoning_in_output INTEGER NOT NULL DEFAULT 1 CHECK (reasoning_in_output IN (0, 1)),
  source              TEXT NOT NULL CHECK (source IN ('user_supplied', 'provider_docs')),
  source_ref          TEXT,
  revision            TEXT NOT NULL,
  revision_no         INTEGER NOT NULL DEFAULT 1 CHECK (revision_no >= 1),
  read_at             TEXT NOT NULL,
  effective_from      TEXT,
  effective_to        TEXT,
  created_at          TEXT NOT NULL,
  superseded_at       TEXT
);
CREATE UNIQUE INDEX rate_cards_current
  ON rate_cards (provider, model) WHERE superseded_at IS NULL;
CREATE INDEX rate_cards_route ON rate_cards (provider, model, read_at);

CREATE TABLE budgets (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scope       TEXT NOT NULL CHECK (scope IN ('session', 'project', 'day')),
  limit_pico  INTEGER NOT NULL CHECK (limit_pico > 0),
  warn_pico   INTEGER CHECK (warn_pico IS NULL OR (warn_pico > 0 AND warn_pico <= limit_pico)),
  enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  time_zone   TEXT NOT NULL CHECK (length(time_zone) BETWEEN 1 AND 64),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  revision    INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  UNIQUE (project_id, scope)
);

-- One mark per thread: the cumulative engine total last seen and the window it
-- was read in. A total that moves backwards never becomes a negative delta.
CREATE TABLE cost_thread_marks (
  thread_id           TEXT PRIMARY KEY,
  window_since        TEXT NOT NULL,
  reported_total_pico INTEGER CHECK (reported_total_pico IS NULL OR reported_total_pico >= 0),
  cost_complete       INTEGER NOT NULL DEFAULT 0 CHECK (cost_complete IN (0, 1)),
  updated_at          TEXT NOT NULL
);

ALTER TABLE usage_records ADD COLUMN task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL;
ALTER TABLE usage_records ADD COLUMN cache_miss_tokens INTEGER;
ALTER TABLE usage_records ADD COLUMN cost_pico_usd INTEGER;
ALTER TABLE usage_records ADD COLUMN cost_state TEXT NOT NULL DEFAULT 'unknown_price'
  CHECK (cost_state IN ('reported', 'estimated', 'unknown_price', 'missing_usage', 'unallocated'));
ALTER TABLE usage_records ADD COLUMN cost_allocation TEXT NOT NULL DEFAULT 'turn'
  CHECK (cost_allocation IN ('turn', 'thread_delta', 'none'));
ALTER TABLE usage_records ADD COLUMN rate_card_id TEXT REFERENCES rate_cards(id);
ALTER TABLE usage_records ADD COLUMN pricing_read_at TEXT;
ALTER TABLE usage_records ADD COLUMN token_semantics TEXT NOT NULL DEFAULT 'inclusive_input'
  CHECK (token_semantics IN ('inclusive_input', 'exclusive_input', 'unknown'));
ALTER TABLE usage_records ADD COLUMN note TEXT;

UPDATE usage_records
SET cost_pico_usd = ROUND(cost_usd * 1000000000000),
    cost_state = CASE WHEN cost_complete = 1 THEN 'reported' ELSE 'unknown_price' END;

-- A pre-P12 session deduplicated turns only in memory, so a restart could
-- insert the same turn twice. Keep the best-evidenced row per turn.
DELETE FROM usage_records
WHERE thread_id IS NOT NULL AND turn_id IS NOT NULL AND id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY thread_id, turn_id
      ORDER BY cost_complete DESC, COALESCE(cost_pico_usd, -1) DESC, captured_at DESC, id DESC
    ) AS rn
    FROM usage_records
    WHERE thread_id IS NOT NULL AND turn_id IS NOT NULL
  ) WHERE rn > 1
);
CREATE UNIQUE INDEX usage_turn_once
  ON usage_records (thread_id, turn_id) WHERE turn_id IS NOT NULL;
CREATE INDEX usage_project_task ON usage_records (project_id, task_id, captured_at);
`;

// v6 makes change, Git, and restore evidence durable. A change set is the
// engine's own turn receipt projected locally; files keep the engine's source
// and restore point so a revert never guesses. Restore and commit receipts make
// the two mutating actions reviewable after the fact. `events.turn_id` lets a
// stored tool item be joined to the turn that recorded it without re-parsing
// the envelope.
const V6 = `
ALTER TABLE events ADD COLUMN turn_id TEXT;
CREATE INDEX events_turn ON events (thread_id, turn_id);

CREATE TABLE change_sets (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  thread_id         TEXT NOT NULL,
  engine_thread_id  TEXT NOT NULL,
  turn_id           TEXT NOT NULL,
  task_id           TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  state             TEXT NOT NULL CHECK (state IN ('settled', 'pending', 'unavailable')),
  reason            TEXT,
  pre_snapshot_id   TEXT,
  post_snapshot_id  TEXT,
  origin            TEXT NOT NULL CHECK (origin IN ('engine', 'turn.artifacts', 'turn.completed')),
  evidence_rank     INTEGER NOT NULL DEFAULT 0 CHECK (evidence_rank >= 0),
  truncated         INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
  omitted           INTEGER,
  note              TEXT,
  captured_at       TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (thread_id, turn_id)
);
CREATE INDEX change_sets_project ON change_sets (project_id, captured_at);

CREATE TABLE change_files (
  change_set_id       TEXT NOT NULL REFERENCES change_sets(id) ON DELETE CASCADE,
  ordinal             INTEGER NOT NULL CHECK (ordinal >= 0),
  path                TEXT NOT NULL,
  previous_path       TEXT,
  kind                TEXT NOT NULL CHECK (kind IN ('file', 'tool_output', 'media')),
  artifact_id         TEXT,
  change              TEXT NOT NULL CHECK (change IN ('created', 'updated', 'deleted', 'renamed', 'unknown')),
  source              TEXT NOT NULL CHECK (source IN (
                        'tool_mutation', 'tool_output_spill',
                        'tool_media', 'workspace_changed_during_turn')),
  tool_name           TEXT,
  tool_call_id        TEXT,
  item_id             TEXT,
  size_bytes          INTEGER CHECK (size_bytes IS NULL OR size_bytes >= 0),
  revision            TEXT,
  restore_snapshot_id TEXT,
  PRIMARY KEY (change_set_id, ordinal)
);
CREATE INDEX change_files_path ON change_files (path);

CREATE TABLE restore_receipts (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  change_set_id   TEXT REFERENCES change_sets(id) ON DELETE SET NULL,
  thread_id       TEXT NOT NULL,
  turn_id         TEXT NOT NULL,
  path            TEXT NOT NULL,
  action          TEXT NOT NULL,
  snapshot_id     TEXT NOT NULL,
  snapshot_label  TEXT,
  expected_hash   TEXT NOT NULL,
  before_revision TEXT,
  after_revision  TEXT,
  outcome         TEXT NOT NULL CHECK (outcome IN ('restored', 'failed')),
  note            TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX restore_receipts_project ON restore_receipts (project_id, created_at);

CREATE TABLE commit_receipts (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  commit_hash TEXT NOT NULL,
  short_hash  TEXT NOT NULL,
  subject     TEXT NOT NULL,
  paths_json  TEXT NOT NULL,
  message     TEXT NOT NULL,
  note        TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX commit_receipts_project ON commit_receipts (project_id, created_at);
`;

// v7 keeps the observatory honest across a disconnect and records which engine
// run a native workflow started for a Mona task. Rows are bounded projections,
// not a competing transcript: prompts, tool output, and artifacts stay with the
// engine. `task_runs.upstream_id` is the one-scheduler link: a task run started
// by a native fleet records the engine run that owns its dispatch.
const V7 = `
ALTER TABLE task_runs ADD COLUMN upstream_kind TEXT;
ALTER TABLE task_runs ADD COLUMN upstream_id TEXT;
CREATE UNIQUE INDEX task_runs_upstream
  ON task_runs (upstream_kind, upstream_id) WHERE upstream_id IS NOT NULL;

CREATE TABLE orchestration_runs (
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL
                      CHECK (kind IN ('agent_run', 'fleet_run', 'fleet_worker')),
  upstream_id         TEXT NOT NULL CHECK (length(upstream_id) BETWEEN 1 AND 200),
  parent_upstream_id  TEXT,
  label               TEXT NOT NULL CHECK (length(label) <= 300),
  status              TEXT NOT NULL CHECK (length(status) <= 80),
  workspace           TEXT,
  branch              TEXT,
  task_id             TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  started_at          TEXT,
  updated_at          TEXT,
  last_seen_at        TEXT NOT NULL,
  terminal            INTEGER NOT NULL DEFAULT 0 CHECK (terminal IN (0, 1)),
  detail_json         TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (project_id, kind, upstream_id)
);
CREATE INDEX orchestration_runs_project
  ON orchestration_runs (project_id, last_seen_at DESC);

CREATE TABLE goal_observations (
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  thread_id           TEXT NOT NULL,
  goal_id             TEXT,
  objective           TEXT NOT NULL,
  status              TEXT NOT NULL,
  tokens_used         INTEGER,
  time_used_seconds   INTEGER,
  continuation_count  INTEGER,
  repeated_gap_count  INTEGER,
  engine_created_at   TEXT,
  engine_updated_at   TEXT,
  observed_at         TEXT NOT NULL,
  PRIMARY KEY (project_id, thread_id)
);

CREATE TABLE orchestration_events (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  action      TEXT NOT NULL,
  upstream_id TEXT,
  accepted    INTEGER NOT NULL CHECK (accepted IN (0, 1)),
  status      INTEGER,
  message     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX orchestration_events_project
  ON orchestration_events (project_id, created_at);
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "core-project-state", sql: V1 },
  { version: 2, name: "project-identity-fields", sql: V2 },
  { version: 3, name: "task-board-and-continuity", sql: V3 },
  { version: 4, name: "attempt-ledger-and-boundaries", sql: V4 },
  { version: 5, name: "cost-ledger-rates-and-budgets", sql: V5 },
  { version: 6, name: "change-receipts-git-and-restore", sql: V6 },
  { version: 7, name: "orchestration-observations-and-receipts", sql: V7 },
];

export const CURRENT_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

export const REQUIRED_TABLES: readonly string[] = [
  "artifacts",
  "attempts",
  "budgets",
  "capability_snapshots",
  "change_files",
  "change_sets",
  "commit_receipts",
  "cost_thread_marks",
  "decisions",
  "drafts",
  "event_cursors",
  "events",
  "goal_observations",
  "meta",
  "orchestration_events",
  "orchestration_runs",
  "problem_events",
  "problems",
  "project_paths",
  "projects",
  "rate_cards",
  "requirement_evidence",
  "restore_receipts",
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
const V4_TABLES: readonly string[] = ["problem_events", "problems"];
const V5_TABLES: readonly string[] = ["budgets", "cost_thread_marks", "rate_cards"];
const V6_TABLES: readonly string[] = [
  "change_files",
  "change_sets",
  "commit_receipts",
  "restore_receipts",
];
const V7_TABLES: readonly string[] = [
  "goal_observations",
  "orchestration_events",
  "orchestration_runs",
];

/** Tables a database at `version` must have. Older targets predate v3–v7. */
export function requiredTablesFor(version: number): readonly string[] {
  let tables: readonly string[] = REQUIRED_TABLES;
  if (version < 7) tables = tables.filter((t) => !V7_TABLES.includes(t));
  if (version < 6) tables = tables.filter((t) => !V6_TABLES.includes(t));
  if (version < 5) tables = tables.filter((t) => !V5_TABLES.includes(t));
  if (version < 4) tables = tables.filter((t) => !V4_TABLES.includes(t));
  if (version < 3) tables = tables.filter((t) => !V3_TABLES.includes(t));
  return tables;
}

export function migrationChecksum(migration: Migration): string {
  return createHash("sha256")
    .update(String(migration.version))
    .update("\0")
    .update(migration.sql)
    .digest("hex");
}
