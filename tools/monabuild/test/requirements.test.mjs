import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildRegistry,
  loadRegistrySources,
  parsePromptMap,
  parseSpecRequirements,
  topoSort,
  validateRegistry,
} from "../lib/requirements.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("the real specifications produce 28 prompts and 38 requirements", () => {
  const sources = loadRegistrySources(ROOT);
  const registry = buildRegistry({ ...sources, now: "2026-11-11T00:00:00.000Z" });
  assert.equal(registry.validated.ok, true, registry.validated.errors.join("\n"));
  assert.equal(registry.prompts.length, 28);
  assert.equal(registry.requirements.length, 38);
  assert.equal(registry.requirements.filter((r) => r.id.startsWith("MONA-")).length, 30);
  assert.equal(registry.requirements.filter((r) => r.id.startsWith("MAC-")).length, 8);
  assert.equal(registry.dependency_order[0], "P00");
  assert.equal(registry.dependency_order.at(-1), "P27");
});

test("P00 carries the bootstrap requirements and no prerequisites", () => {
  const registry = buildRegistry({ ...loadRegistrySources(ROOT), now: "2026-11-11T00:00:00.000Z" });
  const p00 = registry.prompts.find((prompt) => prompt.id === "P00");
  assert.deepEqual(p00.prerequisites, []);
  assert.deepEqual(p00.requirement_ids, ["MONA-001", "MONA-010", "MAC-001", "MAC-008"]);
});

test("range tokens expand deterministically", () => {
  const prompts = [
    { id: "P14", prerequisites: [], requirement_ids: [], final_acceptance_of_all: false },
    { id: "P15", prerequisites: [], requirement_ids: [], final_acceptance_of_all: false },
    { id: "P16", prerequisites: [], requirement_ids: [], final_acceptance_of_all: false },
    { id: "P17", prerequisites: [], requirement_ids: [], final_acceptance_of_all: false },
    { id: "P18", prerequisites: [], requirement_ids: [], final_acceptance_of_all: false },
    { id: "P19", prerequisites: [], requirement_ids: [], final_acceptance_of_all: false },
    { id: "P20", prerequisites: [], requirement_ids: [], final_acceptance_of_all: false },
  ];
  const parsed = parsePromptMap(
    [
      "| Prompt | Deliverable | Prerequisites | Main requirements |",
      "|---|---|---|---|",
      "| P20 | QA | P14–P19 | 016, 025, 026 |",
    ].join("\n"),
  );
  assert.deepEqual(parsed[0].prerequisites, ["P14", "P15", "P16", "P17", "P18", "P19"]);
  assert.deepEqual(parsed[0].requirement_ids, ["MONA-016", "MONA-025", "MONA-026"]);
  assert.equal(prompts.length, 7);
});

test("dependency cycles are reported instead of accepted", () => {
  const nodes = [{ id: "P00" }, { id: "P01" }, { id: "P02" }];
  const edges = { P00: ["P02"], P01: ["P00"], P02: ["P01"] };
  const { cycles } = topoSort(nodes, (id) => edges[id] ?? []);
  assert.equal(cycles.length > 0, true);
});

test("missing prerequisite and requirement IDs are rejected", () => {
  const specMarkdown = [
    "| ID | Track | Function and required behavior |",
    "|---|---|---|",
    "| MONA-001 | Foundation | Discover engine |",
  ].join("\n");
  const promptsMarkdown = [
    "| Prompt | Deliverable | Prerequisites | Main requirements |",
    "|---|---|---|---|",
    "| P00 | Bootstrap | P99 | 001, MAC-001 |",
  ].join("\n");
  const registry = buildRegistry({
    specMarkdown,
    promptsMarkdown,
    specSha256: "1".repeat(64),
    promptsSha256: "2".repeat(64),
    now: "2026-11-11T00:00:00.000Z",
  });
  const errors = registry.validated.errors.join("\n");
  assert.match(errors, /unknown prompt P99/);
  assert.match(errors, /unknown requirement MAC-001/);
});

test("a stale registry hash is detected", () => {
  const registry = JSON.parse(readFileSync(resolve(ROOT, "docs", "requirements-macos.json"), "utf8"));
  const result = validateRegistry(registry, {
    specSha256: "0".repeat(64),
    promptsSha256: "0".repeat(64),
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /hash is stale/);
});

test("the committed registry matches the current specification files", () => {
  const registry = JSON.parse(readFileSync(resolve(ROOT, "docs", "requirements-macos.json"), "utf8"));
  const sources = loadRegistrySources(ROOT);
  const result = validateRegistry(registry, {
    specSha256: sources.specSha256,
    promptsSha256: sources.promptsSha256,
  });
  assert.equal(result.ok, true, result.errors.join("\n"));
});
