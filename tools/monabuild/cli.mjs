#!/usr/bin/env node
// monabuild — bootstrap checkpoint utility for the Mona macOS build ledger.
// Commands are deliberately small and deterministic. This utility is build
// infrastructure, not part of the Mona desktop application.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256File, readJsonStrict, atomicWriteJson } from "./lib/atomic.mjs";
import { validate } from "./lib/schema.mjs";
import {
  checkpoint,
  computeNextEligible,
  loadSchema,
  readValidated,
  recover,
  requirementsSchema,
  stateSchema,
  summarize,
  attemptSchema,
  addEvidence,
} from "./lib/store.mjs";
import {
  buildRegistry,
  loadRegistrySources,
  mergeWithExisting,
  validateRegistry,
  PROMPTS_FILE,
  SPEC_FILE,
} from "./lib/requirements.mjs";
import {
  ledgerSummary,
  problemState,
  readAttempts,
  recordAttempt,
  reopenProblem,
  resolveProblem,
} from "./lib/attempts.mjs";
import { buildIndex, compareIndex, readIndex } from "./lib/index.mjs";
import { gitTrackedFiles, scanFiles } from "./lib/secrets.mjs";
import { validateEverything } from "./lib/validate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, "..", "..");

const EXIT = { ok: 0, invalid: 1, usage: 2, refused: 3 };

function paths(root) {
  const buildDir = join(root, ".mona", "build-macos");
  return {
    root,
    buildDir,
    statePath: join(buildDir, "state.json"),
    attemptsPath: join(buildDir, "attempts.jsonl"),
    indexPath: join(buildDir, "index.json"),
    localPath: join(buildDir, "local.json"),
    requirementsPath: join(root, "docs", "requirements-macos.json"),
    evidenceDir: join(root, "docs", "evidence", "macos"),
  };
}

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const [key, inline] = token.slice(2).split("=", 2);
      const assign = (value) => {
        if (Object.hasOwn(args.flags, key)) {
          args.flags[key] = [].concat(args.flags[key], value);
        } else {
          args.flags[key] = value;
        }
      };
      if (inline !== undefined) {
        assign(inline);
      } else if (nextIsValue(argv[i + 1])) {
        assign(argv[i + 1]);
        i += 1;
      } else {
        assign(true);
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function nextIsValue(token) {
  return token !== undefined && !token.startsWith("--");
}

function rootFrom(args) {
  return resolve(args.flags.root ?? process.env.MONA_ROOT ?? DEFAULT_ROOT);
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message, code = EXIT.invalid, extra = {}) {
  printJson({ ok: false, error: message, ...extra });
  process.exitCode = code;
}

function loadRegistryFile(p) {
  return readJsonStrict(p.requirementsPath);
}

function commandValidate(args) {
  const p = paths(rootFrom(args));
  const report = validateEverything(p);
  if (!report.ok) {
    process.exitCode = EXIT.invalid;
  }
  printJson(report);
  return report;
}

function commandStatus(args) {
  const p = paths(rootFrom(args));
  const { value: state } = readValidated(p.statePath, stateSchema());
  const registry = loadRegistryFile(p);
  const summary = summarize(state, registry.prompts);
  const attempts = ledgerSummary(readAttempts(p.attemptsPath).records);
  printJson({ ok: true, ...summary, attempts });
}

function commandCheckpoint(args) {
  const p = paths(rootFrom(args));
  const expectRevision = Number(args.flags["expect-revision"]);
  if (!Number.isInteger(expectRevision)) {
    return fail("--expect-revision <n> is required", EXIT.usage);
  }
  let patch = {};
  if (args.flags["patch-file"]) {
    patch = readJsonStrict(resolve(args.flags["patch-file"]));
  } else if (args.flags["patch-json"] || args.flags.patch) {
    try {
      patch = JSON.parse(args.flags["patch-json"] ?? args.flags.patch);
    } catch (error) {
      return fail(`--patch is not valid JSON: ${error.message}`, EXIT.usage);
    }
  }
  try {
    const result = checkpoint(p.statePath, { expectRevision, patch });
    if (args.flags["write-index"]) {
      atomicWriteJson(p.indexPath, buildIndex(p.root, p));
    }
    printJson({
      ok: true,
      revision: result.state.revision,
      abandoned_temp_files: result.abandonedTempFiles,
      current_prompt: result.state.current_prompt,
      current_prompt_status: result.state.current_prompt_status,
    });
  } catch (error) {
    if (error.code === "ECONFLICT") {
      return fail(error.message, EXIT.refused, { actual_revision: error.actualRevision });
    }
    return fail(error.message, EXIT.invalid, { validation: error.validation ?? null });
  }
}

function commandRecover(args) {
  const p = paths(rootFrom(args));
  const report = recover(p.statePath);
  printJson({ ok: report.ok, ...report });
  if (!report.ok) process.exitCode = EXIT.refused;
}

function commandNext(args) {
  const p = paths(rootFrom(args));
  const { value: state } = readValidated(p.statePath, stateSchema());
  const registry = loadRegistryFile(p);
  const eligible = computeNextEligible(state, registry.prompts);
  if (args.flags.write) {
    const result = checkpoint(p.statePath, {
      expectRevision: state.revision,
      patch: { next_eligible_prompts: eligible },
    });
    printJson({ ok: true, next_eligible_prompts: eligible, revision: result.state.revision });
    return;
  }
  printJson({ ok: true, next_eligible_prompts: eligible, revision: state.revision });
}

function commandRequirements(args) {
  const p = paths(rootFrom(args));
  const action = args._[1] ?? "check";
  const sources = loadRegistrySources(p.root);
  const now = new Date().toISOString();
  const fresh = buildRegistry({ ...sources, now });

  if (action === "sync") {
    const existing = existsSync(p.requirementsPath) ? readJsonStrict(p.requirementsPath) : null;
    const merged = mergeWithExisting(fresh, existing);
    const result = validate(fresh, requirementsSchema());
    if (!result.valid) {
      return fail("generated registry failed schema validation", EXIT.invalid, { errors: result.errors });
    }
    atomicWriteJson(p.requirementsPath, merged);
    printJson({
      ok: fresh.validated.ok,
      written: p.requirementsPath,
      prompts: fresh.validated.prompt_count,
      requirements: fresh.validated.requirement_count,
      dependency_order: fresh.dependency_order,
      errors: fresh.validated.errors,
      warnings: fresh.validated.warnings,
    });
    if (!fresh.validated.ok) process.exitCode = EXIT.invalid;
    return;
  }

  const existing = loadRegistryFile(p);
  const registryCheck = validateRegistry(existing, {
    specSha256: sources.specSha256,
    promptsSha256: sources.promptsSha256,
  });
  printJson({
    ok: fresh.validated.ok && registryCheck.ok,
    source_validation: fresh.validated,
    registry_validation: registryCheck,
  });
  if (!fresh.validated.ok || !registryCheck.ok) process.exitCode = EXIT.invalid;
}

function commandAttempt(args) {
  const p = paths(rootFrom(args));
  const required = ["problem", "requirement", "hypothesis", "action", "observed"];
  const missing = required.filter((key) => typeof args.flags[key] !== "string");
  if (missing.length > 0) return fail(`missing flags: ${missing.map((m) => `--${m}`).join(", ")}`, EXIT.usage);
  try {
    const result = recordAttempt(p.attemptsPath, {
      problemId: args.flags.problem,
      requirement: args.flags.requirement,
      hypothesis: args.flags.hypothesis,
      action: args.flags.action,
      observed: args.flags.observed,
      materialProgress: Boolean(args.flags.progress),
      evidence: args.flags.evidence ? [].concat(args.flags.evidence) : [],
      note: args.flags.symptom,
    });
    printJson({ ok: true, ...result });
  } catch (error) {
    const code = error.code === "EBLOCKED" ? EXIT.refused : EXIT.invalid;
    fail(error.message, code, { problem_state: error.problemState ?? null });
  }
}

function commandReopen(args) {
  const p = paths(rootFrom(args));
  try {
    const result = reopenProblem(p.attemptsPath, {
      problemId: args.flags.problem,
      requirement: args.flags.requirement,
      decisionRef: args.flags["decision-ref"],
      note: args.flags.note,
    });
    printJson({ ok: true, ...result });
  } catch (error) {
    fail(error.message, error.code === "ENOTBLOCKED" ? EXIT.refused : EXIT.invalid);
  }
}

function commandResolve(args) {
  const p = paths(rootFrom(args));
  try {
    const result = resolveProblem(p.attemptsPath, {
      problemId: args.flags.problem,
      requirement: args.flags.requirement,
      note: args.flags.note,
      evidence: args.flags.evidence ? [].concat(args.flags.evidence) : [],
    });
    printJson({ ok: true, ...result });
  } catch (error) {
    fail(error.message, EXIT.invalid);
  }
}

function commandIndex(args) {
  const p = paths(rootFrom(args));
  const index = buildIndex(p.root, p);
  if (args.flags.write) {
    atomicWriteJson(p.indexPath, index);
    printJson({ ok: true, written: p.indexPath, digest: index.digest, files: index.files.length, git: index.git });
    return;
  }
  printJson({ ok: true, ...index });
}

function commandSecrets(args) {
  const p = paths(rootFrom(args));
  const files = args._.slice(1);
  const targets = files.length > 0 ? files : gitTrackedFiles(p.root);
  const findings = scanFiles(p.root, targets);
  printJson({ ok: findings.length === 0, scanned: targets.length, findings });
  if (findings.length > 0) process.exitCode = EXIT.invalid;
}

function commandEvidence(args) {
  const p = paths(rootFrom(args));
  const prompt = args.flags.prompt;
  const files = args._.slice(1);
  if (!prompt || files.length === 0) return fail("usage: monabuild evidence --prompt P00 <path>...", EXIT.usage);
  try {
    const result = addEvidence(p.statePath, { prompt, paths: files, note: args.flags.note });
    printJson({ ok: true, revision: result.revision, evidence: result.evidence });
  } catch (error) {
    fail(error.message, error.code === "ECONFLICT" ? EXIT.refused : EXIT.invalid);
  }
}

function usage() {
  process.stdout.write(
    [
      "monabuild — Mona macOS build ledger utility",
      "",
      "  validate                     Validate state, registry, attempts, index",
      "  status                       Compact build status",
      "  checkpoint --expect-revision N [--patch-json JSON | --patch-file F] [--write-index]",
      "  recover                      Recover an interrupted checkpoint",
      "  next [--write]               List (and record) eligible pending prompts",
      "  requirements sync|check      Regenerate / validate the requirement registry",
      "  attempt --problem ID --requirement R --hypothesis H --action A --observed O [--progress] [--evidence P]",
      "  reopen --problem ID --requirement R --decision-ref REF [--note N]",
      "  resolve --problem ID --requirement R [--note N] [--evidence P]",
      "  evidence --prompt P00 <path>...  Add evidence with a file hash",
      "  index [--write]              Print or write the hash index",
      "  secrets [path...]            Scan tracked files for credential patterns",
      "  hash <path>                  Print a file's SHA-256",
      "",
      "All commands accept --root <dir>.",
    ].join("\n") + "\n",
  );
}

const commands = {
  validate: commandValidate,
  status: commandStatus,
  checkpoint: commandCheckpoint,
  recover: commandRecover,
  next: commandNext,
  requirements: commandRequirements,
  attempt: commandAttempt,
  reopen: commandReopen,
  resolve: commandResolve,
  evidence: commandEvidence,
  index: commandIndex,
  secrets: commandSecrets,
  hash: (args) => {
    const file = args._[1];
    if (!file) return fail("usage: monabuild hash <path>", EXIT.usage);
    process.stdout.write(`${sha256File(resolve(rootFrom(args), file))}  ${file}\n`);
  },
};

function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    usage();
    return;
  }
  const args = parseArgs(rest);
  args._ = [command, ...args._];
  const handler = commands[command];
  if (!handler) {
    usage();
    process.exitCode = EXIT.usage;
    return;
  }
  handler(args);
}

main(process.argv.slice(2));
