#!/usr/bin/env node
/**
 * P22 — the release pipeline: preflight, signed/notarized release, and
 * independent verification of the artifact that was produced.
 *
 * Three commands, one rule: **the release command never emits unsigned output
 * as production.** Without a Developer ID identity and a notary credential the
 * pipeline stops at preflight and says exactly what is missing. It does not
 * build a lookalike, does not skip notarization, and does not relabel an ad-hoc
 * package.
 *
 * No secret is ever printed or written. The keychain profile is named, never
 * read; an app-specific password is only ever a boolean.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { MINIMUM_MACOS, packageFileName } from "./lib/distribution.mjs";
import {
  notaryVerdict,
  parseIdentities,
  parseNotarySubmission,
  preflightReport,
  redactHost,
  releaseReceipt,
  selectIdentities,
} from "./lib/signing.mjs";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);
const OUT_DIR = join(ROOT, "packaging/macos/out");
const HOME = homedir();
const ARGS = process.argv.slice(2);
const COMMAND = ARGS.find((arg) => !arg.startsWith("-")) ?? "preflight";
const verbose = ARGS.includes("--verbose");

function flag(name) {
  const index = ARGS.indexOf(`--${name}`);
  return index >= 0 ? (ARGS[index + 1] ?? "") : null;
}

function has(name) {
  return ARGS.includes(`--${name}`);
}

function log(message) {
  if (verbose || COMMAND === "release") process.stderr.write(`${message}\n`);
}

function run(command, args, { allowFailure = false, timeout = 120_000 } = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout });
  if (!allowFailure && result.status !== 0) {
    const error = new Error(
      `${basename(command)} ${args.join(" ")} failed (${result.status}): ${redact(`${result.stderr ?? ""}`).slice(0, 600)}`,
    );
    error.status = result.status;
    throw error;
  }
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function redact(text) {
  return redactHost(text, { home: HOME, checkout: ROOT });
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function versionOf(command, args) {
  const result = run(command, args, { allowFailure: true });
  const text = `${result.stdout}\n${result.stderr}`.trim().split("\n")[0];
  return result.ok && text ? text : null;
}

function findTool(name) {
  const result = run("/usr/bin/xcrun", ["--find", name], { allowFailure: true });
  return result.ok ? result.stdout.trim() : null;
}

// --------------------------------------------------------------- facts

function hostFacts() {
  const product = versionOf("/usr/bin/sw_vers", ["-productVersion"]);
  const build = versionOf("/usr/bin/sw_vers", ["-buildVersion"]);
  const translated = run("/usr/sbin/sysctl", ["-n", "sysctl.proc_translated"], {
    allowFailure: true,
  });
  return {
    darwin: process.platform === "darwin",
    arm64: process.arch === "arm64",
    macos: product,
    macos_build: build,
    translated: translated.stdout.trim() === "1",
    node: process.version,
    minimum_macos: MINIMUM_MACOS,
  };
}

function toolFacts() {
  const required = {
    codesign: "/usr/bin/codesign",
    pkgbuild: "/usr/bin/pkgbuild",
    productbuild: "/usr/bin/productbuild",
    productsign: "/usr/bin/productsign",
    pkgutil: "/usr/sbin/pkgutil",
    spctl: "/usr/sbin/spctl",
    security: "/usr/bin/security",
    plutil: "/usr/bin/plutil",
  };
  const missing = Object.entries(required)
    .filter(([, path]) => !existsSync(path))
    .map(([name]) => name);
  const notarytool = findTool("notarytool");
  const stapler = findTool("stapler");
  if (!notarytool) missing.push("notarytool");
  if (!stapler) missing.push("stapler");
  return {
    missing,
    versions: {
      codesign: versionOf("/usr/bin/codesign", ["--version"]),
      pkgbuild: versionOf("/usr/bin/pkgbuild", ["--version"]),
      productbuild: versionOf("/usr/bin/productbuild", ["--version"]),
      productsign: versionOf("/usr/bin/productsign", ["--version"]),
      notarytool: notarytool ? versionOf(notarytool, ["--version"]) : null,
      stapler: stapler ? versionOf(stapler, ["--version"]) : null,
    },
    paths: { notarytool, stapler, ...required },
  };
}

function identityFacts() {
  const result = run("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"], {
    allowFailure: true,
  });
  const all = parseIdentities(result.stdout);
  const selected = selectIdentities(all);
  const teamOf = (identity) => /\(([A-Z0-9]{10})\)\s*$/.exec(identity?.name ?? "")?.[1] ?? null;
  return {
    count: all.length,
    names: all.map((identity) => identity.name),
    // `find-identity -v` lists only identities whose certificate and private key
    // are present and valid, so presence *is* the validity evidence; an expired
    // or revoked certificate does not appear here at all.
    validity: "only valid identities are listed by find-identity -v",
    application: selected.application,
    installer: selected.installer,
    team: selected.team,
    team_mismatch:
      Boolean(selected.application && selected.installer) &&
      teamOf(selected.application) !== teamOf(selected.installer),
    problems: selected.problems,
  };
}

/**
 * Is a notarization credential configured? Three supported shapes:
 * a named keychain profile, an app-specific password in the environment, or an
 * App Store Connect API key. Only *presence* is reported; no value is read into
 * this process or written anywhere.
 */
function notaryFacts() {
  const profile = flag("keychain-profile") ?? process.env.MONA_NOTARY_PROFILE ?? null;
  const appleId = process.env.MONA_NOTARY_APPLE_ID ?? process.env.APPLE_ID ?? null;
  const teamId = process.env.MONA_NOTARY_TEAM_ID ?? process.env.APPLE_TEAM_ID ?? null;
  const password = process.env.MONA_NOTARY_PASSWORD ?? process.env.APPLE_APP_PASSWORD ?? null;
  const apiKey = process.env.MONA_NOTARY_API_KEY ?? null;
  if (profile) {
    const present = run(
      "/usr/bin/security",
      ["find-generic-password", "-s", "com.apple.gke.notary.tool", "-a", profile],
      { allowFailure: true },
    );
    return {
      configured: present.ok,
      method: "keychain-profile",
      profile,
      reason: present.ok
        ? null
        : `keychain profile "${profile}" was named but no matching notarization credential is stored; add it with "xcrun notarytool store-credentials ${profile}"`,
    };
  }
  if (appleId && teamId && password) {
    return {
      configured: true,
      method: "app-specific-password",
      profile: null,
      apple_id_present: true,
      team_id_present: true,
      reason: null,
    };
  }
  if (apiKey) {
    return {
      configured: true,
      method: "api-key",
      profile: null,
      reason: null,
    };
  }
  return {
    configured: false,
    method: null,
    profile: null,
    reason:
      "no notarization credential is configured: pass --keychain-profile <name>, or set MONA_NOTARY_APPLE_ID, MONA_NOTARY_TEAM_ID and MONA_NOTARY_PASSWORD, or MONA_NOTARY_API_KEY",
  };
}

function sourceFacts() {
  const status = run("/usr/bin/git", ["status", "--porcelain", "--untracked-files=no"], {
    allowFailure: true,
  });
  const dirty = status.ok
    ? status.stdout.split("\n").filter((line) => line.trim().length > 0).length
    : null;
  const commit = run("/usr/bin/git", ["rev-parse", "HEAD"], { allowFailure: true });
  let verified = null;
  try {
    const state = JSON.parse(readFileSync(join(ROOT, ".mona/build-macos/state.json"), "utf8"));
    verified = state.last_verified_commit ?? null;
  } catch {
    verified = null;
  }
  return {
    clean: dirty === 0,
    dirty_files: dirty,
    commit: commit.ok ? commit.stdout.trim() : null,
    last_verified_commit: verified,
    matches_verified:
      verified !== null && commit.ok ? commit.stdout.trim().startsWith(verified) : null,
  };
}

function manifestFacts() {
  const path = join(OUT_DIR, "manifest.json");
  if (!existsSync(path)) {
    // Not a failure at preflight: the release build produces it. The check
    // exists so a *stale* manifest next to a fresh package cannot pass.
    return {
      ok: true,
      present: false,
      note: "no build manifest yet; the release build writes one",
    };
  }
  const problems = [];
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return {
      ok: false,
      present: true,
      problems: [`manifest.json is unreadable: ${String(error)}`],
    };
  }
  const architectures = new Set();
  for (const component of manifest.components ?? []) {
    for (const arch of component.architectures ?? []) architectures.add(arch);
  }
  if (architectures.size > 0 && [...architectures].some((arch) => arch !== "arm64")) {
    problems.push(
      `the payload contains non-arm64 slices: ${[...architectures].filter((arch) => arch !== "arm64").join(", ")}`,
    );
  }
  return {
    ok: problems.length === 0,
    present: true,
    architectures: [...architectures],
    minimum_macos: manifest.minimum_macos ?? null,
    problems,
  };
}

function evidenceFacts() {
  const problems = [];
  const ledgerPath = join(ROOT, ".mona/build-macos/reviews/studio-v2/state.json");
  if (!existsSync(ledgerPath)) {
    problems.push("the review ledger is absent; release evidence cannot be traced");
  }
  const dir = join(ROOT, "docs/evidence/macos");
  if (!existsSync(dir)) problems.push("docs/evidence/macos is absent");
  return { ok: problems.length === 0, problems, reviewed: existsSync(ledgerPath) };
}

function gatherFacts() {
  return {
    generatedUtc: new Date().toISOString(),
    host: hostFacts(),
    tools: toolFacts(),
    identities: identityFacts(),
    notary: notaryFacts(),
    source: sourceFacts(),
    manifest: manifestFacts(),
    evidence: evidenceFacts(),
  };
}

// ------------------------------------------------------------- commands

function preflight() {
  const facts = gatherFacts();
  const { ok, problems, report } = preflightReport(facts);
  report.command = "preflight";
  report.next = ok
    ? ["npm run mac:release"]
    : [
        "install a Developer ID Application and Developer ID Installer identity in the login keychain",
        "store notarization credentials with: xcrun notarytool store-credentials <profile>",
        "then re-run: npm run mac:release:preflight",
      ];
  const path = join(OUT_DIR, "release-preflight.json");
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!ok) {
    process.stderr.write(
      `\nRelease preflight refused (${problems.length} problem${problems.length === 1 ? "" : "s"}):\n` +
        problems.map((problem) => `  - ${problem}`).join("\n") +
        "\nNo artifact was built, signed, or published.\n",
    );
    process.exit(3);
  }
  process.stderr.write("Release preflight passed. Nothing has been signed or notarized yet.\n");
}

function packagePathFor() {
  const version = String(
    JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version,
  ).replace(/-p\d+$/, "");
  return join(OUT_DIR, packageFileName({ version, channel: "release" }));
}

function notarizeArguments(profile) {
  if (profile) return ["--keychain-profile", profile];
  if (process.env.MONA_NOTARY_API_KEY) {
    return [
      "--key",
      process.env.MONA_NOTARY_API_KEY,
      "--key-id",
      process.env.MONA_NOTARY_KEY_ID ?? "",
      "--issuer",
      process.env.MONA_NOTARY_ISSUER ?? "",
    ];
  }
  return [
    "--apple-id",
    process.env.MONA_NOTARY_APPLE_ID ?? process.env.APPLE_ID ?? "",
    "--team-id",
    process.env.MONA_NOTARY_TEAM_ID ?? process.env.APPLE_TEAM_ID ?? "",
    "--password",
    process.env.MONA_NOTARY_PASSWORD ?? process.env.APPLE_APP_PASSWORD ?? "",
  ];
}

function assessPackage(path, { stapler, spctl }) {
  const assessments = {};
  const signature = run("/usr/sbin/pkgutil", ["--check-signature", path], { allowFailure: true });
  assessments.package_signature = {
    ok: signature.ok,
    detail: redact(`${signature.stdout}\n${signature.stderr}`).trim().slice(0, 800),
  };
  const staple = run(stapler, ["validate", path], { allowFailure: true });
  assessments.stapler = {
    ok: staple.ok,
    detail: redact(`${staple.stdout}\n${staple.stderr}`).trim().slice(0, 800),
  };
  const gatekeeper = run(spctl, ["-a", "-vvv", "-t", "install", path], { allowFailure: true });
  assessments.gatekeeper = {
    ok: gatekeeper.ok,
    detail: redact(`${gatekeeper.stderr || gatekeeper.stdout}`)
      .trim()
      .slice(0, 800),
  };
  return assessments;
}

function release() {
  const facts = gatherFacts();
  const { ok, problems } = preflightReport(facts);
  if (!ok) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, command: "release", stage: "preflight", problems }, null, 2)}\n`,
    );
    process.stderr.write(
      "Release refused at preflight. No unsigned package was produced.\n" +
        problems.map((problem) => `  - ${problem}`).join("\n") +
        "\n",
    );
    process.exit(3);
  }

  const profile = facts.notary.profile;
  log("preflight passed; building the signed release package");
  // The build owns payload assembly and inside-out signing. It fails closed if
  // an identity disappears between preflight and here.
  const build = run(
    process.execPath,
    [
      join(ROOT, "packaging/macos/build.mjs"),
      "--mode",
      "release",
      ...(has("skip-build") ? ["--skip-build"] : []),
      ...(profile ? ["--keychain-profile", profile] : []),
    ],
    { allowFailure: true, timeout: 30 * 60_000 },
  );
  if (!build.ok) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, command: "release", stage: "build", detail: redact(build.stderr).slice(-4000) }, null, 2)}\n`,
    );
    process.stderr.write("The signed build failed; nothing was notarized or published.\n");
    process.exit(1);
  }

  const pkg = packagePathFor();
  if (!existsSync(pkg)) {
    process.stderr.write(`the build did not produce ${pkg}\n`);
    process.exit(1);
  }

  const tools = facts.tools.paths;
  log("submitting the package for notarization");
  const submit = run(
    tools.notarytool,
    ["submit", pkg, "--output-format", "json", "--wait", ...notarizeArguments(profile)],
    { allowFailure: true, timeout: 60 * 60_000 },
  );
  const submission = parseNotarySubmission(submit.stdout);
  const verdict = notaryVerdict(submission.status);
  const logPath = join(OUT_DIR, "notary-log.json");
  if (submission.id) {
    // Fetching the log is idempotent and read-only. It is redacted before it is
    // written, because Apple's log can echo local paths.
    const detail = run(tools.notarytool, ["log", submission.id, ...notarizeArguments(profile)], {
      allowFailure: true,
    });
    writeFileSync(logPath, `${redact(detail.stdout)}\n`, "utf8");
  }
  if (verdict !== "accepted") {
    const report = {
      ok: false,
      command: "release",
      stage: "notarization",
      submission,
      verdict,
      log_path: submission.id ? logPath : null,
      note:
        verdict === "pending"
          ? "The submission is still being processed. Re-run verification later; do not submit a second copy of the same package."
          : "Notarization did not return Accepted. Apple's log is beside this report.",
    };
    writeFileSync(join(OUT_DIR, "release.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.stderr.write("The package was not notarized; it is not a release.\n");
    process.exit(2);
  }

  log("stapling the ticket");
  const staple = run(tools.stapler, ["staple", pkg], { allowFailure: true });
  if (!staple.ok) {
    process.stderr.write(`stapling failed: ${redact(staple.stderr).slice(0, 600)}\n`);
    process.exit(1);
  }
  const assessments = assessPackage(pkg, tools);
  const receipt = releaseReceipt({
    packagePath: pkg,
    packageSha256: sha256File(pkg),
    packageBytes: statSync(pkg).size,
    version: String(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version).replace(
      /-p\d+$/,
      "",
    ),
    build: facts.source.commit ? facts.source.commit.slice(0, 12) : null,
    commit: facts.source.commit,
    identities: {
      application: facts.identities.application,
      installer: facts.identities.installer,
      team: facts.identities.team,
    },
    notary: {
      id: submission.id,
      status: submission.status,
      logPath: submission.id ? logPath : null,
    },
    assessments,
    generatedUtc: new Date().toISOString(),
  });
  const okAssessments = Object.values(assessments).every((entry) => entry.ok === true);
  const report = {
    ok: okAssessments,
    command: "release",
    receipt,
    note: okAssessments
      ? "Signed, notarized (Accepted), stapled, and assessed. Nothing was published."
      : "Notarization was Accepted, but a local assessment failed; the package is not promoted.",
  };
  writeFileSync(
    join(OUT_DIR, "release-receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(join(OUT_DIR, "release.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exit(2);
}

function verify() {
  const explicit = flag("package");
  const pkg = explicit ? resolve(explicit) : packagePathFor();
  const receiptPath = join(OUT_DIR, "release-receipt.json");
  const problems = [];
  if (!existsSync(pkg)) problems.push(`package is absent: ${pkg}`);
  if (!existsSync(receiptPath)) problems.push(`release receipt is absent: ${receiptPath}`);
  const receipt = existsSync(receiptPath) ? JSON.parse(readFileSync(receiptPath, "utf8")) : null;
  const digest = existsSync(pkg) ? sha256File(pkg) : null;
  if (receipt && digest && receipt.package?.sha256 !== digest) {
    problems.push(
      `the package digest does not match the receipt (receipt ${receipt.package?.sha256}, file ${digest})`,
    );
  }
  const facts = gatherFacts();
  const tools = facts.tools.paths;
  const assessments =
    existsSync(pkg) && tools.stapler && tools.spctl ? assessPackage(pkg, tools) : {};
  for (const [name, entry] of Object.entries(assessments)) {
    if (!entry.ok) problems.push(`${name} assessment failed: ${entry.detail}`);
  }
  const report = {
    ok: problems.length === 0,
    command: "verify",
    package: pkg,
    digest,
    receipt_digest: receipt?.package?.sha256 ?? null,
    notarization: receipt?.notarization ?? null,
    assessments,
    problems,
    note:
      problems.length === 0
        ? "The promoted bytes match the receipt, the ticket validates offline, and Gatekeeper assesses the installer."
        : "This artifact is not a verifiable release.",
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (problems.length > 0) process.exit(2);
}

const commands = { preflight, release, verify };
if (!commands[COMMAND]) {
  process.stderr.write(
    "usage: release.mjs <preflight|release|verify> [--keychain-profile NAME] [--package PATH]\n",
  );
  process.exit(64);
}
try {
  commands[COMMAND]();
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({ ok: false, command: COMMAND, error: redact(error?.message ?? String(error)) }, null, 2)}\n`,
  );
  process.exit(1);
}
