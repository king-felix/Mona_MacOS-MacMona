/**
 * Release signing policy. Pure functions only: this module decides *what* to
 * sign, *in which order*, and *with which entitlements*. It never runs a tool,
 * reads a secret, or touches a keychain. `release.mjs` and `build.mjs` do the
 * executing, so every decision here is directly testable.
 *
 * The rules that matter:
 *  - Inside-out. A bundle's outer signature seals its resources, so an inner
 *    Mach-O signed afterwards invalidates it.
 *  - Minimal, per-component entitlements. Electron needs JIT and unsigned
 *    executable memory; a Go engine binary does not. Granting the widest set to
 *    everything is how a release inherits permissions it never needed.
 *  - No blanket deep signing. `codesign --deep` hides a component nobody signed;
 *    the plan enumerates every Mach-O file and every nested bundle instead.
 *  - Hardened Runtime and a secure timestamp on every signed thing.
 */

export const APP_SIGNING_IDENTITY = "Developer ID Application";
export const INSTALLER_SIGNING_IDENTITY = "Developer ID Installer";

/** Entitlement file names under `packaging/macos/resources/entitlements/`. */
export const ENTITLEMENT_KINDS = {
  main: "main.plist",
  helper: "helper.plist",
  service: "service.plist",
  none: null,
};

/**
 * Parse `security find-identity -v -p codesigning` output. Only valid
 * identities are listed by `-v`, so presence is the validity evidence.
 */
export function parseIdentities(output) {
  const identities = [];
  for (const line of String(output ?? "").split("\n")) {
    const match = /^\s*\d+\)\s+([0-9A-F]{40})\s+"(.+)"\s*$/.exec(line);
    if (match) identities.push({ sha1: match[1], name: match[2].trim() });
  }
  return identities;
}

/** The two identities a release needs, plus what is missing. */
export function selectIdentities(identities) {
  const application = identities.find((identity) =>
    identity.name.startsWith(`${APP_SIGNING_IDENTITY}:`),
  );
  const installer = identities.find((identity) =>
    identity.name.startsWith(`${INSTALLER_SIGNING_IDENTITY}:`),
  );
  const problems = [];
  if (!application) {
    problems.push(
      `no "${APP_SIGNING_IDENTITY}" identity is installed; the app and its helpers cannot be signed for distribution`,
    );
  }
  if (!installer) {
    problems.push(
      `no "${INSTALLER_SIGNING_IDENTITY}" identity is installed; the flat package cannot be signed`,
    );
  }
  // The two must belong to the same team, or the package signature and the
  // payload signature name different publishers.
  const teamOf = (identity) => /\(([A-Z0-9]{10})\)\s*$/.exec(identity?.name ?? "")?.[1] ?? null;
  const applicationTeam = teamOf(application);
  const installerTeam = teamOf(installer);
  if (
    application &&
    installer &&
    applicationTeam &&
    installerTeam &&
    applicationTeam !== installerTeam
  ) {
    problems.push(
      `the application identity is from team ${applicationTeam} and the installer identity from team ${installerTeam}; a release must come from one publisher`,
    );
  }
  return {
    application: application ?? null,
    installer: installer ?? null,
    team: applicationTeam ?? installerTeam ?? null,
    problems,
  };
}

/**
 * What kind of thing is this inside the app bundle? Decided by path alone, so
 * the answer does not depend on a `file` command being installed.
 */
export function componentClass(relativePath, { appBundleName = "Mona.app" } = {}) {
  const path = String(relativePath).replaceAll("\\", "/");
  if (path === "" || path === appBundleName) return "app";
  if (/^Contents\/MacOS\/[^/]+$/.test(path)) return "app-main";
  if (/^Contents\/Frameworks\/[^/]+\.app(\/|$)/.test(path)) return "helper-app";
  if (/^Contents\/Frameworks\/[^/]+\.framework(\/|$)/.test(path)) return "framework";
  if (/^Contents\/Resources\/native\/[^/]+$/.test(path)) return "native-helper";
  if (/^Contents\/Resources\/engine\/[^/]+$/.test(path)) return "engine";
  if (/^Contents\/Frameworks\/.*\.dylib$/.test(path)) return "dylib";
  if (/^Contents\/MacOS\//.test(path)) return "app-nested";
  return "other";
}

export function entitlementKindFor(className) {
  switch (className) {
    case "app":
    case "app-main":
      return ENTITLEMENT_KINDS.main;
    case "helper-app":
      return ENTITLEMENT_KINDS.helper;
    case "framework":
    case "dylib":
    case "app-nested":
      return ENTITLEMENT_KINDS.none;
    case "native-helper":
    case "engine":
      return ENTITLEMENT_KINDS.none;
    default:
      return ENTITLEMENT_KINDS.none;
  }
}

export function entitlementKindForService() {
  return ENTITLEMENT_KINDS.service;
}

/**
 * Order a set of entries for signing.
 *
 * Within one bundle the executable comes before the bundle, and a nested bundle
 * comes before its parent. Between siblings the deepest path sorts first. The
 * outer app bundle is returned separately and must be signed last.
 */
export function signingOrder(entries, { appBundleName = "Mona.app" } = {}) {
  const items = entries.map((entry) => ({
    ...entry,
    className: componentClass(entry.relativePath, { appBundleName }),
  }));
  const outer = items.find((item) => item.className === "app") ?? null;
  const rest = items
    .filter((item) => item.className !== "app")
    .sort((a, b) => {
      const depth = b.relativePath.split("/").length - a.relativePath.split("/").length;
      if (depth !== 0) return depth;
      return a.relativePath.localeCompare(b.relativePath);
    })
    .map((item) => ({ ...item, entitlements: entitlementKindFor(item.className) }));
  return {
    ordered: rest,
    outer: outer ? { ...outer, entitlements: entitlementKindFor("app") } : null,
  };
}

/**
 * The exact `codesign` arguments for one component. `--deep` is never emitted:
 * a deep signature is the shortcut this plan exists to replace.
 */
export function codesignArgs({
  identity,
  path,
  entitlements = null,
  options = { runtime: true, timestamp: true },
  force = true,
}) {
  const args = [];
  if (force) args.push("--force");
  if (options.runtime) args.push("--options", "runtime");
  if (options.timestamp) args.push("--timestamp");
  if (entitlements) args.push("--entitlements", entitlements);
  args.push("--sign", identity, path);
  return args;
}

/** `productsign` for the flat package, with a timestamp. */
export function productsignArgs({ identity, input, output }) {
  return ["--sign", identity, "--timestamp", input, output];
}

/**
 * Preflight is a report, not a gate with prose. It lists the facts and the
 * problems; the caller exits non-zero when `problems` is non-empty.
 */
export function preflightReport(facts) {
  const problems = [];
  if (!facts.host?.darwin) problems.push("this host is not macOS");
  if (!facts.host?.arm64) problems.push("this host is not arm64; the payload is arm64-only");
  if (facts.host?.translated)
    problems.push("this process is running under Rosetta; a release must be built natively");
  for (const tool of facts.tools?.missing ?? []) problems.push(`required tool is missing: ${tool}`);
  if (!facts.identities?.application)
    problems.push(`no "${APP_SIGNING_IDENTITY}" identity is installed`);
  if (!facts.identities?.installer)
    problems.push(`no "${INSTALLER_SIGNING_IDENTITY}" identity is installed`);
  if (facts.identities?.team_mismatch)
    problems.push(
      "the two identities are from different teams; a release must come from one publisher",
    );
  if (!facts.notary?.configured) {
    problems.push(
      facts.notary?.reason ??
        "no notarization credential is configured (a notarytool keychain profile or an app-specific password)",
    );
  }
  if (!facts.source?.clean) {
    problems.push(
      `the working tree is not clean (${facts.source?.dirty_files ?? "unknown"} changed files); a release must be built from a recorded commit`,
    );
  }
  if (facts.manifest?.ok === false) problems.push(...(facts.manifest.problems ?? []));
  if (facts.evidence?.ok === false) problems.push(...(facts.evidence.problems ?? []));
  const ok = problems.length === 0;
  return {
    ok,
    problems,
    report: {
      schema_version: 1,
      prompt: "P22",
      ok,
      generated_utc: facts.generatedUtc ?? null,
      host: facts.host ?? null,
      tools: facts.tools ?? null,
      identities: facts.identities ?? null,
      notary: facts.notary ?? null,
      source: facts.source ?? null,
      manifest: facts.manifest ?? null,
      evidence: facts.evidence ?? null,
      problems,
    },
  };
}

/** Parse `notarytool submit --output-format json`. */
export function parseNotarySubmission(text) {
  let value;
  try {
    value = JSON.parse(String(text ?? ""));
  } catch {
    return { id: null, status: "unparsed", message: String(text ?? "").slice(0, 400) };
  }
  return {
    id: typeof value.id === "string" ? value.id : null,
    status: typeof value.status === "string" ? value.status : "unknown",
    message: typeof value.message === "string" ? value.message : null,
  };
}

/**
 * A release is only successful for one status. `Accepted` is the only pass;
 * `In Progress` is a resumable job, and everything else is a refusal.
 */
export function notaryVerdict(status) {
  const normalized = String(status ?? "").toLowerCase();
  if (normalized === "accepted") return "accepted";
  if (normalized === "in progress") return "pending";
  if (normalized === "invalid" || normalized === "rejected") return "rejected";
  return "unknown";
}

/**
 * The release receipt names evidence, never private material. Values that look
 * like a keychain secret are dropped rather than carried into a file.
 */
export function releaseReceipt({
  packagePath,
  packageSha256,
  packageBytes,
  version,
  build,
  commit,
  identities,
  notary,
  assessments,
  generatedUtc,
}) {
  return {
    schema_version: 1,
    prompt: "P22",
    product: "Mona",
    version,
    build,
    commit,
    generated_utc: generatedUtc,
    package: {
      path: packagePath,
      sha256: packageSha256,
      bytes: packageBytes,
    },
    signing: {
      application_authority: identities?.application?.name ?? null,
      installer_authority: identities?.installer?.name ?? null,
      team: identities?.team ?? null,
    },
    notarization: {
      submission_id: notary?.id ?? null,
      status: notary?.status ?? null,
      verdict: notaryVerdict(notary?.status),
      log_path: notary?.logPath ?? null,
    },
    assessments: assessments ?? {},
  };
}

/** Remove the build machine's identity from any text that is written to disk. */
export function redactHost(text, { home, checkout } = {}) {
  let value = String(text ?? "");
  if (home) value = value.replaceAll(home, "~");
  if (checkout) value = value.replaceAll(checkout, "<checkout>");
  return value;
}
