#!/usr/bin/env node
// Generate and validate the pinned Codewhale slash-command catalog for R03.
//
// The catalog is not written from memory. It is the engine's own answer to
// `GET /v1/commands`, captured from the pinned 0.10.2 binary (commit
// ff466b2ed0bf) in an isolated CODEWHALE_HOME. The TUI slash registry is a
// different surface from `codewhale --help`; only this endpoint enumerates it.
//
//   node scripts/command-catalog.mjs --capture   # needs the pinned engine
//   node scripts/command-catalog.mjs --check     # offline, used by CI
//   node scripts/command-catalog.mjs --coverage  # markdown coverage table
//
// `--capture` starts a local engine, makes no model request, and stops it.
// `--check` never starts a process and never touches the network.

import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = join(root, "src/shared/commands/pinned-commands.json");
const annotationsPath = join(root, "src/shared/commands/annotations.json");
const capturePath = join(
  root,
  "docs/evidence/macos/review-studio/artifacts/r03-commands-capture.json",
);

// The pin is the discovery record (state.json engine block). A version drift is
// a deliberate compatibility decision, never something this script papers over.
const PIN = {
  version: "0.10.2",
  commit: "ff466b2ed0bfb4ae5267d4d8d0ecb562cf46956e",
  shortCommit: "ff466b2ed0bf",
  binarySha256: "da0229610647f1cc2dd14c4227b333a92ea276a49f5d4d79160fa19e515e590d",
  install: "npm global (/opt/homebrew)",
  repository: "https://github.com/codewhale-hq/Codewhale",
};

const DISCOVERY = new Set(["primary", "advanced", "compatibility"]);
const SCOPES = new Set(["ui", "session", "thread", "workspace", "project", "engine", "account"]);
const EFFECTS = new Set([
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
]);
const COSTS = new Set(["none", "may-spend", "unknown"]);
const ROUTE_KINDS = new Set(["runtime-api", "tui-local", "unavailable"]);
const SUPPORT = new Set(["runtime-api", "terminal-only", "unavailable"]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// Generated JSON is repository data, so it must satisfy the same format gate as
// the rest of the tree. Prettier is a dev dependency; if it is absent, the raw
// JSON is still valid and `--check` does not depend on formatting.
function formatJson(path) {
  try {
    execFileSync("npx", ["prettier", "--write", path], {
      cwd: root,
      stdio: "ignore",
    });
  } catch {
    // Formatting is a convenience here, not part of the capture's meaning.
  }
}

function engineBinary() {
  try {
    return execFileSync("which", ["codewhale"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function realBinary() {
  const onPath = engineBinary();
  if (!onPath) return null;
  // The npm shim is a JS launcher; the native payload is beside it.
  try {
    const target = execFileSync("readlink", ["-f", onPath], { encoding: "utf8" }).trim();
    if (target.endsWith(".js")) {
      return join(dirname(target), "downloads", "codewhale");
    }
    return target;
  } catch {
    return null;
  }
}

async function capture() {
  const binary = realBinary();
  if (!binary || !existsSync(binary)) {
    throw new Error("the pinned codewhale binary was not found; install 0.10.2 first");
  }
  const versionLine = execFileSync("codewhale", ["--version"], { encoding: "utf8" }).trim();
  if (!versionLine.includes(PIN.version) || !versionLine.includes(PIN.shortCommit)) {
    throw new Error(
      `refusing to capture from ${versionLine}; the pin is ${PIN.version} (${PIN.shortCommit})`,
    );
  }
  const binarySha = sha256(readFileSync(binary));
  if (binarySha !== PIN.binarySha256) {
    throw new Error(`binary sha256 ${binarySha} does not match the recorded pin`);
  }

  const home = mkdtempSync(join(tmpdir(), "mona-command-catalog-home-"));
  const workspace = mkdtempSync(join(tmpdir(), "mona-command-catalog-ws-"));
  const port = 17900 + Math.floor(Math.random() * 200);
  const token = randomBytes(24).toString("hex");
  const child = spawn(
    binary,
    ["app-server", "--http", "--port", String(port), "--auth-token", token],
    {
      cwd: workspace,
      env: {
        ...process.env,
        CODEWHALE_HOME: home,
        CODEWHALE_RUNTIME_TOKEN: token,
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let log = "";
  child.stdout.on("data", (chunk) => (log += chunk.toString()));
  child.stderr.on("data", (chunk) => (log += chunk.toString()));

  const base = `http://127.0.0.1:${port}`;
  const headers = { authorization: `Bearer ${token}` };
  let info = null;
  let commands = null;
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await new Promise((done) => setTimeout(done, 150));
      try {
        const response = await fetch(`${base}/v1/runtime/info`, { headers });
        if (response.ok) {
          info = await response.json();
          break;
        }
      } catch {
        // not listening yet
      }
    }
    if (!info) throw new Error(`the isolated runtime did not become ready:\n${log}`);

    const response = await fetch(`${base}/v1/commands`, { headers });
    if (!response.ok) {
      throw new Error(`GET /v1/commands answered ${response.status}:\n${log}`);
    }
    commands = await response.json();
  } finally {
    child.kill("SIGTERM");
    await new Promise((done) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        done();
      }, 4000);
      child.once("exit", () => {
        clearTimeout(timer);
        done();
      });
    });
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }

  const capturedAt = new Date().toISOString();
  const raw = {
    capturedAt,
    endpoint: "GET /v1/commands",
    engine: {
      name: "codewhale",
      version: PIN.version,
      commit: PIN.commit,
      shortCommit: PIN.shortCommit,
      binarySha256: PIN.binarySha256,
      install: PIN.install,
      repository: PIN.repository,
      versionLine,
    },
    runtimeInfo: info,
    response: commands,
  };
  mkdirSync(dirname(capturePath), { recursive: true });
  writeFileSync(capturePath, `${JSON.stringify(raw, null, 2)}\n`);
  formatJson(capturePath);
  const captureSha = sha256(readFileSync(capturePath));

  const catalog = normalize(raw, captureSha);
  mkdirSync(dirname(catalogPath), { recursive: true });
  writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  formatJson(catalogPath);
  console.log(
    `captured ${catalog.commands.length} commands · ${capturePath} · sha256 ${captureSha}`,
  );
}

function normalize(raw, captureSha) {
  const rows = raw.response?.commands;
  if (!Array.isArray(rows)) throw new Error("the capture has no commands array");
  const commands = rows.map((row) => {
    if (typeof row.name !== "string" || row.name.length === 0) {
      throw new Error("a catalog row has no name");
    }
    if (!DISCOVERY.has(row.discovery)) {
      throw new Error(`/${row.name} has an unknown discovery class ${String(row.discovery)}`);
    }
    return {
      name: row.name,
      aliases: Array.isArray(row.aliases) ? [...row.aliases] : [],
      summary: typeof row.summary === "string" ? row.summary : "",
      usage: typeof row.usage === "string" ? row.usage : `/${row.name}`,
      subcommands: Array.isArray(row.subcommands) ? [...row.subcommands] : [],
      takesArguments: row.takes_arguments === true,
      requiresArgument: row.requires_argument === true,
      requiresRequiredArgument: row.requires_required_argument === true,
      composerWantsTrailingSpace: row.composer_wants_trailing_space === true,
      paletteRunsDirectly: row.palette_runs_directly === true,
      showInEmptyDiscovery: row.show_in_empty_discovery === true,
      discovery: row.discovery,
      hidden: row.hidden === true,
      binding: row.binding === "host" ? "host" : "prompt",
      kind: row.kind === "builtin" ? "builtin" : "user",
    };
  });
  commands.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    schemaVersion: 1,
    provenance: {
      engine: "codewhale",
      version: raw.engine.version,
      commit: raw.engine.commit,
      binarySha256: raw.engine.binarySha256,
      install: raw.engine.install,
      repository: raw.engine.repository,
      versionLine: raw.engine.versionLine,
      endpoint: raw.endpoint,
      capturedAt: raw.capturedAt,
      capturePath: "docs/evidence/macos/review-studio/artifacts/r03-commands-capture.json",
      captureSha256: captureSha,
      generator: "node scripts/command-catalog.mjs --capture",
      note:
        "Generated from the pinned engine's own GET /v1/commands response. " +
        "The TUI slash registry is not the CLI command list; do not hand-edit.",
    },
    commands,
  };
}

function validateCatalog(catalog, annotations) {
  const errors = [];
  const warnings = [];
  if (catalog.schemaVersion !== 1) errors.push("catalog schemaVersion must be 1");
  const provenance = catalog.provenance ?? {};
  for (const key of ["version", "commit", "binarySha256", "capturedAt", "captureSha256"]) {
    if (typeof provenance[key] !== "string" || provenance[key].length === 0) {
      errors.push(`provenance.${key} is missing`);
    }
  }
  if (provenance.version !== PIN.version) {
    errors.push(`catalog version ${provenance.version} is not the pin ${PIN.version}`);
  }
  if (provenance.commit !== PIN.commit) {
    errors.push(`catalog commit ${provenance.commit} is not the pin ${PIN.commit}`);
  }
  if (provenance.binarySha256 !== PIN.binarySha256) {
    errors.push("catalog binary sha256 is not the recorded pin");
  }
  const rows = Array.isArray(catalog.commands) ? catalog.commands : [];
  if (rows.length < 100) errors.push(`only ${rows.length} commands captured`);

  const names = new Set();
  const spellings = new Map();
  for (const row of rows) {
    if (names.has(row.name)) errors.push(`duplicate command /${row.name}`);
    names.add(row.name);
    if (!/^[a-z][a-z0-9-]*$/.test(row.name)) {
      warnings.push(`/${row.name} has a canonical name outside [a-z0-9-]`);
    }
    for (const spelling of [row.name, ...row.aliases]) {
      const key = spelling.toLowerCase();
      const prior = spellings.get(key);
      if (prior && prior !== row.name) {
        errors.push(`spelling "${spelling}" is claimed by /${prior} and /${row.name}`);
      }
      spellings.set(key, row.name);
    }
    if (typeof row.summary !== "string" || row.summary.trim().length === 0) {
      errors.push(`/${row.name} has no summary`);
    }
    if (!row.usage.startsWith(`/${row.name}`)) {
      errors.push(`/${row.name} usage does not begin with its name: ${row.usage}`);
    }
    if (!DISCOVERY.has(row.discovery)) errors.push(`/${row.name} discovery is invalid`);
  }

  const entries = annotations?.entries ?? {};
  for (const row of rows) {
    const entry = entries[row.name];
    if (!entry) {
      errors.push(`/${row.name} has no annotation`);
      continue;
    }
    if (!SCOPES.has(entry.scope)) errors.push(`/${row.name} scope ${entry.scope} is invalid`);
    if (!Array.isArray(entry.sideEffects) || entry.sideEffects.length === 0) {
      errors.push(`/${row.name} has no side-effect entry`);
    } else {
      for (const effect of entry.sideEffects) {
        if (!EFFECTS.has(effect)) errors.push(`/${row.name} side effect ${effect} is invalid`);
      }
    }
    if (!COSTS.has(entry.cost)) errors.push(`/${row.name} cost ${entry.cost} is invalid`);
    const route = entry.route ?? {};
    if (!ROUTE_KINDS.has(route.kind)) errors.push(`/${row.name} route kind is invalid`);
    if (route.kind === "runtime-api") {
      if (!Array.isArray(route.endpoints) || route.endpoints.length === 0) {
        errors.push(`/${row.name} runtime-api route has no endpoints`);
      } else {
        for (const endpoint of route.endpoints) {
          if (typeof endpoint !== "string" || !endpoint.startsWith("/v1/")) {
            errors.push(`/${row.name} endpoint ${String(endpoint)} is not a /v1 route`);
          }
        }
      }
    } else if (typeof route.note !== "string" || route.note.trim().length === 0) {
      errors.push(`/${row.name} ${route.kind} route has no explanation`);
    }
    if (!SUPPORT.has(entry.support))
      errors.push(`/${row.name} support ${entry.support} is invalid`);
    if (entry.cost === "may-spend" && !entry.sideEffects.includes("spend")) {
      errors.push(`/${row.name} may spend but does not declare the spend effect`);
    }
    const expectedRoute = {
      "runtime-api": "runtime-api",
      "terminal-only": "tui-local",
      unavailable: "unavailable",
    }[entry.support];
    if (route.kind !== expectedRoute) {
      errors.push(
        `/${row.name} support ${entry.support} requires a ${expectedRoute} route, not ${route.kind}`,
      );
    }
  }
  for (const name of Object.keys(entries)) {
    if (!names.has(name)) errors.push(`annotation /${name} names no captured command`);
  }
  const hidden = rows.filter((row) => row.hidden).length;
  const terminalOnly = rows.filter((row) => entries[row.name]?.support === "terminal-only").length;
  const unavailable = rows.filter((row) => entries[row.name]?.support === "unavailable").length;
  if (provenance.captureSha256 && existsSync(capturePath)) {
    const actual = sha256(readFileSync(capturePath));
    if (actual !== provenance.captureSha256) {
      errors.push("the capture artifact no longer matches the catalog's captureSha256");
    }
  }
  return { errors, warnings, counts: { commands: rows.length, hidden, terminalOnly, unavailable } };
}

function check() {
  if (!existsSync(catalogPath)) throw new Error(`catalog is missing: ${catalogPath}`);
  if (!existsSync(annotationsPath)) throw new Error(`annotations are missing: ${annotationsPath}`);
  const result = validateCatalog(readJson(catalogPath), readJson(annotationsPath));
  if (result.errors.length > 0) {
    console.error(JSON.stringify({ ok: false, ...result }, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log(
    JSON.stringify({ ok: true, warnings: result.warnings, counts: result.counts }, null, 2),
  );
}

function coverage() {
  const catalog = readJson(catalogPath);
  const annotations = readJson(annotationsPath);
  const rows = catalog.commands.map((row) => {
    const entry = annotations.entries[row.name];
    const route =
      entry.route.kind === "runtime-api"
        ? entry.route.endpoints.join(", ")
        : `${entry.route.kind}: ${entry.route.note}`;
    return {
      name: `/${row.name}`,
      aliases: row.aliases.length ? row.aliases.join(", ") : "—",
      discovery: row.hidden ? "hidden" : row.discovery,
      scope: entry.scope,
      cost: entry.cost,
      support: entry.support,
      route,
      summary: row.summary,
    };
  });
  const lines = [
    "| Command | Aliases | Discovery | Scope | Cost | Support | Route | Summary |",
    "|---|---|---|---|---|---|---|---|",
    ...rows.map(
      (row) =>
        `| \`${row.name}\` | ${row.aliases} | ${row.discovery} | ${row.scope} | ${row.cost} | ${row.support} | ${row.route.replaceAll("|", "\\|")} | ${row.summary.replaceAll("|", "\\|")} |`,
    ),
  ];
  console.log(lines.join("\n"));
}

const mode = process.argv[2];
try {
  if (mode === "--capture") await capture();
  else if (mode === "--check") check();
  else if (mode === "--coverage") coverage();
  else {
    console.error("usage: node scripts/command-catalog.mjs --capture|--check|--coverage");
    process.exitCode = 2;
  }
} catch (error) {
  console.error(String(error?.stack ?? error));
  process.exitCode = 1;
}
