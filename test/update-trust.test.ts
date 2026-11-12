import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MONA_BUNDLE_ID,
  MONA_PACKAGE_ID,
  MONA_SERVICE_BUNDLE_ID,
  type PackageFacts,
  type UpdateManifest,
  type UpdateSourceConfig,
} from "../src/shared/contracts/update";
import { UpdateError } from "../src/main/update/errors";
import {
  decodeSignedManifest,
  encodeSignedManifest,
  keyFingerprint,
  resolveSecureUrl,
} from "../src/main/update/manifest";
import { evaluateUpdate, type CurrentBuild } from "../src/main/update/trust";

/**
 * The trust policy and the manifest envelope. Every rejection is proven here;
 * a signed package and a real feed are not needed to show that a tampered,
 * unsigned, downgraded, replayed, or wrong-team candidate is refused.
 */

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

function source(overrides: Partial<UpdateSourceConfig> = {}): UpdateSourceConfig {
  return {
    schemaVersion: 1,
    mode: "configured",
    baseUrl: "https://updates.example.com/mona",
    manifestPath: "update.json",
    teamId: "ABCDE12345",
    manifestKey: "unused-here",
    allowLocalPackages: true,
    ...overrides,
  };
}

function current(overrides: Partial<CurrentBuild> = {}): CurrentBuild {
  return {
    version: "0.1.0",
    build: 81,
    channel: "local",
    schemaVersion: 8,
    engineVersion: "0.10.2",
    engineCommit: "ff466b2e",
    ...overrides,
  };
}

function manifest(overrides: Partial<UpdateManifest> = {}): UpdateManifest {
  return {
    schemaVersion: 1,
    product: "Mona",
    channel: "release",
    version: "0.2.0",
    build: 120,
    bundleId: MONA_BUNDLE_ID,
    serviceBundleId: MONA_SERVICE_BUNDLE_ID,
    packageId: MONA_PACKAGE_ID,
    teamId: "ABCDE12345",
    minimumMacOS: "14.0",
    architectures: ["arm64"],
    engine: { version: "0.10.2", commit: "ff466b2e" },
    package: {
      url: "Mona-0.2.0-macOS-arm64.pkg",
      name: "Mona-0.2.0-macOS-arm64.pkg",
      sha256: DIGEST_A,
      sizeBytes: 1000,
      notarized: true,
    },
    releasedAt: "2026-11-12T00:00:00.000Z",
    notesUrl: null,
    ...overrides,
  };
}

function facts(overrides: Partial<PackageFacts> = {}): PackageFacts {
  return {
    path: "/tmp/Mona-0.2.0-macOS-arm64.pkg",
    sha256: DIGEST_A,
    sizeBytes: 1000,
    signature: {
      status: "signed",
      teamId: "ABCDE12345",
      authorities: ["Developer ID Installer: Mona (ABCDE12345)"],
      developerIdInstaller: true,
      identifier: MONA_PACKAGE_ID,
    },
    package: {
      identifier: MONA_PACKAGE_ID,
      version: "0.2.0",
      build: 120,
      installLocation: "/",
      minimumMacOS: "14.0",
    },
    appBundleId: MONA_BUNDLE_ID,
    serviceBundleId: MONA_SERVICE_BUNDLE_ID,
    architectures: ["arm64"],
    engine: { version: "0.10.2", commit: "ff466b2e" },
    source: "fixture",
    ...overrides,
  };
}

function evaluate(
  overrides: Partial<Parameters<typeof evaluateUpdate>[0]> = {},
): ReturnType<typeof evaluateUpdate> {
  return evaluateUpdate({
    mode: "configured",
    source: source(),
    manifest: manifest(),
    packageFacts: facts(),
    current: current(),
    hostOs: "14.5",
    hostArch: "arm64",
    applied: [],
    ...overrides,
  });
}

describe("update trust policy", () => {
  it("accepts a well-formed release candidate and describes the upgrade", () => {
    const decision = evaluate();
    expect(decision.decision).toBe("available");
    expect(decision.code).toBeNull();
    expect(decision.candidate?.installKind).toBe("upgrade");
    expect(decision.candidate?.packageSha256).toBe(DIGEST_A);
    expect(decision.engineChange).toBeNull();
  });

  it("calls the same version a reinstall rather than an upgrade", () => {
    const decision = evaluate({
      manifest: manifest({ version: "0.1.0", build: 81 }),
      packageFacts: facts({ package: { ...facts().package, version: "0.1.0", build: 81 } }),
    });
    expect(decision.decision).toBe("available");
    expect(decision.candidate?.installKind).toBe("reinstall");
  });

  it("reports manual updates when no source is configured", () => {
    const decision = evaluate({
      mode: "manual",
      source: source({ mode: "manual", baseUrl: null, manifestPath: null }),
      manifest: null,
      packageFacts: null,
    });
    expect(decision.decision).toBe("manual");
    expect(decision.code).toBe("no_source");
  });

  it("refuses a package for another product or bundle", () => {
    expect(evaluate({ manifest: manifest({ product: "Other" as unknown as "Mona" }) }).code).toBe(
      "product_mismatch",
    );
    expect(evaluate({ manifest: manifest({ bundleId: "com.example.other" }) }).code).toBe(
      "identity_mismatch",
    );
    expect(evaluate({ manifest: manifest({ serviceBundleId: "com.example.service" }) }).code).toBe(
      "identity_mismatch",
    );
    expect(evaluate({ manifest: manifest({ packageId: "com.example.pkg" }) }).code).toBe(
      "identity_mismatch",
    );
  });

  it("refuses a wrong publisher team, before and after the package is checked", () => {
    expect(evaluate({ source: source({ teamId: "ZZZZZ99999" }) }).code).toBe("wrong_team");
    expect(
      evaluate({
        packageFacts: facts({
          signature: { ...facts().signature, teamId: "ZZZZZ99999" },
        }),
      }).code,
    ).toBe("wrong_team");
    expect(evaluate({ manifest: manifest({ teamId: null }) }).code).toBe("wrong_team");
  });

  it("refuses tampered bytes, a wrong length, and a foreign package", () => {
    expect(evaluate({ packageFacts: facts({ sha256: DIGEST_B }) }).code).toBe("digest_mismatch");
    expect(evaluate({ packageFacts: facts({ sizeBytes: 999 }) }).code).toBe("size_mismatch");
    expect(
      evaluate({ packageFacts: facts({ package: { ...facts().package, identifier: "x.y" } }) })
        .code,
    ).toBe("package_identity_mismatch");
    expect(evaluate({ packageFacts: facts({ appBundleId: "com.example.app" }) }).code).toBe(
      "package_identity_mismatch",
    );
    expect(evaluate({ packageFacts: null }).code).toBe("digest_mismatch");
  });

  it("refuses an unsigned or ad-hoc release package, and an unnotarized one", () => {
    const unsigned = facts({
      signature: {
        status: "unsigned",
        teamId: null,
        authorities: [],
        developerIdInstaller: false,
        identifier: null,
      },
    });
    expect(evaluate({ packageFacts: unsigned }).code).toBe("package_unsigned");

    const adhoc = facts({
      signature: {
        status: "adhoc",
        teamId: null,
        authorities: ["adhoc"],
        developerIdInstaller: false,
        identifier: MONA_PACKAGE_ID,
      },
    });
    expect(evaluate({ packageFacts: adhoc }).code).toBe("package_adhoc");

    const wrongAuthority = facts({
      signature: {
        status: "signed",
        teamId: "ABCDE12345",
        authorities: ["Apple Development: Someone (ABCDE12345)"],
        developerIdInstaller: false,
        identifier: MONA_PACKAGE_ID,
      },
    });
    expect(evaluate({ packageFacts: wrongAuthority }).code).toBe("package_unsigned");

    expect(
      evaluate({ manifest: manifest({ package: { ...manifest().package, notarized: false } }) })
        .code,
    ).toBe("notarization_missing");
  });

  it("refuses a package this Mac cannot run", () => {
    expect(evaluate({ manifest: manifest({ architectures: ["x86_64"] }) }).code).toBe(
      "architecture_mismatch",
    );
    expect(evaluate({ hostArch: "x64" }).code).toBe("architecture_mismatch");
    expect(evaluate({ packageFacts: facts({ architectures: ["x86_64"] }) }).code).toBe(
      "architecture_mismatch",
    );
    expect(evaluate({ hostOs: "13.6" }).code).toBe("os_too_old");
    expect(evaluate({ hostOs: "" }).code).toBe("os_too_old");
  });

  it("refuses a downgrade by version or by build", () => {
    expect(evaluate({ manifest: manifest({ version: "0.0.9", build: 90 }) }).code).toBe(
      "downgrade",
    );
    expect(evaluate({ manifest: manifest({ version: "0.1.0", build: 80 }) }).code).toBe(
      "downgrade",
    );
  });

  it("refuses a replayed package, but not a merely equal version", () => {
    expect(
      evaluate({
        manifest: manifest({ version: "0.1.0", build: 82 }),
        applied: [{ sha256: DIGEST_A, version: "0.2.0", at: "2026-11-01T00:00:00.000Z" }],
      }).code,
    ).toBe("replayed");
    expect(
      evaluate({ manifest: manifest({ version: "0.1.0", build: 82 }), applied: [] }).decision,
    ).toBe("available");
  });

  it("never changes the bundled engine silently", () => {
    const engineBump = manifest({ engine: { version: "0.11.0", commit: "deadbeef" } });
    const refused = evaluate({ manifest: engineBump });
    expect(refused.code).toBe("engine_change_unconfirmed");
    expect(refused.engineChange).toEqual({ from: "0.10.2", to: "0.11.0" });

    const confirmed = evaluate({ manifest: engineBump, engineChangeConfirmed: true });
    expect(confirmed.decision).toBe("available");
    expect(confirmed.engineChange).toEqual({ from: "0.10.2", to: "0.11.0" });
  });

  it("refuses a release manifest that does not declare its engine", () => {
    expect(
      evaluate({ manifest: manifest({ engine: { version: "unknown", commit: "unknown" } }) }).code,
    ).toBe("engine_mismatch");
  });

  it("never lets a local package replace a release install", () => {
    const local = manifest({ channel: "local", teamId: null });
    // A local package from a source feed is refused even for a local build:
    // local packages come from a chosen file, never from a feed.
    expect(evaluate({ manifest: local }).code).toBe("local_package_not_allowed");
    expect(
      evaluate({
        manifest: local,
        localSelection: true,
        current: current({ channel: "release" }),
      }).code,
    ).toBe("local_package_not_allowed");
    expect(
      evaluate({
        manifest: local,
        localSelection: true,
        source: source({ allowLocalPackages: false }),
      }).code,
    ).toBe("local_package_not_allowed");
  });

  it("accepts a chosen local package for a local build", () => {
    const local = manifest({ channel: "local", teamId: null });
    const decision = evaluate({
      manifest: local,
      localSelection: true,
      current: current({ channel: "local" }),
      packageFacts: facts({
        signature: {
          status: "adhoc",
          teamId: null,
          authorities: ["adhoc"],
          developerIdInstaller: false,
          identifier: MONA_PACKAGE_ID,
        },
      }),
    });
    expect(decision.decision).toBe("available");
    expect(decision.candidate?.channel).toBe("local");
  });

  it("refuses a version it cannot order, instead of comparing it as equal", () => {
    // `compareVersions` is total for sorting, so an unparseable version used to
    // compare equal and slip past the downgrade guard.
    for (const version of ["banana", "1.2.3.4", "v0.2.0", ""]) {
      const decision = evaluate({
        manifest: manifest({ version }),
        packageFacts: facts({ package: { ...facts().package, version } }),
      });
      expect(decision.decision).toBe("refused");
      expect(decision.code).toBe("manifest_malformed");
    }
    // A usable version still compares normally.
    expect(evaluate({ manifest: manifest({ version: "0.2.0-rc.1" }) }).decision).toBe("available");
  });

  it("refuses a package that declares no identity or architecture", () => {
    // Absent facts must fail closed: "unknown" is not "this product, arm64".
    expect(
      evaluate({
        packageFacts: facts({ package: { ...facts().package, identifier: null } }),
      }).code,
    ).toBe("package_identity_mismatch");
    expect(evaluate({ packageFacts: facts({ appBundleId: null }) }).code).toBe(
      "package_identity_mismatch",
    );
    expect(evaluate({ packageFacts: facts({ serviceBundleId: null }) }).code).toBe(
      "package_identity_mismatch",
    );
    expect(evaluate({ packageFacts: facts({ architectures: [] }) }).code).toBe(
      "architecture_mismatch",
    );
  });

  it("refuses a local package declared by a source feed", () => {
    // A local package only ever comes from a chosen file. `localSelection` is
    // the manual path; a configured source is never one.
    const local = manifest({ channel: "local", teamId: null });
    const decision = evaluate({ manifest: local, localSelection: false });
    expect(decision.decision).toBe("refused");
    expect(decision.code).toBe("local_package_not_allowed");
  });

  it("checks the announce stage without the package bytes", () => {
    const decision = evaluate({ stage: "announce", packageFacts: null });
    expect(decision.decision).toBe("available");
    // The version and engine rules still apply before a download.
    expect(
      evaluate({
        stage: "announce",
        packageFacts: null,
        manifest: manifest({ version: "0.0.1", build: 10 }),
      }).code,
    ).toBe("downgrade");
  });
});

describe("signed manifest envelope", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyBase64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();

  it("verifies the exact bytes and reports the key fingerprint", () => {
    const bytes = encodeSignedManifest(manifest(), privateKeyPem);
    const authenticated = decodeSignedManifest(bytes, publicKeyBase64);
    expect(authenticated.manifest.version).toBe("0.2.0");
    expect(authenticated.keyFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(authenticated.manifestDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a tampered payload, a wrong key, and a malformed envelope", () => {
    const bytes = encodeSignedManifest(manifest(), privateKeyPem);
    const envelope = JSON.parse(bytes.toString("utf8")) as {
      payload: string;
      signature: string;
    };
    const tamperedPayload = Buffer.from(
      JSON.stringify({ ...envelope, payload: Buffer.from('{"a":1}').toString("base64") }),
    );
    expect(() => decodeSignedManifest(tamperedPayload, publicKeyBase64)).toThrow(UpdateError);

    const other = generateKeyPairSync("ed25519");
    const otherBase64 = other.publicKey.export({ format: "der", type: "spki" }).toString("base64");
    expect(() => decodeSignedManifest(bytes, otherBase64)).toThrow(/signature does not match/);

    expect(() => decodeSignedManifest(Buffer.from("not json"), publicKeyBase64)).toThrow(
      UpdateError,
    );
    expect(() => decodeSignedManifest(Buffer.from(""), publicKeyBase64)).toThrow(/empty/);
  });

  it("refuses a signature that is valid for other bytes", () => {
    const payload = Buffer.from(JSON.stringify(manifest()), "utf8");
    const signature = sign(null, payload, privateKeyPem).toString("base64");
    const envelope = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        algorithm: "ed25519",
        payload: Buffer.from(JSON.stringify(manifest({ version: "9.9.9" }))).toString("base64"),
        signature,
      }),
    );
    expect(() => decodeSignedManifest(envelope, publicKeyBase64)).toThrow(UpdateError);
  });

  it("rejects a signed payload that does not match the manifest schema", () => {
    const badPayload = Buffer.from(JSON.stringify({ schemaVersion: 1, product: "Mona" }), "utf8");
    const signature = sign(null, badPayload, privateKeyPem).toString("base64");
    const envelope = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        algorithm: "ed25519",
        payload: badPayload.toString("base64"),
        signature,
      }),
    );
    expect(() => decodeSignedManifest(envelope, publicKeyBase64)).toThrow(/schema/);
  });

  it("fingerprints a key without exposing it", () => {
    expect(keyFingerprint(publicKeyBase64)).toBe(keyFingerprint(publicKeyBase64));
    expect(() => keyFingerprint("not-a-key")).toThrow(UpdateError);
  });
});

describe("secure URL resolution", () => {
  it("resolves a relative package path against the configured host", () => {
    expect(resolveSecureUrl("https://updates.example.com/mona", "Mona.pkg")).toBe(
      "https://updates.example.com/mona/Mona.pkg",
    );
    expect(resolveSecureUrl("https://updates.example.com", "x/Mona.pkg")).toBe(
      "https://updates.example.com/x/Mona.pkg",
    );
  });

  it("refuses plaintext, another host, credentials, and traversal", () => {
    expect(() => resolveSecureUrl("http://updates.example.com", "Mona.pkg")).toThrow(
      /HTTPS|insecure/,
    );
    expect(() =>
      resolveSecureUrl("https://updates.example.com", "https://evil.example/Mona.pkg"),
    ).toThrow(/different host/);
    expect(() =>
      resolveSecureUrl(
        "https://updates.example.com",
        "https://user:pass@updates.example.com/x.pkg",
      ),
    ).toThrow(UpdateError);
    expect(() => resolveSecureUrl("https://updates.example.com/a", "../../etc/passwd")).toThrow(
      UpdateError,
    );
  });
});
