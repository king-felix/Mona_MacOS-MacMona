// Hash index: a cheap way to prove that requirements, state, and evidence all
// refer to the same specification revision and the same files on disk.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { sha256Buffer, sha256File } from "./atomic.mjs";
import { PROMPTS_FILE, SPEC_FILE } from "./requirements.mjs";

export const TRACKED_DOCS = ["AGENTS.md", "docs/requirements-macos.json", "docs/codewhale-capabilities-macos.json"];

function walkFiles(dir, filter, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, filter, acc);
    else if (entry.isFile() && filter(full)) acc.push(full);
  }
  return acc;
}

export function gitInfo(root) {
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
    return { available: true, commit, dirty: status.trim().length > 0 };
  } catch {
    return { available: false, commit: null, dirty: null };
  }
}

export function buildIndex(root, { statePath, attemptsPath, requirementsPath, evidenceDir }) {
  const files = [];
  const addFile = (absolute) => {
    if (!existsSync(absolute)) return;
    const stats = statSync(absolute);
    if (!stats.isFile()) return;
    files.push({
      path: relative(root, absolute),
      sha256: sha256File(absolute),
      bytes: stats.size,
    });
  };
  for (const doc of [SPEC_FILE, PROMPTS_FILE, ...TRACKED_DOCS]) addFile(join(root, doc));
  addFile(statePath);
  addFile(attemptsPath);
  addFile(requirementsPath);
  for (const evidence of walkFiles(evidenceDir, () => true)) addFile(evidence);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    schema_version: 1,
    generated_utc: new Date().toISOString(),
    root,
    git: gitInfo(root),
    digest: sha256Buffer(Buffer.from(files.map((file) => `${file.path}:${file.sha256}`).join("\n"))),
    files,
  };
}

export function compareIndex(index, root) {
  const drift = [];
  for (const file of index.files ?? []) {
    const absolute = join(root, file.path);
    if (!existsSync(absolute)) {
      drift.push({ path: file.path, issue: "missing" });
      continue;
    }
    const current = sha256File(absolute);
    if (current !== file.sha256) drift.push({ path: file.path, issue: "changed", was: file.sha256, now: current });
  }
  return { clean: drift.length === 0, drift };
}

export function readIndex(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}
