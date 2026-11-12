// Parse the two Markdown specifications into a machine-readable registry and
// validate the prompt dependency graph. Deterministic: same inputs, same output.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Buffer } from "./atomic.mjs";

export const SPEC_FILE = "Mona_macOS_Project.md";
export const PROMPTS_FILE = "Mona_macOS_PROMPTS.md";

const EN_DASH = "–";

function tableRows(markdown, matcher) {
  return markdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && line.endsWith("|"))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => matcher(cells));
}

function expandIdRange(token, prefix, width) {
  // "P14–P19" -> [P14..P19]; "001–003" -> [001..003]
  const parts = token.split(EN_DASH);
  if (parts.length !== 2) return null;
  const expected = new RegExp(`^${prefix}\\d+$`);
  const toNumber = (value) => {
    if (!expected.test(value)) return NaN;
    return Number(value.slice(prefix.length));
  };
  const start = toNumber(parts[0]);
  const end = toNumber(parts[1]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) return null;
  const ids = [];
  for (let n = start; n <= end; n += 1) ids.push(`${prefix}${String(n).padStart(width, "0")}`);
  return ids;
}

export function expandPromptTokens(column) {
  if (!column || /^none$/i.test(column.trim())) return [];
  const tokens = column.split(",").map((token) => token.trim()).filter(Boolean);
  const ids = [];
  for (const token of tokens) {
    const range = expandIdRange(token, "P", 2);
    if (range) ids.push(...range);
    else if (/^P\d{2}$/.test(token)) ids.push(token);
    else throw new Error(`unrecognized prerequisite token "${token}"`);
  }
  return ids;
}

const FINAL_ACCEPTANCE_TOKEN = /^all final acceptance$/i;

export function expandRequirementTokens(column) {
  const tokens = column.split(",").map((token) => token.trim()).filter(Boolean);
  const ids = [];
  let allFinalAcceptance = false;
  for (const token of tokens) {
    if (FINAL_ACCEPTANCE_TOKEN.test(token)) {
      allFinalAcceptance = true;
      continue;
    }
    if (/^MONA-\d{3}$/.test(token) || /^MAC-\d{3}$/.test(token)) {
      ids.push(token);
      continue;
    }
    if (/^\d{3}$/.test(token)) {
      ids.push(`MONA-${token}`);
      continue;
    }
    const bareRange = expandIdRange(token, "", 3);
    if (bareRange) {
      ids.push(...bareRange.map((id) => `MONA-${id}`));
      continue;
    }
    const macRange = expandIdRange(token, "MAC-", 3);
    if (macRange) {
      ids.push(...macRange);
      continue;
    }
    throw new Error(`unrecognized requirement token "${token}"`);
  }
  return { ids, all_final_acceptance: allFinalAcceptance };
}

export function parseSpecRequirements(markdown) {
  const rows = tableRows(markdown, (cells) => /^(MONA|MAC)-\d{3}$/.test(cells[0] ?? ""));
  return rows.map((cells) => ({
    id: cells[0],
    track: cells[1],
    title: cells[2],
  }));
}

export function parsePromptMap(markdown) {
  const rows = tableRows(markdown, (cells) => /^P\d{2}$/.test(cells[0] ?? ""));
  return rows.map((cells) => {
    const requirements = expandRequirementTokens(cells[3]);
    return {
      id: cells[0],
      title: cells[1],
      prerequisites: expandPromptTokens(cells[2]),
      requirement_ids: requirements.ids,
      final_acceptance_of_all: requirements.all_final_acceptance,
    };
  });
}

// Topological sort with cycle reporting; returns ids in dependency order.
export function topoSort(nodes, edgesFor) {
  const state = new Map(); // id -> "visiting" | "done"
  const order = [];
  const cycles = [];

  const visit = (id, trail) => {
    const status = state.get(id);
    if (status === "done") return;
    if (status === "visiting") {
      const cycle = [...trail.slice(trail.indexOf(id)), id];
      cycles.push(cycle.join(" -> "));
      return;
    }
    state.set(id, "visiting");
    for (const dep of edgesFor(id)) visit(dep, [...trail, id]);
    state.set(id, "done");
    order.push(id);
  };

  for (const node of nodes) visit(node.id, []);
  return { order, cycles };
}

export function buildRegistry({ specMarkdown, promptsMarkdown, specSha256, promptsSha256, now }) {
  const requirements = parseSpecRequirements(specMarkdown);
  const prompts = parsePromptMap(promptsMarkdown);
  const errors = [];
  const warnings = [];

  const requirementIds = new Set(requirements.map((r) => r.id));
  const promptIds = new Set(prompts.map((p) => p.id));

  if (prompts.length !== 28) errors.push(`expected 28 prompts (P00–P27), found ${prompts.length}`);
  if (!prompts.some((p) => p.id === "P00")) errors.push("prompt map is missing P00");
  if (requirements.filter((r) => r.id.startsWith("MONA-")).length !== 30) {
    errors.push("expected 30 MONA requirements in the specification");
  }
  if (requirements.filter((r) => r.id.startsWith("MAC-")).length !== 8) {
    errors.push("expected 8 MAC requirements in the specification");
  }

  const seen = new Set();
  for (const prompt of prompts) {
    if (seen.has(prompt.id)) errors.push(`duplicate prompt ${prompt.id}`);
    seen.add(prompt.id);
    for (const prerequisite of prompt.prerequisites) {
      if (!promptIds.has(prerequisite)) {
        errors.push(`${prompt.id} depends on unknown prompt ${prerequisite}`);
      }
      if (prerequisite === prompt.id) errors.push(`${prompt.id} cannot depend on itself`);
    }
    for (const requirement of prompt.requirement_ids) {
      if (!requirementIds.has(requirement)) {
        errors.push(`${prompt.id} references unknown requirement ${requirement}`);
      }
    }
  }

  const { order, cycles } = topoSort(prompts, (id) => prompts.find((p) => p.id === id)?.prerequisites ?? []);
  for (const cycle of cycles) errors.push(`dependency cycle: ${cycle}`);
  if (cycles.length === 0) {
    const position = new Map(order.map((id, index) => [id, index]));
    for (const prompt of prompts) {
      for (const prerequisite of prompt.prerequisites) {
        if ((position.get(prerequisite) ?? Infinity) > (position.get(prompt.id) ?? -1)) {
          errors.push(`${prerequisite} is ordered after its dependent ${prompt.id} in the prompt map`);
        }
      }
    }
  }

  const finalAcceptancePrompts = prompts.filter((p) => p.final_acceptance_of_all);
  if (finalAcceptancePrompts.length !== 1) {
    errors.push(`expected exactly one prompt carrying "all final acceptance", found ${finalAcceptancePrompts.length}`);
  }
  for (const prompt of finalAcceptancePrompts) {
    if (prompt.id !== prompts.at(-1)?.id) errors.push(`${prompt.id} carries final acceptance but is not the last prompt`);
    const dependents = prompts.filter((p) => p.prerequisites.includes(prompt.id));
    if (dependents.length > 0) {
      errors.push(`${prompt.id} carries final acceptance but is a prerequisite of ${dependents.map((p) => p.id).join(", ")}`);
    }
  }

  const referenced = new Set(prompts.flatMap((p) => p.requirement_ids));
  for (const requirement of requirements) {
    if (!referenced.has(requirement.id)) warnings.push(`${requirement.id} is not assigned to any prompt`);
  }

  const requirementPrompts = new Map(requirements.map((r) => [r.id, []]));
  for (const prompt of prompts) {
    for (const requirement of prompt.requirement_ids) {
      requirementPrompts.get(requirement)?.push(prompt.id);
    }
  }

  return {
    schema_version: 1,
    generated_by: "tools/monabuild (deterministic parse of the two specification files)",
    spec: {
      version: "macOS-1.0",
      platform: "darwin-arm64",
      files: [
        { path: SPEC_FILE, sha256: specSha256 },
        { path: PROMPTS_FILE, sha256: promptsSha256 },
      ],
      indexed_utc: now,
    },
    prompts: prompts.map((prompt) => ({
      ...prompt,
      status: "pending",
    })),
    requirements: requirements.map((requirement) => ({
      ...requirement,
      prompts: requirementPrompts.get(requirement.id) ?? [],
      status: "pending",
      acceptance: "pending",
      evidence: [],
      notes: "",
    })),
    dependency_order: order,
    validated: {
      ok: errors.length === 0,
      errors,
      warnings,
      validated_utc: now,
      prompt_count: prompts.length,
      requirement_count: requirements.length,
    },
  };
}

export function loadRegistrySources(root) {
  const specPath = join(root, SPEC_FILE);
  const promptsPath = join(root, PROMPTS_FILE);
  const specBytes = readFileSync(specPath);
  const promptBytes = readFileSync(promptsPath);
  return {
    specMarkdown: specBytes.toString("utf8"),
    promptsMarkdown: promptBytes.toString("utf8"),
    specSha256: sha256Buffer(specBytes),
    promptsSha256: sha256Buffer(promptBytes),
  };
}

// Merge regenerated structure with previously recorded requirement status and
// evidence so a documentation refresh never erases traceability.
export function mergeWithExisting(registry, existing) {
  if (!existing?.requirements) return registry;
  const prior = new Map(existing.requirements.map((r) => [r.id, r]));
  for (const requirement of registry.requirements) {
    const previous = prior.get(requirement.id);
    if (!previous) continue;
    requirement.status = previous.status ?? "pending";
    requirement.acceptance = previous.acceptance ?? "pending";
    requirement.evidence = previous.evidence ?? [];
    requirement.notes = previous.notes ?? "";
  }
  return registry;
}

export function validateRegistry(registry, { specSha256, promptsSha256 } = {}) {
  const errors = [...(registry.validated?.errors ?? [])];
  const prompts = registry.prompts ?? [];
  const requirements = registry.requirements ?? [];
  const promptIds = new Set(prompts.map((p) => p.id));
  const requirementIds = new Set(requirements.map((r) => r.id));

  if (registry.validated?.ok !== true) errors.push("registry was generated from invalid sources");
  if (specSha256 && registry.spec?.files?.find((f) => f.path === SPEC_FILE)?.sha256 !== specSha256) {
    errors.push("registry spec hash is stale; run `requirements sync`");
  }
  if (promptsSha256 && registry.spec?.files?.find((f) => f.path === PROMPTS_FILE)?.sha256 !== promptsSha256) {
    errors.push("registry prompt-file hash is stale; run `requirements sync`");
  }
  for (const prompt of prompts) {
    for (const prerequisite of prompt.prerequisites) {
      if (!promptIds.has(prerequisite)) errors.push(`${prompt.id}: unknown prerequisite ${prerequisite}`);
    }
    if (prompt.status !== "pending" && prompt.status !== undefined) {
      // Prompt runtime status is owned by state.json; a non-pending mirror in
      // the registry is tolerated but reported so it cannot silently drift.
      errors.push(`${prompt.id}: prompt status must stay "pending" in the registry (state.json owns runtime status)`);
    }
  }
  for (const requirement of requirements) {
    for (const promptId of requirement.prompts ?? []) {
      if (!promptIds.has(promptId)) errors.push(`${requirement.id}: references unknown prompt ${promptId}`);
    }
    if (!["pending", "partial", "satisfied", "blocked"].includes(requirement.status)) {
      errors.push(`${requirement.id}: invalid status ${requirement.status}`);
    }
  }
  if (requirementIds.size !== 38) errors.push(`expected 38 requirement IDs (30 MONA + 8 MAC), found ${requirementIds.size}`);

  return { ok: errors.length === 0, errors };
}
