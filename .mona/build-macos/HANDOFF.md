# Handoff — Mona macOS build

**Last checkpoint:** 2026-11-11 (P13) · revision 191 · P13 verification commit b6def91
**Current prompt:** P13 completed. Next eligible: **P14** — not started, not
authorized in this session.

## Where the build stands

P00–P13 are complete: qualified headless integration, a secure shell, a
contract-tested engine adapter, a native process supervisor, transactional
per-user state, a measured design system, a real multi-project catalog and
desktop shell, a live work studio, Finder integration, a prompt work board and
durable continuation, an enforced attempt ledger, a durable cost ledger, and now
**trustworthy change receipts, Git review, and native restore**.

### P13 — Changes, evidence, Git, and restore (complete)

- **`docs/decisions/ADR-008`** — attribution stops at the engine's evidence;
  Git uses a fixed non-destructive allowlist; restore is the engine's checked
  one-file revert, never a second snapshot engine.
- **`src/main/state/schema.ts` migration v6** — `change_sets`,
  `change_files`, `restore_receipts`, `commit_receipts`, and `events.turn_id`.
- **`src/main/work/changes.ts`** — capture from the turn-artifact route with
  `turn.artifacts` upgrade and non-regressing evidence ranks; unavailable
  deltas stored with the engine's reason; tool, workspace-delta, artifact, and
  unreceipted attribution; lazy text/diff windows; preview/ack restore; commit
  and stage actions; revision-checked writes.
- **`src/main/work/git.ts`** — porcelain v2 status, branch/worktree/upstream,
  bounded literal diffs, selected staging and selected commits. Only
  `rev-parse`, `status`, `diff`, `log`, `add`, `commit`; no reset, clean,
  checkout, stash, or force.
- **`src/main/engine/adapter.ts`** — turn artifacts, artifact content, per-call
  changes, file-revert, snapshot list/probe, workspace read/write, with typed
  restore and write errors.
- **Changes lens** — receipts and Workspace & Git views, virtualized code
  windows, tool/test receipt cards, commit evidence, restore dialog with exact
  scope/exclusions/conflicts/recovery, and a revision-checked editor.
- **Verification** — 382 tests in 41 files; sample ledger **27/27**; Electron
  shell **56/56** with a seeded receipt and dirty repository; local CI green
  including the new `smoke:changes`. Evidence:
  `docs/evidence/macos/P13-review.md`.

## Next exact action (P14)

Read spec §4, §5.3, §12, the P14 prompt body, and the P10–P13 state surfaces.
Then implement, test, evidence, and checkpoint:

1. Resume Brief and “Since you left” from deterministic task/event/evidence
   data; no summarizing model call, no fake completion percentage.
2. Focus Mode, saved panel layouts/density, project color/monogram identities,
   prompt favorites, keyboard shortcuts, menu-bar/Dock state, completion and
   blocker notifications, quiet hours, deduplication.
3. Close-versus-Quit behavior while work continues, Dock reopen, menu-bar
   status, explicit quit/interrupt, launch-at-login off by default,
   keep-awake scoped to active work and cleaned up.
4. Actual UI screenshots in both themes, notification tests, and
   `docs/evidence/macos/P14-polish.md`. If every Foundation/Core requirement
   has its remaining evidence, prepare a clearly labeled Core preview; do not
   claim full Codewhale parity.

## Nonblocking issues carried forward

1. **No per-turn engine price** — attribution uses the cumulative thread total;
   an unsplittable total becomes an `unallocated` residual counted once.
2. **No shipped rate table** — until a card is recorded, unpriced routes stay
   unknown and no local estimate is produced (ADR-007).
3. **Quota-billed providers stay unknown** even with a card.
4. **A local budget is not an invoice cap** — a request in flight may complete
   after a stop.
5. **No balance** — never derived from local usage.
6. **Concurrent reservation currency is unproven** — the gate counts in-flight
   slots; a concurrent executor must re-run it per slot (P15/P21).
7. **Tool/API charges are not split out** — the engine reports one total.
8. **Recalculation is preview-only.**
9. **Engine-internal loops are cooperative** (ADR-006).
10. **Turn completion is not auto-projected** — P14 owns moving a finished turn
    into verification.
11. **Native workflows are not gated by pause-after-task** — P15.
12. **The attempt ledger is not in the portable bundle** — P19 may extend it.
13. **Confirmed live interrupt remains P08 evidence**; interactive QA is P24/P26.
14. **No automatic runtime start from a Finder handoff** — deliberate (D-019).
15. **Service install scope** — `~/Library/Services` for development; packaged
    installer must use `/Library/Services` (D-020, P21).
16. **LaunchServices ignores `/tmp` bundles** (D-021); P21/P24 verify the pair.
17. **Interactive multi-selection alert and VoiceOver** — P24/P26.
18. **No Developer ID signing** — P22 prerequisite; ad-hoc locally.
19. **Single-owner runtime** is enforced; parallel ownership needs an engine
    decision.
20. **Adapter gaps** — approvals, clarifications, steer, artifacts older than
    the recorded turn, terminal, fleet are not adapter operations yet.
21. **Attachments** are disabled in the composer with a stated reason.
22. **Fingerprint is bounded and local** (20,000 files / 64 MB).
23. **Plan export does not carry task status** — P19.
24. **Electron embedded Node is 24.22.2**, not the host 26.13.0.
25. **Supervisor and Service binaries are gitignored** — P21/P22 ship them.
26. **Physical sleep and a second macOS account** — manual QA (P24).
27. **Artifact bytes are not portable** — import reports missing digests.
28. **Evidence generation redacts the build machine's home directory.**
29. **P07/P11 shell screenshots are hash-pinned evidence.** The P13 shell smoke
    rewrote them; they were restored to their committed bytes, so P07/P11 stay
    valid. `p12-shell-cost*.png` also kept their committed bytes;
    `p13-shell-changes.png` is the P13 capture.
30. **Whole-workspace restore is not surfaced.** P13 exposes snapshot listing and
    one-file `file-revert`. `POST /v1/snapshots/{id}/restore` and forking
    `patch-undo` remain engine-native gaps (MONA-CAP-063).
31. **Restore needs the live studio.** Without it the checked revert route is
    unreachable; Mona deliberately does not build a local snapshot store.
32. **Snapshot pruning is the engine's** (newest 50 + newest 50 turn
    boundaries); a pruned restore point surfaces as the engine's 409.
33. **Restore cannot undo excluded effects** — build output, dependency
    installs, binaries, `.gitignore` paths, deployments, API writes, installed
    software.
34. **Attribution is evidence, not authorship.** `workspace_delta` and
    `unreceipted` paths may be the user's work and require acknowledgement.
35. **Selected commits use working-tree content.** A file staged and then edited
    needs an explicit `includeUnstaged` choice; partial hunk staging is not
    offered.
36. **No per-call diff when the engine recorded none** — the view says so or
    shows a labelled current Git diff; it never mislabels it.
37. **Binary/large content is not displayed** — binary is reported as binary,
    >16 MiB as oversized; text editing needs a complete, non-truncated window.
38. **Git is local only** — no remote operations, history rewriting, stash, or
    conflict-resolution automation.

## Key files

- `.mona/build-macos/state.json` — prompt status (revision 191).
- `.mona/build-macos/attempts.jsonl` — empty; nothing failed three times.
- `.mona/build-macos/DECISIONS.md` — D-001…D-032.
- `.mona/build-macos/BLOCKERS.md` — external prerequisites only.
- `docs/requirements-macos.json` — MONA-014/015 satisfied with P13 evidence.
- `docs/decisions/ADR-001…008`; ADR-008 is changes/Git/restore.
- `src/main/work/` — `board.ts`, `changes.ts`, `control.ts`, `costs.ts`,
  `cost-math.ts`, `fingerprint.ts`, `git.ts`, `studio.ts`, `profile.ts`.
- `src/renderer/shell/` — Shell, Board, Changes, Studio, Home, Cost, Settings,
  drop, FinderIntegration.
- `scripts/` — `board-smoke.mjs`, `changes-smoke.mjs`, `cost-smoke.mjs`,
  `ci.mjs`, `smoke.mjs`, `shell-smoke.mjs`, `studio-smoke.mjs`,
  `engine-smoke.mjs`, `lifecycle-smoke.mjs`, `open-smoke.mjs`,
  `service-smoke.mjs`, build scripts.
- `AGENTS.md` — operating contract and commands (rule 3 is the stable
  three-attempt instruction).
