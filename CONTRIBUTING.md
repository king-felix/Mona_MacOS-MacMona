# Contributing to Mona

## Status: not open for contribution

Mona is not an open-source project.

- **No license grant.** `package.json` declares `"license": "UNLICENSED"`, and
  `LICENSE.md` states the proprietary position: Mona is not open source and no
  license is granted to copy, modify, distribute, sublicense, or derive from it.
  Third-party notices — the Codewhale engine, Electron, Chromium, React and zod —
  ship inside the packaged app and are described in `LICENSE.md`.
- **No contributions are being solicited.** There is no issue triage, no
  pull-request review, and no CI workflow in this repository. External work is
  not being accepted.
- **Publication is not an invitation.** `.mona/build-macos/DECISIONS.md` records
  that the tree was pushed to a public repository
  (`github.com/king-felix/Mona_MacOS-MacMona`) at the owner's explicit
  instruction (D-101, D-102), and this checkout's `origin` points there.
  Visibility on GitHub grants nothing beyond GitHub's own terms; it does not
  change the license position above.

This file exists so the repository is ready if the owner decides to open it. It
records the gates a change would have to pass here, so that decision does not
also require reconstructing the process.

## Local setup

The full description is `docs/developer-guide-macos.md`. The short version:

```sh
npm ci
npm run typecheck
npm run build
npm run smoke
```

Prerequisites are macOS on Apple Silicon, Node 22 or later, and Xcode Command
Line Tools for the Swift helpers. The native pieces are arm64 only; the build
scripts report `skipped` on any other host rather than producing a binary.
`npm run mac:doctor` reports host and toolchain readiness without changing
anything.

## The gates a change must pass

`npm run ci` is the gate. It runs, in order, `format:check`, `lint`,
`typecheck`, `catalog:check`, the three native builds, `test`, `build`, and then
the smoke suite, stopping at the first failure. A green run means every step
ran. It then scans the built renderer for secret patterns, source maps and the
live provider key value.

Before calling a change done:

```sh
npm run ci
node tools/monabuild/cli.mjs validate
node tools/monabuild/cli.mjs secrets
```

- `format:check` must be clean. `.prettierignore` names the files that are law
  or generated and are never reformatted (`AGENTS.md`, the specification,
  `.mona/`, the requirements registry, the capability inventory, evidence).
- `validate` checks the build ledger: state schema, requirements registry,
  task/registry agreement and evidence hashes, and reports hash-index drift.
- `secrets` scans tracked files for credential patterns. It is required before
  every commit, and a finding is a stop, not a warning to note.

If a gate is red for a reason outside your change, say so with the evidence and
leave it red. Do not delete an assertion, skip a test, lower a requirement, or
weaken a check to make the run green.

## Commits

- **Local commits.** History exists on this Mac for reconciliation and rollback.
  Pushing to the configured remote is a separate, explicitly authorized action;
  do not push as part of ordinary work (AGENTS.md rule 7).
- **One change, one commit.** A commit should be reviewable on its own: the code,
  the tests that cover it, and the evidence it produces. A checkpoint commit for
  the ledger is separate from a product change.
- **Say what was verified.** Commit messages in this repository describe the
  change and the evidence behind it, including which gate ran and what it
  reported. A message that claims "green" should name the run.
- **Re-record evidence when it changes.** Smokes regenerate their own artifacts.
  When they do, record the new hashes in the same commit rather than leaving a
  stale digest behind, and never rewrite an old report to match new behaviour.
- **No secrets, no generated noise.** `node tools/monabuild/cli.mjs secrets`
  before every commit.

## Recording a decision

Durable decisions live in `.mona/build-macos/DECISIONS.md` as numbered entries:

```md
## D-107 — The install is one authorized command; the image is on request

- **Date:** 2026-11-14 (owner request)
- **Decision:** …
- **Why:** …
- **Consequence:** …
```

Rules that matter for accuracy:

- **Record the reason, not just the choice.** An entry that says what was
  decided but not why cannot be revisited honestly.
- **Cite by number and title.** The ledger is appended to over time and numbers
  have been reused (D-102, D-103 and D-104 each appear more than once), so a
  bare number can point at the wrong entry.
- **Record what was rejected.** Several entries explain why a plausible
  alternative was declined. That is the part that stops the same debate from
  recurring.
- **Do not upgrade a decision after the fact.** If circumstances change, append
  a new entry that supersedes the old one and says so.
- **Design-level decisions go to `docs/decisions/ADR-xxx-*.md`.** The `D-xxx`
  ledger records build and product decisions; the ADRs explain architecture.
- The requirements registry (`docs/requirements-macos.json`) is generated.
  Regenerate it with `node tools/monabuild/cli.mjs requirements sync`; never
  hand-edit its structure.

## Recording a blocker

The rule is in `AGENTS.md`: **three attempts, then stop.** An attempt is one
hypothesis plus one observed result; three consecutive attempts without
material progress on the same problem ends work on that problem.

```sh
node tools/monabuild/cli.mjs attempt \
  --problem <id> --requirement <MONA-xxx> \
  --hypothesis "..." --action "..." --observed "..."
```

- `attempt` enforces the count in code and refuses a fourth consecutive
  no-progress attempt. `reopen` requires a named human decision or new evidence.
  `resolve` closes the problem with a note.
- When a problem is blocked, record it in `.mona/build-macos/BLOCKERS.md`: the
  symptom, the three attempts with what each observed, and the exact help
  needed. Then continue independent work.
- Never reset the counter by opening a new session, and never work around a
  blocker by lowering a requirement, deleting a test, faking behaviour, or
  changing platform.

## Coding conventions visible in this repository

- **TypeScript strict, both projects.** `strict` and `noUncheckedIndexedAccess`
  are on in `tsconfig.main.json` and `tsconfig.renderer.json`. The renderer adds
  `react-jsx` and the DOM libs; main targets ES2022/CommonJS.
- **zod at every boundary.** IPC channels are `zod.strictObject` schemas in
  `src/main/ipc-contract.ts`; unknown channels and unknown fields are rejected.
  Shared shapes live in `src/shared/contracts` as schemas with inferred types.
- **Contracts and wire shapes are separate.** `src/shared/contracts` is Mona's
  vocabulary. `src/shared/engine-wire` transcribes the upstream Runtime API and
  is imported only by the adapter. No renderer file may reference either the
  wire types or Node/Electron internals — `test/boundary.test.ts` enforces that.
- **The engine is the only model path.** Mona does not call a provider directly,
  does not add a router, planner, or summarizer, and does not mutate the user's
  provider route. UI chrome, navigation, resume briefs and cost math make zero
  inference calls (AGENTS.md rule 1).
- **The renderer has no network.** CSP sets `connect-src 'none'`; navigation is
  limited to files inside the built renderer root; permission requests and new
  windows are denied. Do not add a fetch, a websocket, or an iframe.
- **The renderer has no general escape hatch.** One preload bridge, enumerated
  channels, a trusted-sender check before every handler. Do not add a generic
  "invoke" channel, expose `ipcRenderer`, or pass a path to a shell.
- **Show real state.** Disconnected is not stopped, interrupted is not
  completed, unknown cost is not zero, unqualified is not supported. Prefer an
  explicit status and a named error code over a plausible substitute.
- **Formatting** is Prettier with the repository's `.prettierrc.json` (100
  columns, double quotes, semicolons, trailing commas, two-space indent). Lint
  is `typescript-eslint` recommended, with `react-hooks/rules-of-hooks` as an
  error for renderer sources. Unused arguments prefixed with `_` are allowed.

## Tests

- The runner is vitest. Suites are `test/**/*.test.{ts,tsx}` in the node
  environment; a file that needs a DOM opts in with
  `// @vitest-environment jsdom`.
- `npm run test` builds the supervisor and PTY helper first, because several
  suites spawn the real native binaries. Suites whose helper is absent skip
  explicitly (`it.skipIf`), so a run on a host without them is partial; check
  the skip count before claiming a pass.
- Failure tests assert the **named** error code and the durable result, not that
  "something threw". The P20 matrix is the model: inject a real fault, then read
  the stored state back.
- Fixtures are labelled. `src/shared/fixtures` carries
  `TEST FIXTURE — NOT LIVE STATE`, and no fixture may stand in for real state in
  a success path.
- No model request in tests. Suites that need a transport bind loopback
  (`127.0.0.1`); nothing reaches a remote host. A smoke that needs the engine
  says so in its own source; nothing spends money silently.
- When you add behaviour, add the test that would fail without it, and prefer a
  test that can be shown to fail. Several entries in the ledger record exactly
  that check — the defect was reintroduced and the new test was confirmed to
  catch it.

## Evidence

A change that claims behaviour should leave evidence under
`docs/evidence/macos/`, and the ledger should point at it:

```sh
node tools/monabuild/cli.mjs evidence --prompt P20 docs/evidence/macos/P20-failure-matrix.md
```

The build writes only `.mona/build-macos/`, `docs/requirements-macos.json` and
`docs/evidence/macos/`. Do not write outside those three paths, and do not edit
the Windows `.mona/build/` ledger.
