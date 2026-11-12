// Whole-ledger validation: schema, cross-file agreement, hashes, evidence.
// Kept separate from the CLI so it can be tested and reused.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { sha256File, readJsonStrict } from "./atomic.mjs";
import { readValidated, requirementsSchema, stateSchema } from "./store.mjs";
import { validateRegistry, PROMPTS_FILE, SPEC_FILE } from "./requirements.mjs";
import { ledgerSummary, readAttempts } from "./attempts.mjs";
import { compareIndex, readIndex } from "./index.mjs";

export function validateEverything(p) {
  const errors = [];
  const warnings = [];

  // State
  let state = null;
  try {
    const { value, result } = readValidated(p.statePath, stateSchema());
    state = value;
    if (result.valid) {
      if (state.spec_sha256 !== sha256File(join(p.root, SPEC_FILE))) {
        errors.push("state.spec_sha256 does not match the current specification file (run: monabuild requirements sync)");
      }
      if (state.prompt_file_sha256 !== sha256File(join(p.root, PROMPTS_FILE))) {
        errors.push("state.prompt_file_sha256 does not match the current prompt file (run: monabuild requirements sync)");
      }
    } else {
      for (const error of result.errors) errors.push(`state.json${error.path.slice(1)}: ${error.message}`);
    }
  } catch (error) {
    errors.push(`state.json: ${error.message}`);
  }

  // Requirements registry
  let registry = null;
  try {
    const { value, result } = readValidated(p.requirementsPath, requirementsSchema());
    registry = value;
    if (!result.valid) {
      for (const error of result.errors) errors.push(`requirements-macos.json${error.path.slice(1)}: ${error.message}`);
    } else {
      const registryCheck = validateRegistry(value, {
        specSha256: sha256File(join(p.root, SPEC_FILE)),
        promptsSha256: sha256File(join(p.root, PROMPTS_FILE)),
      });
      errors.push(...registryCheck.errors);
      warnings.push(...(value.validated?.warnings ?? []));
    }
  } catch (error) {
    errors.push(`requirements-macos.json: ${error.message}`);
  }

  // Task/registry agreement
  if (state && registry) {
    const byId = new Map(registry.prompts.map((prompt) => [prompt.id, prompt]));
    const taskIds = Object.keys(state.tasks).sort();
    const expectedIds = [...byId.keys()].sort();
    if (JSON.stringify(taskIds) !== JSON.stringify(expectedIds)) {
      errors.push("state.json task IDs do not match the prompt registry (P00–P27)");
    }
    for (const [id, task] of Object.entries(state.tasks)) {
      const prompt = byId.get(id);
      if (!prompt) continue;
      const expected = [...prompt.requirement_ids].sort().join(",");
      const actual = [...task.requirements].sort().join(",");
      if (expected !== actual) errors.push(`state.json ${id} requirement list drifted from the prompt map`);
    }
  }

  // Evidence integrity: a recorded hash that no longer matches its file means
  // the evidence was edited after it was accepted, so it must be re-verified.
  if (state) {
    const missing = [];
    const changed = [];
    for (const [id, task] of Object.entries(state.tasks ?? {})) {
      for (const entry of task.evidence ?? []) {
        const absolute = join(p.root, entry.path);
        if (!existsSync(absolute)) {
          missing.push(`${id}:${entry.path}`);
          continue;
        }
        if (entry.sha256 && sha256File(absolute) !== entry.sha256) changed.push(`${id}:${entry.path}`);
      }
    }
    for (const item of missing) errors.push(`evidence file is missing: ${item}`);
    for (const item of changed) errors.push(`evidence hash is stale (re-run monabuild evidence): ${item}`);
  }

  // Attempt ledger
  let attempts = { records: [], warnings: [] };
  try {
    attempts = readAttempts(p.attemptsPath);
    warnings.push(...attempts.warnings);
  } catch (error) {
    errors.push(`attempts.jsonl: ${error.message}`);
  }

  // Hash index
  let indexDrift = null;
  const index = readIndex(p.indexPath);
  if (index) {
    indexDrift = compareIndex(index, p.root);
    for (const item of indexDrift.drift) {
      warnings.push(`index: ${item.path} ${item.issue} since the last index write`);
    }
  } else {
    warnings.push("index.json is absent; run: monabuild index --write");
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    state: state
      ? {
          revision: state.revision,
          current_prompt: state.current_prompt,
          current_prompt_status: state.current_prompt_status,
          tasks: Object.keys(state.tasks).length,
        }
      : null,
    requirements: registry
      ? {
          prompts: registry.validated?.prompt_count,
          requirements: registry.validated?.requirement_count,
          dependency_order_head: (registry.dependency_order ?? []).slice(0, 5),
        }
      : null,
    attempts: ledgerSummary(attempts.records),
    index: index ? { digest: index.digest, clean: indexDrift?.clean ?? null } : null,
  };
}

