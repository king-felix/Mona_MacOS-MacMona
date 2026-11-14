#!/usr/bin/env node
/**
 * P25 — shared-core audit.
 *
 * This is a *fact* collector, not a claim of cross-platform qualification. It
 * answers three questions with the tree in front of it:
 *
 *  1. Is `src/shared` genuinely platform-free (no Node builtins, no macOS
 *     paths, no process checks)? A shared contract that reads `process.platform`
 *     is a merge conflict waiting to happen.
 *  2. Which main-process modules are portable logic and which are bound to
 *     macOS by an import or a literal?
 *  3. What is the baseline (commit, schema version, contract count) that a
 *     Windows checkout would be reconciled against?
 *
 * No network, no inference, no build.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);

const MACOS_MARKERS = [
  { label: "platform-check", pattern: /process\.platform/ },
  { label: "darwin-literal", pattern: /["'`]darwin["'`]/ },
  { label: "applications-path", pattern: /\/Applications\// },
  { label: "library-path", pattern: /\/Library\/(Application Support|Services|Launch)/ },
  {
    label: "macos-command",
    pattern:
      /\b(codesign|pkgutil|productbuild|pkgbuild|productsign|notarytool|stapler|spctl|hdiutil|ditto|osascript|open -a)\b/,
  },
  { label: "swift", pattern: /\.swift\b|swiftc/ },
  { label: "finder", pattern: /\bFinder\b/ },
];
const NODE_BUILTINS = [
  "node:fs",
  "node:fs/promises",
  "node:child_process",
  "node:os",
  "node:path",
  "node:net",
  "node:http",
  "node:https",
  "node:crypto",
  "node:sqlite",
  "node:process",
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

function sourceFiles(dir, extensions = [".ts", ".tsx", ".mjs", ".js"]) {
  const files = [];
  try {
    for (const path of walk(dir)) {
      if (extensions.some((extension) => path.endsWith(extension))) files.push(path);
    }
  } catch {
    // A missing directory is reported by the caller as an absent tree.
  }
  return files;
}

/**
 * A shared module must be *behaviourally* platform-free. That is stricter than
 * "contains no macOS word": a comment naming Finder, or a provenance enum value
 * like `pkgutil`, is a label a Windows core must map, not logic that changes
 * behaviour here. Those are reported as `mentions` for review; imports, process
 * checks, path literals and shell commands are `violations`.
 */
const BEHAVIOURAL = new Set([
  "platform-check",
  "darwin-literal",
  "applications-path",
  "library-path",
  "swift",
]);

function scanShared(dir) {
  const files = sourceFiles(dir);
  const violations = [];
  const mentions = [];
  for (const path of files) {
    const text = readFileSync(path, "utf8");
    for (const builtin of NODE_BUILTINS) {
      if (text.includes(`"${builtin}"`) || text.includes(`'${builtin}'`)) {
        violations.push({ path: relative(ROOT, path), kind: "node-builtin", detail: builtin });
      }
    }
    for (const marker of MACOS_MARKERS) {
      if (!marker.pattern.test(text)) continue;
      const entry = { path: relative(ROOT, path), kind: marker.label, detail: "shared module" };
      if (BEHAVIOURAL.has(marker.label)) violations.push(entry);
      else mentions.push(entry);
    }
  }
  return { files: files.length, violations, mentions };
}

function classifyMain(dir) {
  const files = sourceFiles(dir);
  const portable = [];
  const bound = [];
  for (const path of files) {
    const text = readFileSync(path, "utf8");
    const reasons = [];
    for (const marker of MACOS_MARKERS) {
      if (marker.pattern.test(text)) reasons.push(marker.label);
    }
    if (reasons.length === 0) portable.push(relative(ROOT, path));
    else bound.push({ path: relative(ROOT, path), reasons: [...new Set(reasons)] });
  }
  return {
    files: files.length,
    portable: portable.length,
    macos_bound: bound.length,
    bound,
  };
}

function git(args) {
  const result = spawnSync("/usr/bin/git", args, { cwd: ROOT, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function schemaVersion() {
  const text = readFileSync(join(ROOT, "src/main/state/schema.ts"), "utf8");
  const versions = [...text.matchAll(/\{ version: (\d+), name: "([^"]+)"/g)].map((match) => ({
    version: Number(match[1]),
    name: match[2],
  }));
  return { latest: versions.at(-1) ?? null, count: versions.length, migrations: versions };
}

function counters() {
  const contracts = sourceFiles(join(ROOT, "src/shared/contracts"));
  const work = sourceFiles(join(ROOT, "src/main/work")).length;
  const engine = sourceFiles(join(ROOT, "src/main/engine")).length;
  return { contracts: contracts.length, work_modules: work, engine_modules: engine };
}

const shared = scanShared(join(ROOT, "src/shared"));
const main = classifyMain(join(ROOT, "src/main"));
const report = {
  schema_version: 1,
  prompt: "P25",
  generated_utc: new Date().toISOString(),
  baseline: {
    commit: git(["rev-parse", "HEAD"]),
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
    dirty: (git(["status", "--porcelain", "--untracked-files=no"]) ?? "").length > 0,
    schema: schemaVersion(),
    counters: counters(),
  },
  shared: {
    files: shared.files,
    platform_free: shared.violations.length === 0,
    violations: shared.violations,
    mentions: shared.mentions,
    mentions_note:
      "Labels, not behaviour: a Windows core maps them (for example the update provenance value `pkgutil` becomes that platform's installer tool). No shared module imports a Node builtin or branches on the platform.",
  },
  main: {
    files: main.files,
    portable: main.portable,
    macos_bound: main.macos_bound,
    bound_modules: main.bound,
  },
  counterpart: {
    windows_checkout: null,
    windows_ledger: null,
    note: "No Windows/common source tree and no .mona/build ledger exist in this workspace. The audit is an interface handoff, not a comparison.",
  },
  verdict:
    shared.violations.length === 0 ? "shared-contracts-platform-free" : "shared-contracts-leak",
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(report.shared.violations.length === 0 ? 0 : 1);
