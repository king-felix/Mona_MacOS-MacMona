# Handoff — Mona macOS build

**Last checkpoint:** 2026-11-11 (P06, revision 66) · verified commit `22391bd`
**Current prompt:** P07 — **pending, not started**

## Where the build stands

P00–P06 are complete: qualified headless integration, a secure desktop shell, a
contract-tested engine adapter, a native process supervisor with honest desktop
lifecycle, a transactional per-user project database, and a measured design
system with accessible fixture screens. P07 is the only eligible prompt: it
replaces the fixture harness with the real project catalog and desktop shell.

### P06 — design system (complete)

- **Themes.** Daybreak and Afterglow tokens in
  `src/renderer/design/tokens.ts`; 23 measured contrast pairs per theme (16 text
  at 4.5:1, 7 UI at 3:1). Coral moved off normal text; interactive borders
  strengthened after measurement. No assumption that the starting palette passed.
- **Components.** Accessible button, icon button, field, input, textarea,
  select, tabs (roving focus), dialog (focus trap, Escape, restore), menu
  (keyboard), notification, callout, badge/status badge, card, inspector, empty
  state, skeleton, error state, segmented control, switch, keycap.
- **Screens.** Home, studio, work board, cost lens, blocker, settings; long
  paths and names, 40-event timeline, unknown cost, disconnected, blocked, empty,
  permission and credential states. Clearly labeled fixture harness.
- **Scaling/motion.** 1280×800 and real 200% zoom (640×400 CSS), no horizontal
  page overflow; density modes; 120–180 ms motion; reduced motion honored.
- **Verification.** 26 design tests, 192 total, axe zero serious/critical across
  13 renderings, keyboard receipt shows skip-link-first and a solid 2 px focus
  ring, 15 Electron-rendered screenshots, no-network source scan, smoke 21/21.
  Evidence: `docs/design-system.md`, `docs/evidence/macos/P06-design.md`,
  `artifacts/p06-*`.

## Next exact action (P07)

Read spec §4.2, §4.3, §5, §7 (004–006, 029), §10.1; `src/main/state/store.ts`
and `submission-store.ts`; `src/main/supervisor/runtime-supervisor.ts`; the P06
design system and screens; this handoff. Then assemble the real shell:

1. Main-process project service over `StateStore`: open/create/import existing
   folder, recent/pinned, label rename, archive, local search, reveal folder,
   relocation, catalog removal. Canonicalize paths, dedupe aliases, distinguish
   nested repos/worktrees, and never delete source files when removing a
   catalog entry.
2. Add strict IPC channels and bridge methods for catalog operations, app/state
   facts, reveal, and selected project view state. Validate every payload;
   never expose the database or shell.
3. Bind selection to the correct runtime binding and persisted view state;
   preserve drafts per project/thread. Display actual engine connection, branch,
   model, permission, and local availability. Missing credentials/runtime must
   prevent execution while history and settings stay usable.
4. Add the command palette shell and keyboard navigation; route actions safely.
   No fake percentage complete and no hard-coded engine badge in production.
5. Tests: catalog survives restart; relocation rebinds deliberately; archived
   projects restore; dirty/non-Git folders open; path aliases deduplicate;
   switching projects during a simulated run keeps drafts/turns/costs/permissions
   isolated; offline history works. Verify every major screen is reachable
   without a mouse.
6. Evidence: `docs/evidence/macos/P07-projects.md`, plus screenshots of the real
   shell. This is the last prompt in the authorized queue; report and pause.

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
9. **Harness is not live state** — P07 replaces it; P06 screenshots are renders of
   fixture data.
10. **Human aesthetic review and VoiceOver walkthrough** — P24/P26.
11. **Second macOS account not exercised** — P24 owns literal multi-user denial.
12. **Network filesystem check** — `/usr/bin/stat -f %T`; skipped if unavailable.
13. **Artifact bytes are not portable** — import reports missing digests.
14. **Adapter ingestion barrier** — available; P08 routes live ingestion through it.

## Key files

- `.mona/build-macos/state.json` — prompt status (revision 66).
- `.mona/build-macos/attempts.jsonl` — empty; nothing failed three times.
- `.mona/build-macos/DECISIONS.md` — D-001…D-016.
- `.mona/build-macos/BLOCKERS.md` — external prerequisites only.
- `docs/requirements-macos.json` — generated traceability (never hand-edit structure).
- `docs/design-system.md`, `docs/decisions/ADR-001…004`.
- `docs/evidence/macos/P00…P06-*.md` and `artifacts/p0*-*`.
- `src/main/state/` — database, schema/migrations, barrier, store, identity,
  artifacts, portable, paths, `SqliteSubmissionStore`.
- `src/renderer/design/` — tokens, icons, primitives, fixtures, Harness, screens.
- `src/main/supervisor/`, `src/main/engine/`, `src/main/work/`,
  `src/main/desktop-lifecycle.ts`, `src/main/ipc-contract.ts`.
- `native/macos-supervisor/`, `native/macos-services/`.
- `scripts/build-supervisor.mjs`, `scripts/lifecycle-smoke.mjs`,
  `scripts/engine-smoke.mjs`, `scripts/ci.mjs`, `scripts/smoke.mjs`.
- `AGENTS.md` — operating contract and commands.
