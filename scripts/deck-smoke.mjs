#!/usr/bin/env node
// F02 — the Studio flight deck on real pixels.
//
// Launches the production Electron shell against an isolated state store and a
// real project, then measures the deck at the sizes and zoom levels the owner
// uses: bounded document, internally scrolling console, prompt that does not
// move when output arrives, reachable Submit/Pause/Interrupt, composer resize,
// reading history with Jump to latest, notice timing, Enter/Command-Enter, the
// reduced-motion setting, and the narrow-window command button.
//
// No runtime is started and no model request is made: the transcript is stored
// history grown by the harness itself.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const electron = require("electron");
const ROOT = resolve(new URL("..", import.meta.url).pathname);
const artifactDir =
  process.env.MONA_DECK_SMOKE_OUT_DIR ??
  join(ROOT, "docs", "evidence", "macos", "studio-flight-deck");
await mkdir(artifactDir, { recursive: true });
/**
 * `--app <path>` points the same checks at a packaged or installed bundle
 * instead of the developer tree: F03 has to describe the product the owner
 * launches, not only `electron .`.
 */
const appArgIndex = process.argv.indexOf("--app");
const APP_PATH = appArgIndex >= 0 ? resolve(process.argv[appArgIndex + 1] ?? "") : null;
const APP_BINARY = APP_PATH ? join(APP_PATH, "Contents", "MacOS", "Mona") : null;
const runDir = await mkdtemp(join(tmpdir(), "mona-deck-smoke-"));
const outFile = join(runDir, "report.json");
const userDataDir = await mkdtemp(join(tmpdir(), "mona-deck-smoke-userdata-"));

const child = APP_BINARY
  ? spawn(APP_BINARY, ["--deck-smoke", `--user-data-dir=${userDataDir}`], {
      cwd: APP_PATH,
      env: {
        ...process.env,
        MONA_DECK_SMOKE_OUT: outFile,
        MONA_DECK_SMOKE_OUT_DIR: artifactDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
  : spawn(electron, [".", "--deck-smoke", `--user-data-dir=${userDataDir}`], {
      cwd: ROOT,
      env: {
        ...process.env,
        MONA_DECK_SMOKE_OUT: outFile,
        MONA_DECK_SMOKE_OUT_DIR: artifactDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => (stdout += chunk));
child.stderr.on("data", (chunk) => (stderr += chunk));

const timeout = setTimeout(() => child.kill("SIGKILL"), 240_000);
const code = await new Promise((resolveExit) => child.on("exit", (value) => resolveExit(value)));
clearTimeout(timeout);

let report = null;
try {
  report = JSON.parse(await readFile(outFile, "utf8"));
} catch {
  report = { ok: false, error: "deck smoke report missing" };
}

const output = {
  ...report,
  target: APP_BINARY ? { bundle: APP_PATH, binary: APP_BINARY, packaged: true } : { tree: ROOT },
  electron: { exit: code, stdout: stdout.slice(0, 2000), stderr: stderr.slice(0, 4000) },
};
console.log(JSON.stringify(output, null, 2));
await rm(runDir, { recursive: true, force: true });
await rm(userDataDir, { recursive: true, force: true });
process.exit(report.ok === true && code === 0 ? 0 : 1);
