import { FIXTURE_LABEL } from "../../shared/fixtures";
import type { WorkStatus } from "./primitives";

/**
 * Labeled fixture data for the P06 visual harness. It is never a production
 * fallback: the harness banner states that nothing here is live state, and P07
 * replaces the fixture screens with the real catalog, runtime, and work.
 */
export const HARNESS_LABEL = FIXTURE_LABEL;

export type ProjectAccent = "violet" | "mint" | "coral" | "amber" | "indigo";

export interface FixtureProject {
  id: string;
  name: string;
  monogram: string;
  accent: ProjectAccent;
  path: string;
  branch: string;
  health: "ready" | "disconnected" | "missing-runtime" | "missing-credentials";
  pinned: boolean;
  archived: boolean;
  lastActive: string;
}

export const fixtureProjects: FixtureProject[] = [
  {
    id: "prj_harness0001",
    name: "Mona",
    monogram: "MO",
    accent: "violet",
    path: "/Users/example/Projects/Mona",
    branch: "main",
    health: "ready",
    pinned: true,
    archived: false,
    lastActive: "12 minutes ago",
  },
  {
    id: "prj_harness0002",
    name: "Aurora data platform with a deliberately long repository name",
    monogram: "AU",
    accent: "mint",
    path: "/Users/example/Projects/clients/aurora-platform/packages/desktop/native/services",
    branch: "feature/finder-service-hardening",
    health: "missing-runtime",
    pinned: true,
    archived: false,
    lastActive: "Yesterday",
  },
  {
    id: "prj_harness0003",
    name: "Tidal notes",
    monogram: "TI",
    accent: "coral",
    path: "/Users/example/Projects/experiments/tidal-notes-worktree",
    branch: "worktree/tidal-notes",
    health: "disconnected",
    pinned: false,
    archived: false,
    lastActive: "3 days ago",
  },
  {
    id: "prj_harness0004",
    name: "Hexagon inventory",
    monogram: "HE",
    accent: "amber",
    path: "/Users/example/Projects/clients/hexagon",
    branch: "release/2026.11",
    health: "missing-credentials",
    pinned: false,
    archived: false,
    lastActive: "2 weeks ago",
  },
  {
    id: "prj_harness0005",
    name: "Old sketchbook",
    monogram: "OS",
    accent: "indigo",
    path: "/Users/example/Projects/archive/old-sketchbook",
    branch: "main",
    health: "disconnected",
    pinned: false,
    archived: true,
    lastActive: "May 2025",
  },
];

export interface FixtureTask {
  id: string;
  title: string;
  status: WorkStatus;
  requirements: string[];
  dependsOn: string[];
  updatedAt: string;
  note?: string;
}

export const fixtureTasks: FixtureTask[] = [
  {
    id: "tsk_harness0001",
    title: "Transactional project state and safe migrations",
    status: "completed",
    requirements: ["MONA-005", "MONA-010", "MONA-016", "MONA-025"],
    dependsOn: [],
    updatedAt: "Today, 11:42",
    note: "Crash injection and migration restore verified.",
  },
  {
    id: "tsk_harness0002",
    title: "Design system and accessible screens",
    status: "running",
    requirements: ["MONA-006", "MONA-029", "MAC-002"],
    dependsOn: ["tsk_harness0001"],
    updatedAt: "Today, 11:58",
    note: "Contrast measured; screenshots pending.",
  },
  {
    id: "tsk_harness0003",
    title:
      "Assemble the project catalog and desktop shell with a name long enough to require wrapping in every layout",
    status: "pending",
    requirements: ["MONA-005", "MONA-006", "MONA-029"],
    dependsOn: ["tsk_harness0002"],
    updatedAt: "Not started",
  },
  {
    id: "tsk_harness0004",
    title: "Live work studio",
    status: "blocked",
    requirements: ["MONA-007", "MONA-008", "MONA-012", "MONA-014"],
    dependsOn: ["tsk_harness0003"],
    updatedAt: "Today, 09:20",
    note: "Waiting on the catalog before wiring the adapter.",
  },
  {
    id: "tsk_harness0005",
    title: "Finder Service, folder drop and native launch",
    status: "pending",
    requirements: ["MONA-004", "MAC-002"],
    dependsOn: ["tsk_harness0003"],
    updatedAt: "Not started",
  },
  {
    id: "tsk_harness0006",
    title: "Cost lens with unknown-price handling",
    status: "interrupted",
    requirements: ["MONA-013"],
    dependsOn: [],
    updatedAt: "Yesterday, 18:04",
    note: "Interrupted by app quit; reconciliation is required before resuming.",
  },
];

export type EventKind = "user" | "assistant" | "tool" | "test" | "status" | "error";

export interface FixtureEvent {
  id: string;
  kind: EventKind;
  title: string;
  body?: string;
  detail?: string;
  at: string;
}

const EVENT_SEED: Array<Omit<FixtureEvent, "id" | "at">> = [
  {
    kind: "user",
    title: "Resume the interrupted work",
    body: "Continue P05 from the checkpoint. Do not replay a possibly executed turn.",
  },
  {
    kind: "status",
    title: "Reconciling submission",
    body: "Outcome unknown — reading thread history, not resending.",
  },
  {
    kind: "assistant",
    title: "Reading the checkpoint and working tree",
    detail: "state.json · HANDOFF.md · git status",
  },
  {
    kind: "tool",
    title: "Read src/main/state/store.ts",
    detail: "1,904 lines · unchanged since checkpoint",
  },
  {
    kind: "assistant",
    title: "Narrowing the migration failure test",
    body: "The rollback path is exercised only when validation fails after commit.",
  },
  {
    kind: "tool",
    title: "Run vitest state-database",
    detail: "12 tests · all passing",
  },
  {
    kind: "test",
    title: "Crash injection passed",
    detail: "before / during / after transaction · integrity ok",
  },
  {
    kind: "status",
    title: "Checkpoint written",
    body: "Revision 59 · evidence refreshed",
  },
  {
    kind: "user",
    title: "Show the recovery evidence",
  },
  {
    kind: "assistant",
    title: "Opening docs/evidence/macos/P05-state.md",
    detail: "evidence-linked completion card",
  },
  {
    kind: "error",
    title: "A stale revision write was refused",
    body: "The project changed since it was read. Nothing was overwritten.",
  },
  {
    kind: "assistant",
    title: "Re-reading the project before writing",
    body: "Two readers, one writer; the next update carries the current revision.",
  },
  {
    kind: "tool",
    title: "Read src/main/state/portable.ts",
    detail: "digest validation · referential checks",
  },
  {
    kind: "assistant",
    title: "Import refused an older bundle",
    body: "Rolling state back without an explicit decision is not allowed.",
  },
  {
    kind: "test",
    title: "Contrast audit passed",
    detail: "23 pairs × 2 themes · WCAG AA",
  },
  {
    kind: "status",
    title: "Engine disconnected",
    body: "History and settings stay usable; execution is paused.",
  },
  {
    kind: "tool",
    title: "Read native/macos-supervisor/main.swift",
    detail: "descendant sampling · ownership liveness",
  },
  {
    kind: "assistant",
    title: "Explaining the stop receipt",
    body: "“Stopped” is only claimed when the supervisor proves the tree is gone.",
  },
  {
    kind: "test",
    title: "Electron smoke passed",
    detail: "21/21 checks · state database open",
  },
  {
    kind: "user",
    title: "Pause after this task",
  },
  {
    kind: "status",
    title: "Pause requested at the next task boundary",
    body: "The active turn was not interrupted.",
  },
  {
    kind: "assistant",
    title: "Drafting the handoff",
    detail: "next exact action · nonblocking issues",
  },
  {
    kind: "tool",
    title: "Wrote .mona/build-macos/HANDOFF.md",
    detail: "revision 59",
  },
  {
    kind: "status",
    title: "Zero inference in navigation",
    body: "Every summary on this screen is deterministic local state.",
  },
];

export const fixtureEvents: FixtureEvent[] = Array.from({ length: 40 }, (_, index) => {
  const seed = EVENT_SEED[index % EVENT_SEED.length] ?? EVENT_SEED[0]!;
  const minute = 12 + index;
  return {
    ...seed,
    id: `evt_${String(index + 1).padStart(4, "0")}`,
    at: `${String(Math.floor(minute / 60) + 9).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`,
  };
});

export interface FixtureUsageRow {
  model: string;
  turns: number;
  inputTokens: number;
  cachedTokens: number | null;
  costUsd: number | null;
  costComplete: boolean;
}

export const fixtureUsage: FixtureUsageRow[] = [
  {
    model: "deepseek-flash",
    turns: 18,
    inputTokens: 412_800,
    cachedTokens: 188_400,
    costUsd: 0.42,
    costComplete: true,
  },
  {
    model: "deepseek-chat",
    turns: 3,
    inputTokens: 96_200,
    cachedTokens: null,
    costUsd: null,
    costComplete: false,
  },
  {
    model: "unknown local route",
    turns: 1,
    inputTokens: 4_100,
    cachedTokens: null,
    costUsd: null,
    costComplete: false,
  },
];

export interface FixtureAttempt {
  number: number;
  hypothesis: string;
  action: string;
  observed: string;
  progress: boolean;
  evidence: string;
}

export const fixtureAttempts: FixtureAttempt[] = [
  {
    number: 1,
    hypothesis: "The supervisor is stopped by killing only its child pid.",
    action: "Sent TERM to the engine child and sampled the process tree.",
    observed: "The grandchild survived and was reparented to launchd.",
    progress: false,
    evidence: "docs/evidence/macos/artifacts/p04-tree-before.txt",
  },
  {
    number: 2,
    hypothesis: "Process groups alone are sufficient.",
    action: "Spawned the engine in its own group and killed the group.",
    observed: "A double-forked helper escaped the group and kept the port.",
    progress: false,
    evidence: "docs/evidence/macos/artifacts/p04-escaped-group.txt",
  },
  {
    number: 3,
    hypothesis: "Sample descendants by (pid, start time) before stopping.",
    action: "Implemented native sampling and verified stop receipts.",
    observed: "The escaped helper was found and stopped; survivors list empty.",
    progress: true,
    evidence: "docs/evidence/macos/artifacts/p04-stop-receipt.json",
  },
];

export const fixtureBlocker = {
  problemId: "P05-MIGRATION",
  title: "A migration that commits a damaged schema cannot roll back by itself.",
  requirement: "MONA-025",
  impact: "Project state may fail to open after an upgrade.",
  attempts: fixtureAttempts,
  affected: ["MONA-010", "MONA-016", "MONA-025"],
  helpNeeded:
    "Confirm that restoring the pre-migration snapshot is acceptable even when the new schema committed successfully.",
  evidence: "docs/evidence/macos/P05-state.md",
};

export const fixtureRequirements = [
  { id: "MONA-005", title: "Project catalog", status: "partial" as const },
  { id: "MONA-006", title: "Accessible shell and themes", status: "partial" as const },
  { id: "MONA-010", title: "Durable state and traceability", status: "partial" as const },
  { id: "MONA-016", title: "Crash and reconnect recovery", status: "partial" as const },
  { id: "MAC-002", title: "Finder, keyboard and VoiceOver", status: "pending" as const },
];

export const fixtureRoute = {
  provider: "deepseek",
  model: "deepseek-flash",
  reasoning: "medium",
  permission: "Full Access",
  profile: "DS Full Access",
  endpoint: "https://api.deepseek.com",
  keySource: "engine credential store",
};

export const fixtureSettings = {
  supportPath: "/Users/example/Library/Application Support/Mona",
  databasePath: "/Users/example/Library/Application Support/Mona/state/mona.sqlite",
  runtimePath: "/opt/homebrew/bin/codewhale",
  engineVersion: "0.10.2",
  engineCommit: "ff466b2ed0bf",
  telemetry: "off",
};
