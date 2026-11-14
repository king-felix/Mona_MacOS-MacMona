import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  APP_SIGNING_IDENTITY,
  INSTALLER_SIGNING_IDENTITY,
  codesignArgs,
  componentClass,
  entitlementKindFor,
  entitlementKindForService,
  notaryVerdict,
  parseIdentities,
  parseNotarySubmission,
  preflightReport,
  productsignArgs,
  redactHost,
  releaseReceipt,
  selectIdentities,
  signingOrder,
} from "../packaging/macos/lib/signing.mjs";

const APP_IDENTITY = {
  sha1: "A".repeat(40),
  name: `${APP_SIGNING_IDENTITY}: Mona (TEAM123456)`,
};
const INSTALLER_IDENTITY = {
  sha1: "B".repeat(40),
  name: `${INSTALLER_SIGNING_IDENTITY}: Mona (TEAM123456)`,
};

const SECURITY_OUTPUT = `
  1) ${APP_IDENTITY.sha1} "${APP_IDENTITY.name}"
  2) ${INSTALLER_IDENTITY.sha1} "${INSTALLER_IDENTITY.name}"
     2 valid identities found
`;

describe("P22 identity policy", () => {
  it("parses only well-formed identity lines", () => {
    const identities = parseIdentities(SECURITY_OUTPUT);
    expect(identities).toHaveLength(2);
    expect(identities[0]).toEqual(APP_IDENTITY);
    expect(parseIdentities("     0 valid identities found")).toEqual([]);
  });

  it("names both missing identities when the keychain is empty", () => {
    const selected = selectIdentities([]);
    expect(selected.application).toBeNull();
    expect(selected.installer).toBeNull();
    expect(selected.problems).toHaveLength(2);
    expect(selected.problems[0]).toContain(APP_SIGNING_IDENTITY);
    expect(selected.problems[1]).toContain(INSTALLER_SIGNING_IDENTITY);
  });

  it("refuses two identities from different publishers", () => {
    const selected = selectIdentities([
      APP_IDENTITY,
      { sha1: "C".repeat(40), name: `${INSTALLER_SIGNING_IDENTITY}: Mona (OTHERTEAM1)` },
    ]);
    expect(selected.team).toBe("TEAM123456");
    expect(selected.problems.join(" ")).toContain("one publisher");
  });

  it("accepts one publisher's pair", () => {
    const selected = selectIdentities([APP_IDENTITY, INSTALLER_IDENTITY]);
    expect(selected.problems).toEqual([]);
    expect(selected.application.name).toContain("Developer ID Application");
    expect(selected.installer.name).toContain("Developer ID Installer");
  });
});

describe("P22 component policy", () => {
  it("classifies the Electron payload by path, not by a tool", () => {
    expect(componentClass("")).toBe("app");
    expect(componentClass("Mona.app")).toBe("app");
    expect(componentClass("Contents/MacOS/Mona")).toBe("app-main");
    expect(componentClass("Contents/Frameworks/Electron Helper.app")).toBe("helper-app");
    expect(componentClass("Contents/Frameworks/Electron Framework.framework")).toBe("framework");
    expect(componentClass("Contents/Frameworks/libffmpeg.dylib")).toBe("dylib");
    expect(componentClass("Contents/Resources/native/mona-supervisor")).toBe("native-helper");
    expect(componentClass("Contents/Resources/engine/codewhale")).toBe("engine");
    expect(componentClass("Contents/Resources/app/dist/main/main/index.js")).toBe("other");
  });

  it("grants the main entitlements only to the app and Electron helpers", () => {
    expect(entitlementKindFor("app")).toBe("main.plist");
    expect(entitlementKindFor("app-main")).toBe("main.plist");
    expect(entitlementKindFor("helper-app")).toBe("helper.plist");
    // A framework, dylib, native helper, or the engine gets nothing.
    expect(entitlementKindFor("framework")).toBeNull();
    expect(entitlementKindFor("dylib")).toBeNull();
    expect(entitlementKindFor("native-helper")).toBeNull();
    expect(entitlementKindFor("engine")).toBeNull();
    expect(entitlementKindForService()).toBe("service.plist");
  });

  it("signs deepest-first and leaves the outer bundle last", () => {
    const plan = signingOrder([
      {
        relativePath: "Contents/Resources/native/mona-pty",
        path: "/a/Mona.app/Contents/Resources/native/mona-pty",
      },
      { relativePath: "Contents/MacOS/Mona", path: "/a/Mona.app/Contents/MacOS/Mona" },
      {
        relativePath: "Contents/Frameworks/Electron Helper.app",
        path: "/a/Mona.app/Contents/Frameworks/Electron Helper.app",
      },
      {
        relativePath: "Contents/Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper",
        path: "/a/Mona.app/Contents/Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper",
      },
      { relativePath: "", path: "/a/Mona.app" },
    ]);
    const order = plan.ordered.map((item) => item.relativePath);
    // The helper's executable precedes the helper bundle; everything precedes
    // the app, which is returned separately.
    expect(
      order.indexOf("Contents/Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper"),
    ).toBeLessThan(order.indexOf("Contents/Frameworks/Electron Helper.app"));
    expect(order).not.toContain("");
    expect(plan.outer?.relativePath).toBe("");
    expect(plan.outer?.entitlements).toBe("main.plist");
  });

  it("emits Hardened Runtime and a timestamp, and never --deep", () => {
    const args = codesignArgs({
      identity: "Developer ID Application: Mona (TEAM123456)",
      path: "/tmp/Mona.app",
      entitlements: "/tmp/main.plist",
    });
    expect(args).toEqual([
      "--force",
      "--options",
      "runtime",
      "--timestamp",
      "--entitlements",
      "/tmp/main.plist",
      "--sign",
      "Developer ID Application: Mona (TEAM123456)",
      "/tmp/Mona.app",
    ]);
    expect(args).not.toContain("--deep");
    const adHoc = codesignArgs({
      identity: "-",
      path: "/tmp/Mona.app",
      options: { runtime: false, timestamp: false },
    });
    expect(adHoc).toEqual(["--force", "--sign", "-", "/tmp/Mona.app"]);
  });

  it("signs the flat package with productsign and a timestamp", () => {
    expect(
      productsignArgs({
        identity: "Developer ID Installer: Mona (TEAM123456)",
        input: "in.pkg",
        output: "out.pkg",
      }),
    ).toEqual([
      "--sign",
      "Developer ID Installer: Mona (TEAM123456)",
      "--timestamp",
      "in.pkg",
      "out.pkg",
    ]);
  });
});

describe("P22 notarization verdicts", () => {
  it("treats only Accepted as a pass", () => {
    expect(notaryVerdict("Accepted")).toBe("accepted");
    expect(notaryVerdict("In Progress")).toBe("pending");
    expect(notaryVerdict("Invalid")).toBe("rejected");
    expect(notaryVerdict("Rejected")).toBe("rejected");
    expect(notaryVerdict("something new")).toBe("unknown");
    expect(notaryVerdict(null)).toBe("unknown");
  });

  it("parses the submission identity and survives garbage", () => {
    expect(parseNotarySubmission('{"id":"abc-123","status":"Accepted"}')).toEqual({
      id: "abc-123",
      status: "Accepted",
      message: null,
    });
    expect(parseNotarySubmission("not json").id).toBeNull();
    expect(parseNotarySubmission("not json").status).toBe("unparsed");
  });
});

describe("P22 preflight report", () => {
  const complete = {
    host: { darwin: true, arm64: true, translated: false },
    tools: { missing: [] },
    identities: { application: APP_IDENTITY, installer: INSTALLER_IDENTITY, team_mismatch: false },
    notary: { configured: true, profile: "mona-release" },
    source: { clean: true, dirty_files: 0 },
    manifest: { ok: true },
    evidence: { ok: true },
  };

  it("passes a complete host", () => {
    const result = preflightReport(complete);
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it("refuses every missing prerequisite by name", () => {
    const result = preflightReport({
      ...complete,
      host: { darwin: true, arm64: false, translated: true },
      tools: { missing: ["notarytool"] },
      identities: { application: null, installer: null, team_mismatch: true },
      notary: { configured: false, reason: "no notarization credential is configured" },
      source: { clean: false, dirty_files: 3 },
    });
    expect(result.ok).toBe(false);
    const text = result.problems.join("\n");
    expect(text).toContain("not arm64");
    expect(text).toContain("Rosetta");
    expect(text).toContain("notarytool");
    expect(text).toContain(APP_SIGNING_IDENTITY);
    expect(text).toContain(INSTALLER_SIGNING_IDENTITY);
    expect(text).toContain("one publisher");
    expect(text).toContain("no notarization credential");
    expect(text).toContain("3 changed files");
  });

  it("never carries a credential value into the report", () => {
    const result = preflightReport({
      ...complete,
      notary: {
        configured: true,
        method: "app-specific-password",
        profile: null,
        apple_id_present: true,
        team_id_present: true,
      },
    });
    const text = JSON.stringify(result.report);
    expect(text).not.toMatch(/sk-|password"\s*:/i);
    expect(result.report.notary).not.toHaveProperty("password");
  });
});

describe("P22 release receipt", () => {
  it("records the immutable digest and the notary verdict, and nothing secret", () => {
    const receipt = releaseReceipt({
      packagePath: "/tmp/Mona-0.1.0-macOS-arm64.pkg",
      packageSha256: "d".repeat(64),
      packageBytes: 1234,
      version: "0.1.0",
      build: "abc123",
      commit: "abcdef123456",
      identities: { application: APP_IDENTITY, installer: INSTALLER_IDENTITY, team: "TEAM123456" },
      notary: { id: "sub-1", status: "Accepted", logPath: "out/notary-log.json" },
      assessments: { stapler: { ok: true, detail: "validated" } },
      generatedUtc: "2026-11-14T00:00:00.000Z",
    });
    expect(receipt.package.sha256).toBe("d".repeat(64));
    expect(receipt.notarization).toMatchObject({
      submission_id: "sub-1",
      status: "Accepted",
      verdict: "accepted",
    });
    expect(receipt.signing.team).toBe("TEAM123456");
    const text = JSON.stringify(receipt);
    expect(text).not.toMatch(/BEGIN|password|secret/i);
  });

  it("redacts the build machine's identity from logs", () => {
    const text = redactHost(
      "/Users/victor/DS_Projects/Mona/packaging/macos/out/x.pkg and /Users/victor",
      { home: "/Users/victor", checkout: "/Users/victor/DS_Projects/Mona" },
    );
    expect(text).not.toContain("/Users/victor");
    expect(text).toContain("~/DS_Projects");
  });
});

describe("P22 preflight command", () => {
  it("writes a structured report and never claims success it cannot support", () => {
    const result = spawnSync(
      process.execPath,
      [resolve("packaging/macos/release.mjs"), "preflight"],
      { encoding: "utf8", timeout: 60_000 },
    );
    // 0 when this host is fully provisioned, 3 when it is not. Both are honest.
    expect([0, 3]).toContain(result.status);
    const report = JSON.parse(result.stdout);
    expect(report.schema_version).toBe(1);
    expect(report.command).toBe("preflight");
    expect(typeof report.ok).toBe("boolean");
    if (report.ok === false) {
      expect(report.problems.length).toBeGreaterThan(0);
      expect(result.status).toBe(3);
    }
    const written = JSON.parse(
      readFileSync(resolve("packaging/macos/out/release-preflight.json"), "utf8"),
    );
    expect(written.problems).toEqual(report.problems);
    // The report is evidence; it must not carry a credential.
    expect(result.stdout).not.toMatch(/\bsk-[A-Za-z0-9_-]{16,}/);
  });
});
