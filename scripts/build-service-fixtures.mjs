#!/usr/bin/env node
// Build the P09 test fixtures: a receiver app that claims Mona's bundle
// identity and a harness that performs the registered Service the way macOS
// does. Test support only; neither bundle is part of the product payload.
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const SUPPORT = join(ROOT, "native/macos-services/test-support");
const BUILD = join(ROOT, "native/macos-services/build");
const TARGET = "arm64-apple-macos14.0";

const FIXTURES = [
  {
    name: "MonaProbe.app",
    executable: "MonaProbe",
    directory: "probe",
    source: join(SUPPORT, "probe/main.swift"),
  },
  {
    name: "P09Harness.app",
    executable: "P09Harness",
    directory: "harness",
    source: join(SUPPORT, "harness/main.swift"),
  },
];

function fail(message, extra = {}) {
  console.log(JSON.stringify({ ok: false, error: message, ...extra }, null, 2));
  process.exit(1);
}

if (process.platform !== "darwin" || process.arch !== "arm64") {
  console.log(
    JSON.stringify(
      {
        ok: false,
        skipped: true,
        reason: "fixtures require macOS arm64",
        native_qualification: "pending",
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const toolchain = ["--sdk", "macosx", "swiftc"];
const compiled = [];
for (const fixture of FIXTURES) {
  const bundle = join(BUILD, fixture.name);
  rmSync(bundle, { recursive: true, force: true });
  mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
  const copied = spawnSync("cp", [
    join(SUPPORT, fixture.directory, "Info.plist"),
    join(bundle, "Contents", "Info.plist"),
  ]);
  if (copied.status !== 0)
    fail(`could not copy Info.plist for ${fixture.name}`, { stderr: copied.stderr.toString() });
  const output = join(bundle, "Contents", "MacOS", fixture.executable);
  const compile = spawnSync(
    "xcrun",
    [...toolchain, "-O", "-target", TARGET, fixture.source, "-o", output],
    { encoding: "utf8" },
  );
  if (compile.status !== 0)
    fail(`swiftc failed for ${fixture.name}`, { stderr: compile.stderr.slice(-2000) });
  const sign = spawnSync("codesign", ["--force", "--sign", "-", bundle], { encoding: "utf8" });
  if (sign.status !== 0) fail(`codesign failed for ${fixture.name}`, { stderr: sign.stderr });
  const verify = spawnSync("codesign", ["--verify", "--strict", bundle], { encoding: "utf8" });
  if (verify.status !== 0)
    fail(`codesign verify failed for ${fixture.name}`, { stderr: verify.stderr });
  compiled.push(bundle.replace(`${ROOT}/`, ""));
}

console.log(JSON.stringify({ ok: true, fixtures: compiled, target: TARGET }, null, 2));
