import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  CapabilityInventorySchema,
  type CapabilityCoverage,
  type CapabilityDrift,
  type CapabilityInventory,
  type CapabilityRowView,
  type CapabilitySnapshot,
  type CapabilityStatus,
} from "../../shared/contracts/capability";
import type { StateStore } from "../state/store";
import { discoverTool } from "../tool-discovery";

const HOME = homedir();
const CACHE_SCOPE = "capabilities:snapshot";
const PROBE_TIMEOUT_MS = 4_000;
const MAX_PROBE_BYTES = 512 * 1024;

export interface CapabilityEngineAccess {
  /** `/v1/runtime/info` capabilities, already read by the caller. */
  capabilities: Record<string, boolean> | null;
}

export interface CapabilityExplorerOptions {
  store: StateStore;
  /** Optional: inventory path override (tests, packaging). */
  inventoryPath?: string;
  /** Optional: live engine feature flags for the current project. */
  engine?: () => CapabilityEngineAccess | null;
  probeBinary?: string;
  now?: () => Date;
}

export class CapabilityError extends Error {
  constructor(
    readonly code: "INVENTORY_UNAVAILABLE" | "INVENTORY_INVALID",
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "CapabilityError";
  }
}

function redactPath(path: string): string {
  return path.startsWith(HOME) ? `~${path.slice(HOME.length)}` : path;
}

/** Find the checked-in inventory in a dev checkout or a packaged resource bundle. */
export function resolveInventoryPath(explicitPath?: string): string {
  const candidates: string[] = [];
  if (explicitPath) candidates.push(explicitPath);
  if (process.env.MONA_CAPABILITIES_FILE) candidates.push(process.env.MONA_CAPABILITIES_FILE);
  if (process.resourcesPath) {
    candidates.push(resolve(process.resourcesPath, "docs/codewhale-capabilities-macos.json"));
  }
  let directory = __dirname;
  for (let depth = 0; depth < 7; depth += 1) {
    candidates.push(resolve(directory, "docs/codewhale-capabilities-macos.json"));
    directory = resolve(directory, "..");
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new CapabilityError(
    "INVENTORY_UNAVAILABLE",
    "the capability inventory file was not found",
    { searched: candidates },
  );
}

export function loadInventory(path: string): CapabilityInventory {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new CapabilityError(
      "INVENTORY_INVALID",
      `the capability inventory is not readable JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const result = CapabilityInventorySchema.safeParse(parsed);
  if (!result.success) {
    const summary = result.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new CapabilityError(
      "INVENTORY_INVALID",
      `the capability inventory does not match the contract: ${summary}`,
      { issues: result.error.issues.slice(0, 10) },
    );
  }
  return result.data;
}

export function toRowView(row: CapabilityInventory["capabilities"][number]): CapabilityRowView {
  return {
    id: row.mona_id,
    name: row.upstream_name,
    description: row.description,
    scope: row.scope,
    upstreamSource: row.upstream_source,
    upstreamVersion: row.upstream_version,
    platform: row.platform,
    classification: row.classification,
    permission: row.permission_implications,
    cost: row.cost_implications,
    arguments: row.required_arguments,
    invocation: row.invocation,
    helpSource: row.help_source,
    integration: row.integration,
    entryPoint: row.entry_point,
    uiLocation: row.ui_location,
    tests: row.tests,
    status: row.status,
    gap: row.gap,
    evidence: row.evidence ?? [],
  };
}

/**
 * Coverage is computed from the rows. The file's own numbers are compared, not
 * trusted, so an edited summary cannot hide a row.
 */
export function computeCoverage(rows: CapabilityRowView[]): CapabilityCoverage {
  const count = (predicate: (row: CapabilityRowView) => boolean): number =>
    rows.filter(predicate).length;
  const status = (value: CapabilityStatus): number => count((row) => row.status === value);
  const byEntryKind: Record<string, number> = {};
  for (const row of rows) {
    byEntryKind[row.entryPoint.kind] = (byEntryKind[row.entryPoint.kind] ?? 0) + 1;
  }
  const gaps = rows
    .filter((row) => row.status !== "verified")
    .map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status,
      reason: row.gap ?? "no reason recorded",
    }));
  const verified = status("verified");
  return {
    rowsTotal: rows.length,
    verified,
    unqualified: status("unqualified"),
    unavailable: status("unavailable"),
    blockedGaps: status("blocked_gap"),
    withEntryPoint: count((row) => row.entryPoint.kind !== "none"),
    testedEntryPoint: count((row) => row.entryPoint.tested),
    byEntryKind,
    terminalOnly: count((row) => row.entryPoint.kind === "terminal"),
    nativeControls: count((row) => row.integration === "native_view"),
    advancedActions: count((row) => row.integration === "advanced_action"),
    complete: verified === rows.length,
    gaps,
    summary:
      `${rows.length} discovered rows: ${verified} verified, ${status("unqualified")} open, ` +
      `${status("blocked_gap")} blocked gaps, ${status("unavailable")} unavailable. ` +
      `${count((row) => row.entryPoint.tested)} entry points exercised. ` +
      "Full parity is not claimed while any row is open or blocked.",
  };
}

interface CliProbe {
  probedAt: string;
  version: string | null;
  commit: string | null;
  commands: Array<{ name: string; summary: string }>;
  features: Array<{ name: string; stage: string; enabled: boolean }>;
  error: string | null;
}

function runProbe(
  binary: string,
  args: string[],
): Promise<{ stdout: string; error: string | null }> {
  return new Promise((resolvePromise) => {
    execFile(
      binary,
      args,
      {
        timeout: PROBE_TIMEOUT_MS,
        maxBuffer: MAX_PROBE_BYTES,
        windowsHide: true,
        // A read-only probe needs no secrets: PATH to resolve helpers, HOME for
        // the engine's own config. Nothing else from Mona's environment.
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: process.env.HOME ?? "",
        },
      },
      (error, stdout) => {
        if (error) {
          resolvePromise({ stdout: stdout ?? "", error: error.message });
          return;
        }
        resolvePromise({ stdout: stdout ?? "", error: null });
      },
    );
  });
}

export function parseVersion(text: string): { version: string | null; commit: string | null } {
  const match = /codewhale\s+([0-9][^\s(]*)(?:\s+\(([0-9a-f]{6,40})\))?/i.exec(text);
  return { version: match?.[1] ?? null, commit: match?.[2] ?? null };
}

export function parseCommandList(text: string): Array<{ name: string; summary: string }> {
  const section = text.split("Commands:")[1]?.split("\nArguments:")[0] ?? "";
  const commands: Array<{ name: string; summary: string }> = [];
  for (const line of section.split("\n")) {
    const match = /^ {2}([a-z][a-z0-9-]*)\s{2,}(.+)$/.exec(line);
    if (match?.[1] && match[2]) commands.push({ name: match[1], summary: match[2].trim() });
  }
  return commands;
}

export function parseFeatureList(
  text: string,
): Array<{ name: string; stage: string; enabled: boolean }> {
  const features: Array<{ name: string; stage: string; enabled: boolean }> = [];
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 3) continue;
    const [name, stage, enabled] = parts;
    if (!name || name === "feature" || !stage) continue;
    if (!/^(true|false|on|off|enabled|disabled)$/i.test(enabled ?? "")) continue;
    features.push({ name, stage, enabled: /^(true|on|enabled)$/i.test(enabled!) });
  }
  return features;
}

/**
 * Compare what is installed now with what the inventory recorded. Additions and
 * removals are named; an unreachable engine is reported as unchecked, not as a
 * match.
 */
export async function probeDrift(
  rows: CapabilityRowView[],
  inventory: CapabilityInventory,
  options: { binary?: string; now?: () => Date } = {},
): Promise<{ drift: CapabilityDrift; probe: CliProbe | null }> {
  const now = options.now ?? (() => new Date());
  const discovered = options.binary ?? discoverTool("codewhale").path;
  const base: CapabilityDrift = {
    checked: false,
    checkedAt: null,
    error: null,
    engineVersion: null,
    engineCommit: null,
    inventoryVersion: inventory.engine.version,
    inventoryCommit: inventory.engine.commit,
    versionMatch: false,
    commitMatch: false,
    additions: [],
    removals: [],
    note: "",
  };
  if (!discovered) {
    return {
      drift: {
        ...base,
        error:
          "the codewhale executable was not found on PATH or in the well-known tool directories",
        note: "Drift is unchecked. The inventory is shown as recorded; no version claim is made.",
      },
      probe: null,
    };
  }
  const versionResult = await runProbe(discovered, ["--version"]);
  const helpResult = await runProbe(discovered, ["--help"]);
  if (versionResult.error || helpResult.error) {
    return {
      drift: {
        ...base,
        error: versionResult.error ?? helpResult.error,
        note: "The engine help probe failed. Drift is unchecked rather than assumed clean.",
      },
      probe: null,
    };
  }
  const parsedVersion = parseVersion(versionResult.stdout);
  const commands = parseCommandList(helpResult.stdout);
  const featuresResult = await runProbe(discovered, ["features", "list"]);
  const features = featuresResult.error ? [] : parseFeatureList(featuresResult.stdout);
  const probe: CliProbe = {
    probedAt: now().toISOString(),
    version: parsedVersion.version,
    commit: parsedVersion.commit,
    commands,
    features,
    error: featuresResult.error,
  };
  const installed = new Set(commands.map((command) => command.name));
  const recorded = new Set(rows.filter((row) => row.scope === "cli").map((row) => row.name));
  const additions = commands
    .filter((command) => !recorded.has(command.name))
    .map((command) => ({
      name: command.name,
      note: `installed but not recorded in the inventory: ${command.summary}`,
    }));
  const removals = rows
    .filter((row) => row.scope === "cli" && !installed.has(row.name))
    .map((row) => ({
      name: row.name,
      note: `${row.id} records this command, but the installed help no longer lists it`,
    }));
  const versionMatch = probe.version === inventory.engine.version;
  const commitMatch =
    probe.commit !== null &&
    (inventory.engine.commit.startsWith(probe.commit) ||
      probe.commit.startsWith(inventory.engine.commit));
  return {
    probe,
    drift: {
      ...base,
      checked: true,
      checkedAt: probe.probedAt,
      engineVersion: probe.version,
      engineCommit: probe.commit,
      versionMatch,
      commitMatch,
      additions,
      removals,
      note:
        versionMatch && commitMatch && additions.length === 0 && removals.length === 0
          ? "The installed engine matches the recorded surface."
          : "The installed engine differs from the recorded surface. Rows are shown as recorded; an engine change is an explicit re-qualification, never a silent upgrade.",
    },
  };
}

/**
 * A corrupted settings row must never be rendered as a feature matrix. This
 * checks only the fields the screen dereferences, and a failed check falls back
 * to an honest error instead of a partial table.
 */
function isStoredSnapshot(value: unknown): value is CapabilitySnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CapabilitySnapshot>;
  if (!Array.isArray(candidate.rows) || candidate.rows.length === 0) return false;
  if (
    !candidate.rows.every(
      (row) => row && typeof row.id === "string" && typeof row.name === "string",
    )
  ) {
    return false;
  }
  const coverage = candidate.coverage;
  if (
    !coverage ||
    typeof coverage.rowsTotal !== "number" ||
    !Array.isArray(coverage.gaps) ||
    typeof coverage.complete !== "boolean"
  ) {
    return false;
  }
  const drift = candidate.drift;
  if (!drift || typeof drift.checked !== "boolean" || !Array.isArray(drift.additions)) return false;
  if (typeof candidate.loadedAt !== "string") return false;
  if (!Array.isArray(candidate.features)) return false;
  return true;
}

/** A read-only help probe spawns three processes; reuse it briefly. */
const DRIFT_TTL_MS = 60_000;

export class CapabilityExplorer {
  private readonly options: CapabilityExplorerOptions;
  private cachedProbe: CliProbe | null = null;
  private cachedAt: number | null = null;
  private cachedDrift: CapabilityDrift | null = null;
  private cachedDriftAt: number | null = null;

  constructor(options: CapabilityExplorerOptions) {
    this.options = options;
  }

  private stamp(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  async snapshot(): Promise<CapabilitySnapshot> {
    let inventory: CapabilityInventory;
    let path: string;
    try {
      path = resolveInventoryPath(this.options.inventoryPath);
      inventory = loadInventory(path);
    } catch (error) {
      // The last good projection is still useful; a missing file is not an
      // empty feature matrix.
      const stored = await this.options.store.getSettings(CACHE_SCOPE);
      const cached = stored?.value as CapabilitySnapshot | undefined;
      if (isStoredSnapshot(cached)) {
        return {
          ...cached,
          source: "stored",
          unavailableReason:
            error instanceof Error
              ? `${error.message}. Showing the last computed coverage from ${cached.loadedAt}.`
              : "the capability inventory is unavailable; showing the last computed coverage",
        };
      }
      throw error;
    }
    const rows = inventory.capabilities.map(toRowView);
    const coverage = computeCoverage(rows);
    // Re-probe on demand, but not on every palette keystroke: the palette also
    // asks for this snapshot, and three process spawns per open is wasteful.
    const fresh =
      this.cachedDrift !== null &&
      this.cachedDriftAt !== null &&
      Date.now() - this.cachedDriftAt < DRIFT_TTL_MS;
    let drift: CapabilityDrift;
    if (fresh) {
      drift = { ...this.cachedDrift!, checkedAt: this.cachedDrift!.checkedAt };
    } else {
      const probed = await probeDrift(rows, inventory, {
        binary: this.options.probeBinary,
        now: this.options.now,
      });
      drift = probed.drift;
      this.cachedDrift = drift;
      this.cachedDriftAt = Date.now();
      if (probed.probe) {
        this.cachedProbe = probed.probe;
        this.cachedAt = Date.now();
      }
    }
    const engine = this.options.engine?.() ?? null;
    const fileCoverage = inventory.coverage;
    const notes: string[] = [];
    if (
      fileCoverage.rows_total !== coverage.rowsTotal ||
      fileCoverage.verified !== coverage.verified ||
      fileCoverage.unqualified !== coverage.unqualified ||
      fileCoverage.blocked_gaps !== coverage.blockedGaps
    ) {
      notes.push(
        `The file's recorded coverage (${fileCoverage.rows_total} rows, ${fileCoverage.verified} verified) ` +
          `does not match the rows (${coverage.rowsTotal} rows, ${coverage.verified} verified). The computed numbers are shown.`,
      );
    }
    if (drift.additions.length > 0 || drift.removals.length > 0) {
      notes.push(
        `${drift.additions.length} installed command(s) are not in the inventory and ${drift.removals.length} recorded command(s) are missing.`,
      );
    }
    if (this.cachedProbe && this.cachedProbe.error) {
      notes.push(`Feature flags could not be read: ${this.cachedProbe.error}`);
    }
    if (!this.cachedProbe) {
      notes.push("Feature flags were not read in this snapshot.");
    }
    const snapshot: CapabilitySnapshot = {
      source: "live",
      unavailableReason: coverage.complete
        ? null
        : "Required gaps remain; full parity is not claimed.",
      inventoryPath: redactPath(path),
      loadedAt: this.stamp(),
      rows,
      coverage,
      drift,
      engineCapabilities: engine?.capabilities ?? null,
      features: this.cachedProbe?.features ?? [],
      notes,
    };
    await this.options.store.putSettings(CACHE_SCOPE, {
      ...snapshot,
      // The cache is a projection for offline viewing; the engine flags are
      // live and are not stored as if they were current.
      engineCapabilities: null,
      features: [],
    });
    return snapshot;
  }

  /** Force a fresh probe; the Re-probe control uses this. */
  async refresh(): Promise<CapabilitySnapshot> {
    this.cachedDrift = null;
    this.cachedDriftAt = null;
    this.cachedProbe = null;
    this.cachedAt = null;
    return this.snapshot();
  }

  /** Read-only feature flags, as reported by the installed engine. */
  async featureFlags(): Promise<Array<{ name: string; stage: string; enabled: boolean }>> {
    if (this.cachedProbe && this.cachedAt !== null && Date.now() - this.cachedAt < 60_000) {
      return this.cachedProbe.features;
    }
    const binary = this.options.probeBinary ?? discoverTool("codewhale").path;
    if (!binary) return [];
    const result = await runProbe(binary, ["features", "list"]);
    if (result.error) return [];
    const features = parseFeatureList(result.stdout);
    this.cachedProbe = {
      probedAt: this.stamp(),
      version: null,
      commit: null,
      commands: [],
      features,
      error: null,
    };
    this.cachedAt = Date.now();
    return features;
  }

  async report(): Promise<{ json: string; markdown: string; filename: string }> {
    const snapshot = await this.snapshot();
    const features = await this.featureFlags();
    const json = `${JSON.stringify(
      {
        schema_version: 1,
        generated_at: snapshot.loadedAt,
        inventory: snapshot.inventoryPath,
        coverage: snapshot.coverage,
        drift: snapshot.drift,
        features,
        rows: snapshot.rows,
      },
      null,
      2,
    )}\n`;
    const lines: string[] = [
      "# Mona capability coverage",
      "",
      `Generated ${snapshot.loadedAt} from ${snapshot.inventoryPath ?? "the inventory"}.`,
      "",
      "## Coverage",
      "",
      `- Rows: ${snapshot.coverage.rowsTotal}`,
      `- Verified: ${snapshot.coverage.verified}`,
      `- Open (entry point named, operation not exercised): ${snapshot.coverage.unqualified}`,
      `- Blocked gaps: ${snapshot.coverage.blockedGaps}`,
      `- Unavailable on this build: ${snapshot.coverage.unavailable}`,
      `- Entry points exercised: ${snapshot.coverage.testedEntryPoint}`,
      `- Complete: ${snapshot.coverage.complete ? "yes" : "no — Full parity is not claimed while rows remain open"}`,
      "",
      "## Drift",
      "",
      `- Checked: ${snapshot.drift.checked ? snapshot.drift.checkedAt : "not checked"}`,
      `- Installed: ${snapshot.drift.engineVersion ?? "unknown"} (${snapshot.drift.engineCommit ?? "unknown"})`,
      `- Recorded: ${snapshot.drift.inventoryVersion} (${snapshot.drift.inventoryCommit})`,
      `- Additions: ${snapshot.drift.additions.length}`,
      `- Removals: ${snapshot.drift.removals.length}`,
      "",
      "## Rows",
      "",
      "| id | capability | integration | entry | status |",
      "| --- | --- | --- | --- | --- |",
      ...snapshot.rows.map(
        (row) =>
          `| ${row.id} | ${row.name} | ${row.integration} | ${row.entryPoint.kind}${row.entryPoint.target ? `:${row.entryPoint.target}` : ""} | ${row.status} |`,
      ),
      "",
      "## Gaps",
      "",
      ...snapshot.coverage.gaps.map(
        (gap) => `- **${gap.id} ${gap.name}** (${gap.status}): ${gap.reason}`,
      ),
      "",
    ];
    return {
      json,
      markdown: `${lines.join("\n")}\n`,
      filename: `mona-capability-coverage-${snapshot.loadedAt.slice(0, 10)}`,
    };
  }
}
