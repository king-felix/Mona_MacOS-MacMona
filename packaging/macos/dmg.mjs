#!/usr/bin/env node
// Local disk image for this Mac — the distribution this build actually has.
//
// There is no Developer ID identity and no notary credential on this project, so
// there is no shareable release: `mac:release` refuses (see R14). What can be
// made honestly is a **local** disk image of an ad-hoc-signed, arm64 app, clearly
// labelled as such, that the owner can mount and drag to `/Applications` on this
// machine — and that anyone else would have to build themselves.
//
//   node packaging/macos/dmg.mjs                        # from packaging/macos/out
//   node packaging/macos/dmg.mjs --app <Mona.app>       # from an explicit bundle
//   node packaging/macos/dmg.mjs --out <file.dmg>
//
// The image is verified from its own bytes after it is written: mounted
// read-only, the app inside is hashed and compared with the app that went in, and
// the volume is detached. Exit 0 only when that comparison matches.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const OUT_DIR = join(ROOT, "packaging/macos/out");
const appPath = resolve(
  option("--app", join(OUT_DIR, "stage", "payload", "Applications", "Mona.app")),
);
const outPath = resolve(option("--out", join(OUT_DIR, "Mona-0.1.0-macOS-arm64-local.dmg")));
const reportPath = resolve(option("--report", join(OUT_DIR, "dmg-report.json")));

function run(command, commandArgs, options = {}) {
  try {
    return {
      ok: true,
      stdout: execFileSync(command, commandArgs, {
        encoding: "utf8",
        timeout: options.timeout ?? 300_000,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (error) {
    return {
      ok: false,
      stdout: typeof error.stdout === "string" ? error.stdout : "",
      stderr: typeof error.stderr === "string" ? error.stderr : String(error.message),
    };
  }
}

const fail = (message) => {
  process.stderr.write(`dmg: ${message}\n`);
  process.exit(1);
};

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

/**
 * The same content digest the packaging gate compares: sorted relative paths,
 * file hashes, symlink targets — minus `CodeResources`, whose bytes differ
 * between two identical ad-hoc signings.
 */
function contentDigest(root) {
  const entries = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const info = lstatSync(path);
      const rel = relative(root, path);
      if (info.isSymbolicLink()) {
        entries.push(`${rel}\0link:${readlinkSync(path)}\n`);
      } else if (info.isDirectory()) {
        visit(path);
      } else if (info.isFile()) {
        if (rel.endsWith("_CodeSignature/CodeResources")) continue;
        entries.push(`${rel}\0${sha256(path)}\n`);
      }
    }
  };
  visit(root);
  return createHash("sha256").update(entries.join("")).digest("hex");
}

if (!existsSync(appPath)) {
  fail(`no app at ${appPath}; run "npm run mac:package:local" first`);
}
const manifestPath = join(appPath, "Contents/Resources/component-manifest.json");
if (!existsSync(manifestPath)) fail(`no component manifest at ${manifestPath}`);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

// An image of a *release* build would be a claim this project cannot make; the
// channel in the artifact decides, not the file name.
if (manifest.channel !== "local") {
  fail(
    `the app's channel is "${manifest.channel}"; this script only images a local ` +
      "build. A shareable release is `npm run mac:release` and needs credentials.",
  );
}

// The bundle this images must be the one the packaging run accepted. A stale
// stage directory would otherwise produce a tidy image of the wrong code.
const signature = run("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath]);
if (!signature.ok) fail(`the app does not verify: ${(signature.stderr ?? "").slice(0, 400)}`);

const stage = mkdtempSync(join(tmpdir(), "mona-dmg-"));
const volumeName = `Mona ${manifest.version} (local)`;
const notice = `Mona ${manifest.version} — local build ${manifest.build}

This is an ad-hoc signed development build made on the machine it is meant for.

  • It is NOT a release. There is no Developer ID signature and no notarization
    ticket, so macOS will refuse it on any other Mac (Gatekeeper: "not signed by
    a recognised developer"). That is expected, not a fault to work around.
  • Anyone else who wants Mona builds it from the source at
    ${manifest.source?.commit ?? "(unrecorded commit)"} with "npm run mac:package:local".
  • To install on this Mac: drag Mona to Applications, then open it. The app
    keeps its state in ~/Library/Application Support/Mona.

Build:    ${manifest.build}
Channel:  ${manifest.channel}
Engine:   codewhale ${manifest.engine?.version ?? "unknown"}
Source:   ${manifest.source?.commit ?? "unknown"}
Minimum:  macOS ${manifest.minimum_macos}
Signing:  ad-hoc (no team identifier)
`;

writeFileSync(join(stage, "READ ME — LOCAL BUILD.txt"), notice, "utf8");
copyFileSync(join(ROOT, "docs/owner-guide-macos.md"), join(stage, "Owner guide.md"));
symlinkSync("/Applications", join(stage, "Applications"));
// `ditto` preserves the bundle's metadata, extended attributes and symlinks; a
// plain recursive copy does not, and a damaged seal would fail on launch.
const copied = run("/usr/bin/ditto", [appPath, join(stage, basename(appPath))]);
if (!copied.ok) fail(`could not stage the app: ${(copied.stderr ?? "").slice(0, 400)}`);

const sourceDigest = contentDigest(appPath);
const stagedDigest = contentDigest(join(stage, basename(appPath)));
if (sourceDigest !== stagedDigest) fail("the staged copy is not byte-identical to the built app");

if (existsSync(outPath)) rmSync(outPath);

const created = run("/usr/bin/hdiutil", [
  "create",
  "-volname",
  volumeName,
  "-srcfolder",
  stage,
  "-fs",
  "HFS+",
  "-format",
  "UDZO",
  "-ov",
  outPath,
]);
if (!created.ok) fail(`hdiutil failed: ${(created.stderr ?? created.stdout ?? "").slice(0, 400)}`);

// ---- verify the image from its own bytes ----------------------------------

const checks = {};
const mountPoint = mkdtempSync(join(tmpdir(), "mona-dmg-mount-"));
const attached = run("/usr/bin/hdiutil", [
  "attach",
  "-nobrowse",
  "-readonly",
  "-mountpoint",
  mountPoint,
  outPath,
]);
if (!attached.ok) {
  rmSync(mountPoint, { recursive: true, force: true });
  fail(`could not mount the image it just wrote: ${(attached.stderr ?? "").slice(0, 400)}`);
}
try {
  const mountedApp = join(mountPoint, basename(appPath));
  checks.app_present = existsSync(mountedApp);
  checks.notice_present = existsSync(join(mountPoint, "READ ME — LOCAL BUILD.txt"));
  checks.applications_link = existsSync(join(mountPoint, "Applications"));
  checks.app_matches_built = checks.app_present && contentDigest(mountedApp) === sourceDigest;
  checks.manifest_build = existsSync(join(mountedApp, "Contents/Resources/component-manifest.json"))
    ? JSON.parse(
        readFileSync(join(mountedApp, "Contents/Resources/component-manifest.json"), "utf8"),
      ).build === manifest.build
    : false;
  const sealed = checks.app_present
    ? run("/usr/bin/codesign", ["--verify", "--deep", "--strict", mountedApp])
    : { ok: false };
  checks.app_signature_verifies = sealed.ok === true;
  // A DMG that is not signed cannot itself be assessed; record the fact rather
  // than dressing an unsigned image as one Gatekeeper would accept.
  const assessment = run("/usr/sbin/spctl", [
    "-a",
    "-t",
    "open",
    "--context",
    "context:primary-signature",
    outPath,
  ]);
  checks.gatekeeper_would_accept = assessment.ok === true;
} finally {
  run("/usr/bin/hdiutil", ["detach", mountPoint, "-force"]);
  rmSync(mountPoint, { recursive: true, force: true });
  rmSync(stage, { recursive: true, force: true });
}

const receipt = {
  schema_version: 1,
  label: "Mona local disk image",
  generated_utc: new Date().toISOString(),
  image: {
    path: relative(ROOT, outPath),
    sha256: sha256(outPath),
    bytes: statSync(outPath).size,
    volume_name: volumeName,
    // Stated, not implied: an unsigned image is not a Gatekeeper-acceptable
    // download, and this field is what a later reader will look for.
    signed: false,
    notarized: false,
  },
  app: {
    build: manifest.build,
    version: manifest.version,
    channel: manifest.channel,
    source_commit: manifest.source?.commit ?? null,
    source_dirty: manifest.source?.source_dirty ?? manifest.source?.dirty ?? null,
    minimum_macos: manifest.minimum_macos,
    content_sha256: sourceDigest,
    signing: "ad-hoc",
  },
  engine: manifest.engine ?? null,
  checks,
  note:
    "A local, ad-hoc signed development image. Gatekeeper rejects it on any other Mac by " +
    "design; there is no Developer ID signature and no notarization ticket (R14).",
};

writeFileSync(reportPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
const ok = Object.entries(checks)
  .filter(([name]) => name !== "gatekeeper_would_accept")
  .every(([, value]) => value === true);

process.stdout.write(
  `${JSON.stringify(
    {
      ok,
      image: receipt.image,
      app: { build: receipt.app.build, source_commit: receipt.app.source_commit },
      checks,
      report: relative(ROOT, reportPath),
    },
    null,
    2,
  )}\n`,
);
process.exit(ok ? 0 : 1);
