import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = resolve(new URL("../../..", import.meta.url).pathname);
const INVENTORY = resolve(ROOT, "docs/codewhale-capabilities-macos.json");

const classifications = new Set(["read", "write", "destructive"]);
const integrations = new Set(["native_view", "advanced_action", "integrated_terminal", "unavailable", "blocked_gap"]);
const statuses = new Set(["unqualified", "verified", "unavailable", "blocked_gap"]);

test("capability inventory satisfies its own row contract", async () => {
  const doc = JSON.parse(await readFile(INVENTORY, "utf8"));
  assert.equal(doc.schema_version, 2);
  assert.equal(doc.status, "qualified");
  assert.ok(Array.isArray(doc.capabilities));
  assert.ok(doc.capabilities.length >= 60, "inventory must cover the full discovered surface");

  const ids = new Set();
  for (const row of doc.capabilities) {
    for (const field of doc.capability_row_contract.fields) {
      assert.ok(row[field] !== undefined, `${row.mona_id ?? "?"} missing ${field}`);
    }
    assert.match(row.mona_id, /^MONA-CAP-\d{3}$/);
    assert.ok(!ids.has(row.mona_id), `duplicate id ${row.mona_id}`);
    ids.add(row.mona_id);
    assert.ok(classifications.has(row.classification), `${row.mona_id} bad classification`);
    assert.ok(integrations.has(row.integration), `${row.mona_id} bad integration`);
    assert.ok(statuses.has(row.status), `${row.mona_id} bad status`);
    if (row.status === "verified") assert.ok(row.tests && row.tests !== "P03 contract test pending", `${row.mona_id} verified without a test`);
    if (row.integration === "blocked_gap" || row.status === "blocked_gap") assert.ok(row.gap, `${row.mona_id} gap row without explanation`);
  }
});

test("coverage counts match the rows", async () => {
  const doc = JSON.parse(await readFile(INVENTORY, "utf8"));
  const count = (status) => doc.capabilities.filter((row) => row.status === status).length;
  assert.equal(doc.coverage.rows_total, doc.capabilities.length);
  assert.equal(doc.coverage.verified, count("verified"));
  assert.equal(doc.coverage.unqualified, count("unqualified"));
  assert.equal(doc.coverage.unavailable, count("unavailable"));
  assert.equal(doc.coverage.blocked_gaps, count("blocked_gap"));
});

test("every CLI command discovered in P00 has a row", async () => {
  const doc = JSON.parse(await readFile(INVENTORY, "utf8"));
  const names = new Set(doc.capabilities.map((row) => row.upstream_name));
  const commands = [
    "run", "doctor", "session-diagnostics", "scorecard", "models", "speech", "sessions",
    "receipts", "resume", "rc", "fork", "init", "install", "setup", "remote-setup", "exec",
    "fleet", "workflow", "lane", "review", "apply", "eval", "mcp", "features", "integrations",
    "serve", "web", "login", "logout", "auth", "account", "dispatch", "mcp-server", "config",
    "model", "thread", "sandbox", "app-server", "completion", "metrics", "update", "providers", "help",
  ];
  for (const command of commands) assert.ok(names.has(command), `missing command row: ${command}`);
});
