#!/usr/bin/env node
// Launch the real Electron shell with a temporary state store and a real
// project folder; verify the catalog, studio, board, settings, palette, and
// keyboard navigation against actual state. Screenshots are written to
// docs/evidence/macos/artifacts/p07-shell-*.png.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const electron = require("electron");
const ROOT = resolve(new URL("..", import.meta.url).pathname);
const outDir = await mkdtemp(join(tmpdir(), "mona-shell-smoke-"));
const outFile = join(outDir, "report.json");

const child = spawn(electron, [".", "--shell-smoke"], {
  cwd: ROOT,
  env: {
    ...process.env,
    MONA_SHELL_SMOKE_OUT: outFile,
    MONA_SHELL_SMOKE_OUT_DIR: join(ROOT, "docs", "evidence", "macos", "artifacts"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => (stdout += chunk));
child.stderr.on("data", (chunk) => (stderr += chunk));

const timeout = setTimeout(() => child.kill("SIGKILL"), 90_000);
const code = await new Promise((resolveExit) => child.on("exit", (value) => resolveExit(value)));
clearTimeout(timeout);

let report = null;
try {
  report = JSON.parse(await readFile(outFile, "utf8"));
} catch {
  report = { ok: false, error: "shell smoke report missing" };
}

const output = {
  ...report,
  electron: {
    exit: code,
    stdout: stdout.slice(0, 2000),
    stderr: stderr.slice(0, 2000),
  },
};
console.log(JSON.stringify(output, null, 2));
await rm(outDir, { recursive: true, force: true });
process.exit(report.ok === true && code === 0 ? 0 : 1);
