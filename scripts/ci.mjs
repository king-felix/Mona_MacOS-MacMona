#!/usr/bin/env node
// Local CI-equivalent entry point. One command, deterministic order, honest exit.
import { spawnSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const steps = [];
let failed = false;

function run(name, command, args) {
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, CI: "1" },
  });
  const ok = result.status === 0;
  steps.push({ name, ok, exit: result.status, elapsed_ms: Date.now() - started });
  if (!ok) failed = true;
  return ok;
}

for (const script of [
  "format:check",
  "lint",
  "typecheck",
  // R03: the pinned slash-command catalog must match its annotations and its
  // capture digest. Offline, deterministic, no engine and no network.
  "catalog:check",
  "build:supervisor",
  "build:pty",
  "build:service",
  "test",
  "build",
  "smoke:board",
  "smoke:cost",
  "smoke:changes",
  "smoke:polish",
  "smoke:agents",
  "smoke:settings",
  // Reasoning controls (D-108). The pinned engine's live roster shadow answers
  // `reasoning_effort: unknown` while its own Models.dev metadata publishes the
  // ladder; this check reproduces both sources in an isolated home and proves
  // Mona offers only what is published. No turn, no provider charge.
  "smoke:reasoning",
  "smoke:extensions",
  "smoke:terminal",
  "smoke:capability",
  // R13: the command smoke was the only place that read the TUI-only receipt
  // copy, and it was not in this list — so R04's wording drift survived every
  // green run until an installed-artifact pass found it. A real window, no
  // engine, no model request.
  "smoke:commands",
  // R13: the history smoke was also outside this list. Its anchor assertion
  // stopped holding once R11 windowed the console, and nothing noticed until an
  // installed-artifact pass ran it by hand — the same failure mode the comment
  // above records for the command smoke. It runs a real window over a
  // 10,054-event project; no engine and no model request.
  "smoke:history",
  "smoke:memory",
  "smoke:failure",
  "smoke:p23",
  "smoke:lifecycle",
]) {
  if (!run(script, "npm", ["run", script])) break;
}

const scan = { ok: false, files: 0, patterns: [], bytes: 0 };
if (!failed) {
  const rendererDir = join(ROOT, "dist/renderer");
  const files = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else files.push(path);
    }
  }
  await walk(rendererDir);
  const secretPatterns = [
    [/sk-[A-Za-z0-9]{16,}/, "provider-key"],
    [/DEEPSEEK_API_KEY/, "deepseek-env-name"],
    [/CODEWHALE_RUNTIME_TOKEN/, "runtime-token-env-name"],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private-key"],
    [/node_modules\//, "node-modules-path"],
  ];
  const hits = [];
  let bytes = 0;
  for (const file of files) {
    const info = await stat(file);
    bytes += info.size;
    const text = await readFile(file, "utf8");
    for (const [pattern, label] of secretPatterns) {
      if (pattern.test(text)) hits.push({ file: file.replace(ROOT + "/", ""), label });
    }
    if (/\.map$/.test(file)) hits.push({ file: file.replace(ROOT + "/", ""), label: "source-map" });
    const envSecret = process.env.DEEPSEEK_API_KEY;
    if (envSecret && envSecret.length > 8 && text.includes(envSecret)) {
      hits.push({ file: file.replace(ROOT + "/", ""), label: "live-env-secret" });
    }
  }
  scan.files = files.length;
  scan.bytes = bytes;
  scan.patterns = hits;
  scan.ok = hits.length === 0;
  if (!scan.ok) failed = true;
}

const summary = {
  ok: !failed,
  steps,
  renderer_scan: scan,
  dist_bytes: scan.bytes,
};
console.log(JSON.stringify(summary, null, 2));
process.exit(failed ? 1 : 0);
