#!/usr/bin/env node
// Build the native arm64 Finder Service bundle: compile, lint the Info.plist,
// ad-hoc sign, verify, and write a build receipt. Fails closed on a non-arm64
// Mac; reports `skipped` elsewhere so portable logic can still be tested while
// native qualification stays explicitly pending.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const SOURCE = join(ROOT, "native/macos-services/main.swift");
const PLIST = join(ROOT, "native/macos-services/Info.plist");
const BUILD_DIR = join(ROOT, "native/macos-services/build");
const BUNDLE = join(BUILD_DIR, "Mona.service");
const TARGET = "arm64-apple-macos14.0";

function report(value) {
  console.log(JSON.stringify(value, null, 2));
}

if (process.platform !== "darwin" || process.arch !== "arm64") {
  report({
    ok: false,
    skipped: true,
    reason: `the Finder Service requires macOS arm64; this host is ${process.platform}/${process.arch}`,
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

rmSync(BUNDLE, { recursive: true, force: true });
mkdirSync(join(BUNDLE, "Contents", "MacOS"), { recursive: true });
cpSync(PLIST, join(BUNDLE, "Contents", "Info.plist"));

const lint = spawnSync("plutil", ["-lint", join(BUNDLE, "Contents", "Info.plist")], {
  encoding: "utf8",
});
if (lint.status !== 0) {
  report({ ok: false, error: "Info.plist failed plutil -lint", stdout: lint.stdout });
  process.exit(1);
}

const compile = spawnSync(
  "xcrun",
  [
    ...toolchain,
    "-O",
    "-target",
    TARGET,
    SOURCE,
    "-o",
    join(BUNDLE, "Contents", "MacOS", "MonaService"),
  ],
  { encoding: "utf8" },
);
if (compile.status !== 0) {
  report({ ok: false, error: "swiftc failed", stderr: compile.stderr.slice(-4000) });
  process.exit(1);
}

const sign = spawnSync("codesign", ["--force", "--sign", "-", BUNDLE], { encoding: "utf8" });
const verify = spawnSync("codesign", ["--verify", "--strict", BUNDLE], { encoding: "utf8" });
const executable = join(BUNDLE, "Contents", "MacOS", "MonaService");
const file = spawnSync("file", [executable], { encoding: "utf8" });
const describe = spawnSync(executable, ["--describe"], { encoding: "utf8" });

const bytes = readFileSync(executable);
const receiver = {
  schema_version: 1,
  ok: sign.status === 0 && verify.status === 0 && describe.status === 0,
  bundle: BUNDLE.replace(`${ROOT}/`, ""),
  target: TARGET,
  arch: process.arch,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  size: bytes.length,
  compiler: (available.stdout ?? "").split("\n")[0] ?? "unknown",
  file: (file.stdout ?? "").replace(`${ROOT}/`, "").trim(),
  plist_lint: (lint.stdout ?? "").trim(),
  signature: sign.status === 0 ? "ad-hoc" : "unsigned",
  signed: sign.status === 0,
  verified: verify.status === 0,
  descriptor: describe.status === 0 ? JSON.parse(describe.stdout) : null,
  built_at: new Date().toISOString(),
};
writeFileSync(join(BUILD_DIR, "build.json"), JSON.stringify(receiver, null, 2) + "\n", "utf8");
report(receiver);
process.exit(receiver.ok ? 0 : 1);
