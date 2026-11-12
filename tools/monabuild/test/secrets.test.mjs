import test from "node:test";
import assert from "node:assert/strict";
import { scanText } from "../lib/secrets.mjs";

// Fixture values are assembled at runtime so that this test file itself does not
// contain a literal that the scanner would report.
const fakeSecret = ["alpha", "bravo", "charlie", "delta"].join("-");
const fakeProviderToken = `${["s", "k"].join("")}-${["0123456789", "abcdefghijklmnop"].join("")}`;

test("detects an assigned API key with a plausible value", () => {
  const findings = scanText(`api_key = "${fakeSecret}"`, "config.toml");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].pattern, "assigned-secret");
});

test("detects a provider-style token and a private key block", () => {
  assert.equal(scanText(`const k = "${fakeProviderToken}"`).length, 1);
  const keyHeader = ["-----BEGIN", "RSA", "PRIVATE", "KEY-----"].join(" ");
  assert.equal(scanText(keyHeader).length, 1);
});

test("documentation placeholders are not reported as credentials", () => {
  const doc = [
    "[providers.openai]",
    `api_key = "${["YOUR", "GATEWAY", "API", "KEY"].join("_")}"`,
    `client_secret = "${["PLACEHOLDER", "VALUE"].join("_")}"`,
    'api_key = "<from your password manager>"',
  ].join("\n");
  assert.deepEqual(scanText(doc, "PROVIDERS.md"), []);
});

test("reports the line number but never the matched value", () => {
  const findings = scanText(`ok\napi_key = "${fakeSecret}"`, "f");
  assert.equal(findings[0].line, 2);
  assert.equal(Object.hasOwn(findings[0], "value"), false);
  assert.equal(JSON.stringify(findings).includes(fakeSecret), false);
});
