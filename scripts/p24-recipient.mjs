#!/usr/bin/env node
// P24 — the clean-recipient qualification harness.
//
// The claim this task has to prove is "a stranger can just install this". That
// claim needs a host this repository does not have: a separate Apple silicon
// Mac or a clean supported VM, a *signed* installer, and a person to answer the
// Installer's authentication prompt. This script is the part that can be made
// repeatable and run today: it measures every matrix row that is a fact about
// the artifact or about this host, and it names the rows that cannot be settled
// here instead of quietly scoring them as passes.
//
//   node scripts/p24-recipient.mjs                       # uses packaging/macos/out
//   node scripts/p24-recipient.mjs --pkg <path.pkg>
//   node scripts/p24-recipient.mjs --out <file.json>
//
// Exit 0 means every row is settled and the artifact qualified. Anything else
// means the matrix has unsettled rows, which is what it is designed to report.
//
// Nothing here removes a quarantine attribute, disables Gatekeeper, or asks for
// administrator rights. Measuring that Gatekeeper rejects an unsigned package is
// the honest result, not an obstacle to route around.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MINIMUM_MACOS } from "../packaging/macos/lib/distribution.mjs";
import { readMachO } from "../packaging/macos/lib/macho.mjs";
import { reviewUninstallScript } from "../packaging/macos/lib/uninstall.mjs";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const OUT_DIR = join(ROOT, "packaging/macos/out");
const pkgPath = resolve(option("--pkg", join(OUT_DIR, "Mona-0.1.0-macOS-arm64-local.pkg")));
const outPath = resolve(
  option("--out", join(ROOT, "docs/evidence/macos/artifacts/p24-recipient.json")),
);

function run(command, commandArgs, options = {}) {
  try {
    const stdout = execFileSync(command, commandArgs, {
      encoding: "utf8",
      timeout: options.timeout ?? 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, status: 0, stdout, stderr: "" };
  } catch (error) {
    return {
      ok: false,
      status: typeof error.status === "number" ? error.status : -1,
      stdout: typeof error.stdout === "string" ? error.stdout : "",
      stderr: typeof error.stderr === "string" ? error.stderr : String(error.message),
    };
  }
}

const redact = (text) =>
  String(text ?? "")
    .replace(/\/var\/folders\/[^\s:]+/g, "~tmp")
    .replace(/\/private\/tmp\/[^\s:]+/g, "~tmp")
    .replace(/\/Users\/[A-Za-z0-9._-]+/g, "~")
    .split(process.env.HOME ?? "\u0000home\u0000")
    .join("~");

const sha256File = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

/**
 * Every row is one line of the prompt's matrix. `settled` is the only thing that
 * decides whether the artifact qualified: a row that cannot be measured here is
 * recorded as untested with the reason, never as a pass.
 */
const rows = [];
function row(id, claim, status, detail) {
  rows.push({ id, claim, status, detail: detail === undefined ? null : detail });
}

// ---------------------------------------------------------------- artifact

let payloadManifest = null;
if (!existsSync(pkgPath)) {
  row("artifact.present", "The distribution package exists", "failed", `${pkgPath} is absent`);
} else {
  const bytes = statSync(pkgPath);
  const signature = run("/usr/sbin/pkgutil", ["--check-signature", pkgPath]);
  const signed = /signed/i.test(signature.stdout) && !/unsigned/i.test(signature.stdout);
  row("artifact.present", "The distribution package exists and is identified", "passed", {
    path: pkgPath.replace(ROOT + "/", ""),
    sha256: sha256File(pkgPath),
    bytes: bytes.size,
    signature: signed ? signature.stdout.split("\n").slice(0, 3).join(" / ") : "unsigned",
    signed,
  });
  row(
    "artifact.signed",
    "The package carries a Developer ID Installer signature, so Gatekeeper can accept it",
    signed ? "passed" : "failed",
    signed
      ? "signed"
      : "the package is unsigned (ad-hoc local build); a recipient's Gatekeeper will refuse it, so the just-works claim cannot be made for these bytes",
  );

  // The payload the package actually contains, not the staging directory.
  const expandRoot = mkdtempSync(join(tmpdir(), "mona-p24-expand-"));
  // `--expand-full` unpacks the payload too, so the architecture check reads the
  // bytes the recipient would receive rather than the staging directory.
  const expand = run("/usr/sbin/pkgutil", ["--expand-full", pkgPath, join(expandRoot, "pkg")]);
  if (expand.ok) {
    const distribution = join(expandRoot, "pkg", "Distribution");
    if (existsSync(distribution)) {
      const xml = readFileSync(distribution, "utf8");
      const systemVersion = /systemVersion|os-version/.test(xml);
      const minDeclared = xml.includes(`min="14.0"`) || xml.includes(MINIMUM_MACOS);
      const archDeclared = /arm64/.test(xml);
      row(
        "installer.requirements",
        "The installer declares a minimum OS and remains arm64-only",
        systemVersion && minDeclared && archDeclared ? "passed" : "failed",
        {
          host_os_requirement: systemVersion,
          minimum_macos: minDeclared ? MINIMUM_MACOS : null,
          arm64_only: archDeclared,
        },
      );
    } else {
      row(
        "installer.requirements",
        "The installer declares a minimum OS",
        "failed",
        "no Distribution",
      );
    }
    const candidates = [
      join(expandRoot, "pkg", "Applications", "Mona.app"),
      join(expandRoot, "pkg", "component.pkg", "Payload", "Applications", "Mona.app"),
    ];
    const app = candidates.find((candidate) => existsSync(candidate)) ?? null;
    if (app && existsSync(join(app, "Contents/Resources/component-manifest.json"))) {
      payloadManifest = JSON.parse(
        readFileSync(join(app, "Contents/Resources/component-manifest.json"), "utf8"),
      );
      const minimums = new Set();
      const arches = new Set();
      for (const component of payloadManifest.components) {
        const path = join(app, "Contents/Resources", component.path);
        if (!existsSync(path) || component.kind === "image") continue;
        const header = readMachO(readFileSync(path));
        if (!header) continue;
        for (const arch of header.architectures) arches.add(arch);
        if (header.minOs) minimums.add(header.minOs);
      }
      const appOwned = [...minimums].filter((value) => value !== "11.0");
      row(
        "payload.architecture",
        "Every executable in the payload is arm64 and needs no newer OS than declared",
        arches.size === 1 && arches.has("arm64") ? "passed" : "failed",
        { architectures: [...arches], minimum_os: [...minimums], executables: arches.size > 0 },
      );
      row(
        "payload.minimum_os",
        "Approved payload code declares macOS 14.0; the pinned engine keeps its upstream floor",
        appOwned.length > 0 && appOwned.every((value) => value === MINIMUM_MACOS)
          ? "passed"
          : "failed",
        {
          app_owned: appOwned,
          engine_floor: [...minimums].includes("11.0") ? "11.0 (pinned upstream binary)" : null,
        },
      );
      // The removal utility installs into the receipt directory, not the bundle.
      const uninstallPath = join(
        expandRoot,
        "pkg",
        "component.pkg",
        "Payload",
        "Library",
        "Application Support",
        "Mona",
        "uninstall-mona.sh",
      );
      const uninstall = existsSync(uninstallPath)
        ? reviewUninstallScript(readFileSync(uninstallPath, "utf8"))
        : ["the removal utility is not in the payload"];
      row(
        "payload.uninstall_bounded",
        "The shipped removal utility is bounded and refuses unrecognized paths",
        uninstall.length === 0 ? "passed" : "failed",
        uninstall.length === 0 ? "contract satisfied" : uninstall,
      );
    } else {
      row(
        "payload.architecture",
        "The payload contains the app",
        "failed",
        "no Applications/Mona.app in the package",
      );
    }
    rmSync(expandRoot, { recursive: true, force: true });
  } else {
    row(
      "installer.requirements",
      "The package expands",
      "failed",
      redact(expand.stderr).slice(0, 300),
    );
  }
}

// ------------------------------------------------------- Gatekeeper / quarantine

const spctlStatus = run("/usr/sbin/spctl", ["--status"]);
row(
  "security.assessments_enabled",
  "Gatekeeper assessment is enabled and was not weakened for this test",
  /enabled/i.test(spctlStatus.stdout) ? "passed" : "failed",
  spctlStatus.stdout.trim() || spctlStatus.stderr.trim(),
);

if (existsSync(pkgPath)) {
  // A real recipient's file arrives with this attribute; setting it on a copy is
  // how the same assessment is reached without inventing a download server.
  const quarantineDir = mkdtempSync(join(tmpdir(), "mona-p24-quarantine-"));
  const copy = join(quarantineDir, "Mona-0.1.0-macOS-arm64.pkg");
  copyFileSync(pkgPath, copy);
  run("/usr/bin/xattr", ["-w", "com.apple.quarantine", "0081;00000000;Safari;", copy]);
  const attribute = run("/usr/bin/xattr", ["-p", "com.apple.quarantine", copy]);
  const assessment = run("/usr/sbin/spctl", ["-a", "-vv", "-t", "install", copy]);
  const verdict = `${assessment.stdout}${assessment.stderr}`.trim();
  row(
    "security.quarantine_present",
    "A quarantined copy carries the download attribute",
    attribute.ok && attribute.stdout.trim().length > 0 ? "passed" : "failed",
    attribute.stdout.trim(),
  );
  row(
    "security.gatekeeper_install",
    "Gatekeeper's assessment of the quarantined installer, with normal protections in place",
    assessment.ok ? "passed" : "failed",
    {
      verdict: redact(verdict).slice(0, 400),
      note: "This is the measurement a recipient would get. It is not worked around: no xattr removal, no spctl override, no right-click recipe.",
    },
  );
  rmSync(quarantineDir, { recursive: true, force: true });
}

// ------------------------------------------------------------- host prerequisites

const gitPath = run("/usr/bin/xcrun", ["--find", "git"]);
const clt = run("/usr/bin/xcode-select", ["-p"]);
const gitLooksLikeStub = /CommandLineTools/.test(clt.stdout) && !existsSync("/usr/local/bin/git");
row("host.git", "The recipient's Git situation, reported rather than assumed", "recorded", {
  xcrun_git: gitPath.ok ? gitPath.stdout.trim() : null,
  developer_dir: clt.ok ? clt.stdout.trim() : null,
  homebrew_git: existsSync("/opt/homebrew/bin/git"),
  only_the_clt_stub_here_means_the_inverse_of_this_host: gitLooksLikeStub,
  note: "This host has Command Line Tools, so it cannot stand in for a clean recipient. Packaged Mona refuses Apple's CLT stub rather than triggering the installer, so Git features report unavailable on a machine without Git.",
});

const os = run("/usr/bin/sw_vers", ["-productVersion"]);
const machine = run("/usr/sbin/sysctl", ["-n", "hw.machine"]);
row("host.identity", "The host this matrix ran on", "recorded", {
  macos: os.stdout.trim(),
  architecture: machine.stdout.trim(),
  note: "A development host with Xcode CLT, Homebrew and a cached engine. It cannot prove the absence of those things.",
});

// ------------------------------------------------------------- unsettled rows

const MANUAL = [
  [
    "recipient.clean_host",
    "A separate Apple silicon Mac or clean supported VM runs the exact signed installer through quarantine",
    "requires a second host or VM; this repository has neither",
  ],
  [
    "recipient.auth_install",
    "The standard Installer authentication prompt completes without a terminal step",
    "requires an administrator prompt on the recipient host",
  ],
  [
    "recipient.launch_after_install",
    "The installed app launches from Applications and the Finder Service opens a folder",
    "requires the install above; the LaunchServices launch itself is proven for the local build (R13)",
  ],
  [
    "recipient.new_user_api_setup",
    "A secure provider setup on a machine with no cached credential",
    "requires a user account that has never run Codewhale; this builds on second-user evidence, which the prompt says is not proof",
  ],
  [
    "recipient.offline_first_run",
    "Offline local operation before any provider is configured",
    "requires a recipient with no network path to a provider and no cached engine config",
  ],
  [
    "recipient.denied_folder_permission",
    "A denied or revoked folder permission produces a clear, non-destructive refusal",
    "requires manipulating TCC, which needs interactive consent",
  ],
  [
    "recipient.locked_keychain",
    "A locked keychain is reported, not retried into a loop",
    "requires a locked login keychain on the recipient",
  ],
  [
    "recipient.sleep_wake",
    "Sleep and wake leave the runtime in a stated state",
    "requires a physical lid close or a real suspend; simulated suspend is already covered by the lifecycle smoke",
  ],
  [
    "recipient.multiple_users",
    "Two users on one Mac do not share state or credentials",
    "requires a second account with administrator authorization",
  ],
  [
    "recipient.unsupported_os",
    "An unsupported macOS version is refused by the installer rather than half-installed",
    "requires a host below 14.0; the requirement is declared and the enforcement is in the preinstall script",
  ],
  [
    "recipient.clean_reinstall_upgrade_uninstall",
    "A clean reinstall, an upgrade over the previous build and an uninstall all behave",
    "the rehearsals and the P23 lifecycle smoke cover the mechanisms under isolated roots; the recipient run is the part that needs the host",
  ],
];
for (const [id, claim, reason] of MANUAL) row(id, claim, "untested", reason);

// ---------------------------------------------------------------- the verdict

const settled = rows.filter((entry) => entry.status !== "untested" && entry.status !== "recorded");
const failed = rows.filter((entry) => entry.status === "failed");
const untested = rows.filter((entry) => entry.status === "untested");
const report = {
  schema_version: 1,
  prompt: "P24",
  label: "clean-recipient qualification harness",
  captured_at: new Date().toISOString(),
  platform: { macos: os.stdout.trim(), architecture: machine.stdout.trim() },
  package: existsSync(pkgPath)
    ? {
        path: pkgPath.replace(ROOT + "/", ""),
        sha256: sha256File(pkgPath),
        bytes: statSync(pkgPath).size,
      }
    : null,
  payload_manifest: payloadManifest
    ? {
        version: payloadManifest.version,
        build: payloadManifest.build,
        channel: payloadManifest.channel,
        source: payloadManifest.source,
        engine: payloadManifest.engine?.version,
      }
    : null,
  rows,
  summary: {
    settled: settled.length,
    passed: rows.filter((entry) => entry.status === "passed").length,
    failed: failed.length,
    untested: untested.length,
    recorded: rows.filter((entry) => entry.status === "recorded").length,
  },
  // The claim this task is about needs every row, so the harness refuses to
  // return a qualification while any row is unsettled or failed.
  qualification: failed.length === 0 && untested.length === 0 ? "qualified" : "blocked",
  reasons: [
    ...failed.map(
      (entry) =>
        `${entry.id}: ${typeof entry.detail === "string" ? entry.detail : JSON.stringify(entry.detail)}`,
    ),
    ...untested.map((entry) => `${entry.id}: ${entry.detail}`),
  ],
  next: [
    "a Developer ID-signed, notarized, stapled installer (R14/EXT-SIGNING)",
    "a separate Apple silicon Mac or clean supported VM at macOS 14.0 and 26.x",
    "one administrator authentication prompt on that host",
  ],
  note: "Rows marked untested are facts this host cannot establish. Nothing was removed from the matrix and no requirement was lowered to make it pass.",
};

writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(
  JSON.stringify(
    {
      ok: report.qualification === "qualified",
      qualification: report.qualification,
      summary: report.summary,
      out: outPath.replace(ROOT + "/", ""),
    },
    null,
    2,
  ),
);
process.exit(report.qualification === "qualified" ? 0 : 1);
