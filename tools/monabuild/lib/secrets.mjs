// Secret scan for files that are about to be committed or shared. Reports the
// pattern and line only, never the matched value.

import { readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const PATTERNS = [
  { name: "private-key-block", regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { name: "openai-style-key", regex: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: "aws-access-key-id", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "slack-token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "github-token", regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  {
    name: "assigned-secret",
    regex: /\b(api[_-]?key|secret|access[_-]?token|auth[_-]?token|client[_-]?secret)\b\s*[:=]\s*["'][^"'\s]{16,}["']/i,
  },
  { name: "assigned-password", regex: /\b(password|passwd)\b\s*[:=]\s*["'][^"'\s]{8,}["']/i },
];

export function scanText(text, file = "<text>") {
  const findings = [];
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    for (const pattern of PATTERNS) {
      if (pattern.regex.test(line)) {
        findings.push({ file, line: index + 1, pattern: pattern.name });
      }
    }
  });
  return findings;
}

export function isProbablyBinary(buffer) {
  const sample = buffer.subarray(0, 4096);
  return sample.includes(0);
}

export function scanFiles(root, files) {
  const findings = [];
  for (const file of files) {
    const absolute = join(root, file);
    let stats;
    try {
      stats = statSync(absolute);
    } catch {
      continue;
    }
    if (!stats.isFile() || stats.size > 5_000_000) continue;
    const buffer = readFileSync(absolute);
    if (isProbablyBinary(buffer)) continue;
    findings.push(...scanText(buffer.toString("utf8"), file));
  }
  return findings;
}

export function gitTrackedFiles(root) {
  try {
    return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
      .split("\0")
      .filter(Boolean);
  } catch {
    return [];
  }
}
