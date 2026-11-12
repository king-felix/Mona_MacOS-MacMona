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
// An isolated Electron user-data directory, for the same reason the state store
// is temporary: the smoke must not read the real user's app state, and it must
// not lose the single-instance lock to a Mona the user already has open.
const userDataDir = await mkdtemp(join(tmpdir(), "mona-shell-smoke-userdata-"));

const child = spawn(electron, [".", "--shell-smoke", `--user-data-dir=${userDataDir}`], {
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
await rm(userDataDir, { recursive: true, force: true });
process.exit(report.ok === true && code === 0 ? 0 : 1);
