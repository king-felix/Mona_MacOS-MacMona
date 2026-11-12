import { z } from "zod";

/**
 * P18 — capability coverage contracts.
 *
 * A row is a claim about one discovered engine capability: what it is, where it
 * lives, what it costs, how Mona reaches it, and whether that path was actually
 * exercised. The explorer renders the row as reported; when an entry point does
 * not exist, the row says so and names the verified advanced or terminal route
 * instead of pointing at a dead control.
 */

export const CAPABILITY_STATUSES = [
  "verified",
  "unqualified",
  "unavailable",
  "blocked_gap",
] as const;
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

export const CAPABILITY_INTEGRATIONS = [
  "native_view",
  "advanced_action",
  "integrated_terminal",
  "unavailable",
  "blocked_gap",
] as const;
export type CapabilityIntegration = (typeof CAPABILITY_INTEGRATIONS)[number];

export const CAPABILITY_CLASSIFICATIONS = ["read", "write", "destructive"] as const;
export type CapabilityClassification = (typeof CAPABILITY_CLASSIFICATIONS)[number];

/** Where a row can be opened in Mona. `none` is honest, not a broken button. */
export const CAPABILITY_ENTRY_KINDS = [
  "screen",
  "settings_tab",
  "palette",
  "terminal",
  "none",
] as const;
export type CapabilityEntryKind = (typeof CAPABILITY_ENTRY_KINDS)[number];

/** The screens this build renders. An entry point naming anything else is dead. */
export const CAPABILITY_SCREEN_TARGETS = [
  "home",
  "studio",
  "board",
  "changes",
  "cost",
  "settings",
  "agents",
  "capabilities",
] as const;

/** The Settings tabs this build renders. */
export const CAPABILITY_SETTINGS_TABS = [
  "appearance",
  "attention",
  "data",
  "route",
  "extensions",
  "runtime",
  "finder",
  "privacy",
  "recovery",
] as const;

/** Terminal modes the panel offers. */
export const CAPABILITY_TERMINAL_TARGETS = ["shell", "log"] as const;

export interface CapabilityEntryPoint {
  kind: CapabilityEntryKind;
  /** Screen id, settings tab id, terminal mode, or null for `none`. */
  target: string | null;
  label: string;
  /** True when the entry point itself was exercised by a test or smoke. */
  tested: boolean;
}

export interface CapabilityRowView {
  id: string;
  name: string;
  description: string;
  scope: string;
  upstreamSource: string;
  upstreamVersion: string;
  platform: string;
  classification: CapabilityClassification;
  permission: string;
  /** Cost class shown before any invocation. */
  cost: string;
  arguments: string;
  /** The exact route: a CLI invocation, an HTTP route, or a native surface. */
  invocation: string;
  helpSource: string;
  integration: CapabilityIntegration;
  entryPoint: CapabilityEntryPoint;
  uiLocation: string;
  tests: string;
  status: CapabilityStatus;
  gap: string | null;
  evidence: string[];
}

export interface CapabilityGapView {
  id: string;
  name: string;
  status: CapabilityStatus;
  reason: string;
}

export interface CapabilityCoverage {
  rowsTotal: number;
  verified: number;
  unqualified: number;
  unavailable: number;
  blockedGaps: number;
  /** Rows with a real in-app entry point (screen, tab, palette, terminal). */
  withEntryPoint: number;
  /** Rows whose entry point was exercised. */
  testedEntryPoint: number;
  byEntryKind: Record<string, number>;
  /** Rows that only reach the terminal; not native controls. */
  terminalOnly: number;
  nativeControls: number;
  advancedActions: number;
  /** True only when every row is verified and no gap remains. */
  complete: boolean;
  gaps: CapabilityGapView[];
  summary: string;
}

export interface CapabilityDrift {
  checked: boolean;
  checkedAt: string | null;
  error: string | null;
  engineVersion: string | null;
  engineCommit: string | null;
  inventoryVersion: string;
  inventoryCommit: string;
  versionMatch: boolean;
  commitMatch: boolean;
  /** Commands the installed help prints that no inventory row names. */
  additions: Array<{ name: string; note: string }>;
  /** Inventory rows whose upstream command the installed help no longer lists. */
  removals: Array<{ name: string; note: string }>;
  note: string;
}

export interface CapabilitySnapshot {
  source: "live" | "stored";
  unavailableReason: string | null;
  /** Redacted path of the inventory file that was read. */
  inventoryPath: string | null;
  loadedAt: string;
  rows: CapabilityRowView[];
  coverage: CapabilityCoverage;
  drift: CapabilityDrift;
  /** Engine feature flags as reported by `/v1/runtime/info`, when connected. */
  engineCapabilities: Record<string, boolean> | null;
  /** Feature flags printed by the installed engine's own `features list`. */
  features: Array<{ name: string; stage: string; enabled: boolean }>;
  notes: string[];
}

/** True when the entry point names a target this build actually renders. */
export function entryTargetIsKnown(entry: CapabilityEntryPoint): boolean {
  if (entry.kind === "none") return true;
  if (entry.target === null) return false;
  if (entry.kind === "screen") {
    return (CAPABILITY_SCREEN_TARGETS as readonly string[]).includes(entry.target);
  }
  if (entry.kind === "settings_tab") {
    return (CAPABILITY_SETTINGS_TABS as readonly string[]).includes(entry.target);
  }
  if (entry.kind === "terminal") {
    return (CAPABILITY_TERMINAL_TARGETS as readonly string[]).includes(entry.target);
  }
  return false;
}

export const CAPABILITY_STATUS_SCHEMA = z.enum(CAPABILITY_STATUSES);
export const CAPABILITY_INTEGRATION_SCHEMA = z.enum(CAPABILITY_INTEGRATIONS);
export const CAPABILITY_CLASSIFICATION_SCHEMA = z.enum(CAPABILITY_CLASSIFICATIONS);

export const CapabilityRowSchema = z.strictObject({
  mona_id: z.string().regex(/^MONA-CAP-\d{3}$/),
  upstream_name: z.string().min(1).max(200),
  upstream_source: z.string().min(1).max(400),
  upstream_version: z.string().min(1).max(64),
  platform: z.string().min(1).max(200),
  classification: CAPABILITY_CLASSIFICATION_SCHEMA,
  permission_implications: z.string().min(1).max(1000),
  cost_implications: z.string().min(1).max(1000),
  required_arguments: z.string().min(1).max(1000),
  integration: CAPABILITY_INTEGRATION_SCHEMA,
  entry_point: z.strictObject({
    kind: z.enum(CAPABILITY_ENTRY_KINDS),
    target: z.string().min(1).max(100).nullable(),
    label: z.string().min(1).max(200),
    tested: z.boolean(),
  }),
  ui_location: z.string().min(1).max(300),
  tests: z.string().min(1).max(2000),
  status: CAPABILITY_STATUS_SCHEMA,
  gap: z.string().min(1).max(4000).nullable(),
  description: z.string().min(1).max(2000),
  scope: z.string().min(1).max(100),
  invocation: z.string().min(1).max(600),
  help_source: z.string().min(1).max(600),
  evidence: z.array(z.string().min(1).max(500)).max(20).optional(),
});

export const CapabilityInventorySchema = z.strictObject({
  schema_version: z.number().int().min(1),
  status: z.string().min(1).max(100),
  note: z.string().max(20_000),
  engine: z
    .object({
      name: z.string(),
      version: z.string(),
      commit: z.string(),
    })
    .passthrough(),
  transports_observed: z.array(z.unknown()).max(50),
  capability_row_contract: z
    .object({
      fields: z.array(z.string()).max(60),
      classification_enum: z.array(z.string()).max(10),
      integration_enum: z.array(z.string()).max(10),
      status_enum: z.array(z.string()).max(10),
    })
    .passthrough(),
  capabilities: z.array(CapabilityRowSchema).min(1).max(500),
  coverage: z.strictObject({
    rows_total: z.number().int().min(0),
    verified: z.number().int().min(0),
    unqualified: z.number().int().min(0),
    unavailable: z.number().int().min(0),
    blocked_gaps: z.number().int().min(0),
    with_entry_point: z.number().int().min(0),
    tested_entry_point: z.number().int().min(0),
    by_integration: z.record(z.string().max(40), z.number().int().min(0)),
    by_entry_kind: z.record(z.string().max(40), z.number().int().min(0)),
    complete: z.boolean(),
    gaps: z.array(
      z.strictObject({
        mona_id: z.string().max(40),
        upstream_name: z.string().max(200),
        status: z.string().max(40),
        reason: z.string().max(4000),
      }),
    ),
    summary: z.string().max(4000),
    assessed_utc: z.string().min(1).max(64),
  }),
});

export type CapabilityInventory = z.infer<typeof CapabilityInventorySchema>;
export type CapabilityInventoryRow = z.infer<typeof CapabilityRowSchema>;
