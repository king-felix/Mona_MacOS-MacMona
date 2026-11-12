import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function helpCommandCount() {
  const help = readFileSync(resolve(ROOT, "docs/evidence/macos/artifacts/codewhale-help.txt"), "utf8");
  return help.split("\n").filter((line) => /^\s{2}[a-z][a-z0-9-]*\s{2,}\S/.test(line)).length;
}

test("capability inventory lists every command in the captured help output", () => {
  const inventory = JSON.parse(readFileSync(resolve(ROOT, "docs/codewhale-capabilities-macos.json"), "utf8"));
  assert.equal(inventory.observed_cli_commands.length, helpCommandCount());
  assert.equal(inventory.transports_observed.length, 5);
});

test("no capability is claimed supported before P01 qualifies it", () => {
  const inventory = JSON.parse(readFileSync(resolve(ROOT, "docs/codewhale-capabilities-macos.json"), "utf8"));
  assert.equal(inventory.status, "structure_only");
  assert.deepEqual(inventory.capabilities, []);
  assert.equal(inventory.coverage.verified, 0);
  for (const command of inventory.observed_cli_commands) {
    assert.equal(command.status, "discovered-unqualified", command.name);
  }
  for (const transport of inventory.transports_observed) {
    assert.match(transport.status, /not-qualified/);
  }
});

test("the discovery report's command count matches the captured help output", () => {
  const discovery = readFileSync(resolve(ROOT, "docs/discovery-macos.md"), "utf8");
  const claimed = discovery.match(/(\d+) command-table entries/);
  assert.ok(claimed, "discovery report states an explicit command count");
  assert.equal(Number(claimed[1]), helpCommandCount());
});
