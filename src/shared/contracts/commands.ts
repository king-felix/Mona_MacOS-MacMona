import { z } from "zod";

/**
 * R03 — the Codewhale slash-command catalog.
 *
 * The rows are the engine's own answer to `GET /v1/commands` on the pinned
 * 0.10.2 build. The curated annotation says what the command does and which
 * route could execute it; it does not claim Mona has wired that route yet.
 * R04 owns execution. Autocomplete, filtering, and help are local reads and
 * never start a runtime or ask a model.
 */

export const COMMAND_DISCOVERY = ["primary", "advanced", "compatibility"] as const;
export type CommandDiscovery = (typeof COMMAND_DISCOVERY)[number];

export const COMMAND_BINDINGS = ["host", "prompt"] as const;
export type CommandBinding = (typeof COMMAND_BINDINGS)[number];

export const COMMAND_SCOPES = [
  "ui",
  "session",
  "thread",
  "workspace",
  "project",
  "engine",
  "account",
] as const;
export type CommandScope = (typeof COMMAND_SCOPES)[number];

export const COMMAND_SIDE_EFFECTS = [
  "none",
  "ui-only",
  "session-state",
  "thread-state",
  "workspace-write",
  "config-write",
  "credential-change",
  "permission-change",
  "network",
  "process-spawn",
  "destructive",
  "spend",
] as const;
export type CommandSideEffect = (typeof COMMAND_SIDE_EFFECTS)[number];

export const COMMAND_COST_CLASSES = ["none", "may-spend", "unknown"] as const;
export type CommandCostClass = (typeof COMMAND_COST_CLASSES)[number];

/**
 * The route a row would need. `runtime-api` names documented `/v1` operations
 * that R04 may call; `tui-local` means only the TUI implements it; `unavailable`
 * means this engine version exposes no route at all.
 */
export const COMMAND_SUPPORT = ["runtime-api", "terminal-only", "unavailable"] as const;
export type CommandSupport = (typeof COMMAND_SUPPORT)[number];

export const CommandRouteSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("runtime-api"),
    endpoints: z.array(z.string().min(1).startsWith("/v1/")).min(1),
  }),
  z.strictObject({
    kind: z.literal("tui-local"),
    note: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("unavailable"),
    note: z.string().min(1),
  }),
]);
export type CommandRoute = z.infer<typeof CommandRouteSchema>;

export const CommandAnnotationSchema = z.strictObject({
  scope: z.enum(COMMAND_SCOPES),
  sideEffects: z.array(z.enum(COMMAND_SIDE_EFFECTS)).min(1),
  cost: z.enum(COMMAND_COST_CLASSES),
  support: z.enum(COMMAND_SUPPORT),
  route: CommandRouteSchema,
  notes: z.string().min(1).optional(),
});
export type CommandAnnotation = z.infer<typeof CommandAnnotationSchema>;

/** One generated engine row; shape mirrors GET /v1/commands. */
export const EngineCommandSchema = z.strictObject({
  name: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  summary: z.string().min(1),
  usage: z.string().min(1),
  subcommands: z.array(z.string()).default([]),
  takesArguments: z.boolean(),
  requiresArgument: z.boolean(),
  requiresRequiredArgument: z.boolean(),
  composerWantsTrailingSpace: z.boolean(),
  paletteRunsDirectly: z.boolean(),
  showInEmptyDiscovery: z.boolean(),
  discovery: z.enum(COMMAND_DISCOVERY),
  hidden: z.boolean(),
  binding: z.enum(COMMAND_BINDINGS),
  kind: z.enum(["builtin", "user"]),
});
export type EngineCommand = z.infer<typeof EngineCommandSchema>;

export const CommandProvenanceSchema = z.strictObject({
  engine: z.string().min(1),
  version: z.string().min(1),
  commit: z.string().regex(/^[a-f0-9]{7,40}$/),
  binarySha256: z.string().regex(/^[a-f0-9]{64}$/),
  install: z.string().min(1),
  repository: z.string().url(),
  versionLine: z.string().min(1),
  endpoint: z.string().min(1),
  capturedAt: z.string().min(20),
  capturePath: z.string().min(1),
  captureSha256: z.string().regex(/^[a-f0-9]{64}$/),
  generator: z.string().min(1),
  note: z.string().min(1),
});
export type CommandProvenance = z.infer<typeof CommandProvenanceSchema>;

export const PinnedCommandFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  provenance: CommandProvenanceSchema,
  commands: z.array(EngineCommandSchema).min(1),
});
export type PinnedCommandFile = z.infer<typeof PinnedCommandFileSchema>;

export const CommandAnnotationFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  basis: z.string().min(1),
  entries: z.record(z.string(), CommandAnnotationSchema),
});
export type CommandAnnotationFile = z.infer<typeof CommandAnnotationFileSchema>;

/** One catalog row as the renderer consumes it: engine facts + annotation. */
export const CommandCatalogEntrySchema = EngineCommandSchema.extend({
  annotation: CommandAnnotationSchema,
});
export type CommandCatalogEntry = z.infer<typeof CommandCatalogEntrySchema>;

export const CommandCatalogStatsSchema = z.strictObject({
  total: z.number().int().min(0),
  runtimeApi: z.number().int().min(0),
  terminalOnly: z.number().int().min(0),
  unavailable: z.number().int().min(0),
  hidden: z.number().int().min(0),
});
export type CommandCatalogStats = z.infer<typeof CommandCatalogStatsSchema>;

/** The validated snapshot main hands to the renderer. */
export const CommandCatalogSnapshotSchema = z.strictObject({
  provenance: CommandProvenanceSchema,
  commands: z.array(CommandCatalogEntrySchema),
  stats: CommandCatalogStatsSchema,
});
export type CommandCatalogSnapshot = z.infer<typeof CommandCatalogSnapshotSchema>;
