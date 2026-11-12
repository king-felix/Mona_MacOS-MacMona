#!/usr/bin/env node
// Build the native arm64 PTY host used by the integrated terminal. Fails closed
// on a non-arm64 Mac; on a non-macOS host it reports `skipped` so portable
// logic stays testable while native qualification stays explicitly pending.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const SOURCE = join(ROOT, "native/macos-pty/main.swift");
const CSHIM = join(ROOT, "native/macos-pty/spawn.c");
const BUILD_DIR = join(ROOT, "native/macos-pty/build");
const OUTPUT = join(BUILD_DIR, "mona-pty");
const TARGET = "arm64-apple-macos14.0";

function report(value) {
  console.log(JSON.stringify(value, null, 2));
}

if (process.platform !== "darwin" || process.arch !== "arm64") {
  report({
    ok: false,
    skipped: true,
    reason: `mona-pty requires macOS arm64; this host is ${process.platform}/${process.arch}`,
    native_qualification: "pending",
  });
  process.exit(0);
}

const toolchain = ["--sdk", "macosx", "swiftc"];
const available = spawnSync("xcrun", [...toolchain, "--version"], { encoding: "utf8" });
if (available.status !== 0) {
  report({ ok: false, error: "swiftc is unavailable; install Xcode Command Line Tools" });
  process.exit(1);
}
mkdirSync(BUILD_DIR, { recursive: true });

// The fork/exec shim is C because Swift marks fork() unavailable. Compile it
// first and link the object into the helper.
const shimObject = join(BUILD_DIR, "spawn.o");
const shimCompile = spawnSync(
  "xcrun",
  ["--sdk", "macosx", "clang", "-O", "-target", TARGET, "-c", CSHIM, "-o", shimObject],
  { encoding: "utf8" },
);
if (shimCompile.status !== 0) {
  report({ ok: false, error: "clang failed", stderr: (shimCompile.stderr ?? "").slice(-4000) });
  process.exit(1);
}

const compile = spawnSync(
  "xcrun",
  [...toolchain, "-O", "-target", TARGET, SOURCE, shimObject, "-o", OUTPUT],
  { encoding: "utf8" },
);
if (compile.status !== 0) {
  report({ ok: false, error: "swiftc failed", stderr: (compile.stderr ?? "").slice(-4000) });
  process.exit(1);
}

// Ad-hoc signing keeps the helper runnable locally; release signing is P22.
const sign = spawnSync("codesign", ["--force", "--sign", "-", OUTPUT], { encoding: "utf8" });
const verify = spawnSync("codesign", ["--verify", "--strict", OUTPUT], { encoding: "utf8" });
const file = spawnSync("file", [OUTPUT], { encoding: "utf8" });

const bytes = readFileSync(OUTPUT);
const receipt = {
  schema_version: 1,
  ok: sign.status === 0 && verify.status === 0,
  binary: OUTPUT.replace(ROOT + "/", ""),
  target: TARGET,
  arch: process.arch,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  size: bytes.length,
  compiler: (available.stdout ?? "").split("\n")[0] ?? "unknown",
  file: (file.stdout ?? "").replace(ROOT + "/", "").trim(),
  signature: sign.status === 0 ? "ad-hoc" : "unsigned",
  signed: sign.status === 0,
  verified: verify.status === 0,
  built_at: new Date().toISOString(),
};
writeFileSync(join(BUILD_DIR, "build.json"), JSON.stringify(receipt, null, 2) + "\n", "utf8");
report(receipt);
process.exit(receipt.ok ? 0 : 1);
