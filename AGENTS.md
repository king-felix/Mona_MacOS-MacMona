# AGENTS.md — Mona macOS build

This file is the stable operating contract for every agent session in this
repository. It is not the product specification. Read it first, then the
documents it points to.

## What this repository is

Mona is a native Apple Silicon desktop workbench for the Codewhale engine:
Finder → folder → Codewhale workspace, with durable project state, visible
cost, and honest status. This checkout is the **macOS 1.0** build.

Authoritative documents:

- `Mona_macOS_Project.md` — product and engineering specification (read once at
  bootstrap; afterwards read only the sections a prompt names, unless the file
  hash changed).
- `Mona_macOS_PROMPTS.md` — the prompt sequence, acceptance gates, and the
  shared operating contract (O1–O5). The assigned prompt governs its own work.
- `docs/requirements-macos.json` — generated traceability: 28 prompts
  (P00–P27), 30 `MONA-xxx` requirements, 8 `MAC-xxx` requirements, and the
  validated dependency order. Regenerate with `node tools/monabuild/cli.mjs
  requirements sync`; never hand-edit the generated structure.
- `.mona/build-macos/state.json` — single source of truth for prompt status.
- `.mona/build-macos/HANDOFF.md` — short resume pointer, current prompt, next
  exact action.
- `.mona/build-macos/DECISIONS.md` — durable decisions and their rationale.
- `.mona/build-macos/BLOCKERS.md` — open problems, attempts, and the exact help
  needed from Victor.
- `docs/evidence/macos/` — per-prompt evidence and captured command output.
- `docs/discovery-macos.md` — measured host/engine facts.
- `docs/codewhale-capabilities-macos.json` — capability inventory (structure at
  P00; populated and qualified at P01).

## Non-negotiable rules

1. **Codewhale stays the engine.** Mona never calls a model provider directly
   for normal work, never adds a router, planner, or automatic summarizer, and
   never mutates the user's provider route. UI chrome, navigation, resume
   briefs, and cost math make **zero** inference calls.
2. **Show real state.** Disconnected is not stopped; interrupted is not
   completed; unknown cost is not zero; unqualified is not supported.
3. **Three attempts, then stop.** An attempt is one hypothesis plus one observed
   result. After three consecutive attempts without material progress on the
   same problem, stop that problem, record evidence and the exact help needed in
   `BLOCKERS.md`, and continue independent eligible work. Never reset the count
   by opening a new session, and never work around the blocker by lowering a
   requirement, deleting a test, faking behavior, or changing platform.
   Use `monabuild attempt` / `monabuild reopen` so the count is enforced in code.
4. **Separate the two ledgers.** This build writes only `.mona/build-macos/`,
   `docs/requirements-macos.json`, and `docs/evidence/macos/`. The Windows
   `.mona/build/` ledger and Windows sources are out of scope and must not be
   touched, unless a later prompt explicitly coordinates through P25.
5. **No secrets in the repository.** Never copy credential files, print
   environment secrets, or commit keys. Provider/route discovery uses redacted
   inspection (`codewhale config dump`, `codewhale config doctor`). Run
   `node tools/monabuild/cli.mjs secrets` before every commit.
6. **Native arm64 only.** No Rosetta, no Intel substitution, no runtime
   compilation on recipient machines. Record every place where the host differs
   from the recipient environment instead of assuming.
7. **No public release, purchases, or invented remotes.** Local builds, local
   commits, and private notarization with existing credentials are allowed.
   Public hosting, new Apple enrollment, and remote repositories require Victor.
8. **Do not silently upgrade the engine.** The pinned engine is the installed
   0.10.2 build recorded in `state.json` and the discovery report. Any engine
   change is an explicit, tested compatibility decision.

## Checkpoint protocol

```sh
node tools/monabuild/cli.mjs status
node tools/monabuild/cli.mjs validate
node tools/monabuild/cli.mjs checkpoint --expect-revision <n> \
  --patch-json '{"current_prompt_status":"verifying","tasks":{"P00":{"status":"verifying"}}}'
node tools/monabuild/cli.mjs evidence --prompt P00 docs/evidence/macos/P00-bootstrap.md
node tools/monabuild/cli.mjs index --write
node tools/monabuild/cli.mjs recover      # after any interruption
node tools/monabuild/cli.mjs requirements sync
```

`recover` restores the last committed revision from `state.json.bak`, or — on a
fresh clone, where that local backup does not exist — from the committed blob at
`HEAD`, preserving any damaged file as evidence first.

`checkpoint` refuses to write when the revision you read is stale, validates
against `tools/monabuild/schemas/state.schema.json`, writes atomically, and keeps
the previous revision in `state.json.bak`. `recover` restores that backup when
the committed file is damaged and preserves the damaged copy for diagnosis.

## Session start and resume

1. Read this file, `.mona/build-macos/HANDOFF.md`, `state.json`, and
   `BLOCKERS.md`.
2. Verify the working tree and `monabuild validate`; if a task claims `running`,
   reconcile with the actual files and evidence first.
3. Pick the explicitly assigned prompt, else the unfinished current prompt,
   else the earliest eligible pending prompt from `monabuild next`.
4. Read only that prompt's spec sections and the files it names.
5. Finish the prompt end to end: implementation, tests, docs, requirement
   evidence, checkpoint, handoff. Then report and pause unless a queue was
   explicitly authorized.

## Product build commands (as they land)

The macOS build exposes `mac:doctor`, `mac:bootstrap`, `mac:dev`, `mac:test`,
`mac:package:local`, `mac:install`, `mac:release:preflight`, `mac:release`, and
`mac:verify-release` (spec §21). `mac:install` builds, packages and installs the
result with `sudo`, then runs the install-side gates against the installed copy;
`mac:package:dmg` exists but is on request only and is not part of the build loop.
`mac:release` is implemented and fails closed: the owner has decided there is no
Apple Developer account, so distribution is local and build-it-yourself (D-103).

## Conflict policy

No other agent instruction file existed when this contract was created. If a
later file (for example a Windows `AGENTS.md` merged in for P25) conflicts with
this one, preserve both, resolve in favor of the user's current request, then
this contract, then the nearest project instruction, and record the conflict in
`DECISIONS.md`.
