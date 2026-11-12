# Handoff — Mona macOS build

**Last checkpoint:** 2026-11-11 (P05, revision 58) · verified commit `a817fa5`
**Current prompt:** P06 — **pending, not started**

## Where the build stands

P00–P05 are complete: qualified headless integration, a secure desktop shell, a
contract-tested engine adapter, a native process supervisor with honest desktop
lifecycle, and a transactional per-user project database. P06 (design system)
and P07 (catalog and shell) are next; P07 also depends on P06, so P06 is the only
eligible prompt.

### P05 — transactional project state (complete)

- **Mechanism.** Electron 45's built-in `node:sqlite` (Node 24.22.2), WAL,
  `synchronous=FULL`, foreign keys, one `BEGIN IMMEDIATE` write path, per-row
  revisions, checksummed migrations (schema v2). No native module.
- **Barrier.** `MaintenanceBarrier` gates every reader/writer; backup, snapshot,
  and restore are exclusive and quiesce active work.
- **Recovery.** Pre-migration snapshot via the online backup API plus a durable
  journal; a failed migration restores the snapshot; the failed DB and journal are
  preserved; newer or edited schemas are refused.
- **Identity.** Canonical path + `(dev, ino)`; aliases, `..`, trailing slashes,
  and symlinks resolve to one project; path history and deliberate relocation;
  nested repos and linked worktrees are distinct.
- **State.** Projects, paths, runtime bindings (no token column), threads, turns,
  submissions (`SqliteSubmissionStore` preserves P03 persist-before-send), tasks,
  dependencies, evidence, attempts, decisions, events/cursors, usage, capability
  snapshots, settings versions, drafts, artifacts.
- **Portability.** Digest-stable export/import with revision conflicts and atomic
  import; runtime bindings and artifact bytes excluded. Bounded artifacts,
  retention that protects blocked-task and requirement evidence, orphan sweep.
- **Disk pressure.** Headroom probe fails writes closed; real `SQLITE_FULL`
  rolls back; task completion is never claimed.
- **Storage.** `~/Library/Application Support/Mona/state/mona.sqlite`, 0600;
  directories 0700; cloud-synced and network filesystems refused. Smoke reports
  the database open with clean integrity and private modes.
- **Verification.** 166 tests in 21 files (37 new P05), Electron smoke 21/21,
  lint 0 errors, `monabuild validate` clean. Evidence:
  `docs/evidence/macos/P05-state.md`, ADR-004.

## Next exact action (P06)

Read spec §4, §12, §15; `docs/design-system.md` (to create); the P02 renderer
(`src/renderer/`), shared fixtures (`src/shared/fixtures/`), and this handoff.
Then implement the Daybreak/Afterglow design system:

1. Tokens for color, typography, spacing, surfaces, focus, density, and
   120–180 ms motion; validate contrast rather than assuming the starting palette.
2. Accessible button, input, select, tab, dialog, menu, notification, badge,
   card, inspector, empty state, skeleton, and error components; status uses text
   and icon, never color alone.
3. Fixture-backed screens for home, project studio, work board, cost lens,
   blocker card, and settings, labeled as a visual development harness. Include
   long paths, long task names, unknown cost, disconnected state, many events,
   and permission labels.
4. Command-key conventions, native chrome, Retina scaling, VoiceOver labels,
   keyboard reachability, visible focus, reduced motion, 1280×800 and 200%
   scaling. No external font/asset requests and zero inference.
5. Automated accessibility checks, keyboard inspection, screenshots in both
   themes and both densities; record real screenshots and
   `docs/evidence/macos/P06-design.md`.

Do not start P07 until P06 is complete and checkpointed.

## Nonblocking issues carried forward

1. **Single-owner runtime** — enforced (`ALREADY_OWNED`); parallel ownership needs
   a future tested engine decision.
2. **Direct cost unknown** — `codewhale exec` agent mode omits the usage split and
   price coverage.
3. **Adapter gaps** — approvals, clarifications, steer, artifacts, workspace
   search/restore, terminal, and fleet are not adapter operations yet.
4. **Usage cost completeness** — `costComplete: false` when unpriced turns exist.
5. **Electron embedded Node is 24.22.2**, not the host 26.13.0.
6. **No Developer ID signing** — P22 prerequisite.
7. **Supervisor packaging** — compiled binary gitignored; P21/P22 must ship/sign.
8. **Physical sleep not performed** — manual lid-close test remains.
9. **Renderer state not wired** — P07 consumes `RuntimeSupervisor.status()` and
   `StateStore`; the shell is still the P02 placeholder.
10. **Pause/interrupt controls have no UI** — P08/P11 connect `WorkController`.
11. **Second macOS account not exercised** — P24 owns literal multi-user denial;
    P05 verifies modes, disjoint paths, and no token column.
12. **Network filesystem check** — `/usr/bin/stat -f %T`; skipped if unavailable.
13. **Artifact bytes are not portable** — import reports missing digests.
14. **Adapter ingestion barrier** — available; P08 routes live ingestion through it.

## Key files

- `.mona/build-macos/state.json` — prompt status (revision 58).
- `.mona/build-macos/attempts.jsonl` — empty; nothing failed three times.
- `.mona/build-macos/DECISIONS.md` — D-001…D-015.
- `.mona/build-macos/BLOCKERS.md` — external prerequisites only.
- `docs/requirements-macos.json` — generated traceability (never hand-edit structure).
- `docs/decisions/ADR-001-desktop-stack.md`, `ADR-002-ipc-boundary.md`,
  `ADR-003-runtime-supervisor.md`, `ADR-004-project-state.md`.
- `docs/evidence/macos/P00…P05-*.md` and `artifacts/p0*-*`.
- `src/main/state/` — database, schema/migrations, barrier, store, identity,
  artifacts, portable, paths, `SqliteSubmissionStore`.
- `src/main/supervisor/`, `src/main/engine/`, `src/main/work/`,
  `src/main/desktop-lifecycle.ts`.
- `native/macos-supervisor/`, `native/macos-services/`.
- `scripts/build-supervisor.mjs`, `scripts/lifecycle-smoke.mjs`,
  `scripts/engine-smoke.mjs`, `scripts/ci.mjs`, `scripts/smoke.mjs`.
- `AGENTS.md` — operating contract and commands.
