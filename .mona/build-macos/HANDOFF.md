# Handoff — Mona macOS build

**Last checkpoint:** 2026-11-11 (P09) · verified commit `6e99507` (state
checkpoint `0660bbb`, revision 103)
**Current prompt:** P09 completed. Next eligible: **P10** — not started, not
authorized in this session.

## Where the build stands

P00–P09 are complete: qualified headless integration, a secure shell, a
contract-tested engine adapter, a native process supervisor, transactional
per-user state, a measured design system, a real multi-project catalog and
desktop shell, a live work studio, and now **Finder integration**. A folder
selected in Finder reaches Mona through a signed standalone Service, is
validated there, and opens as a registered project with the composer focused —
without starting the engine or submitting anything.

### P09 — Finder selected-folder launch (complete)

- **`native/macos-services/main.swift`** — one code path for service mode
  (`servicesProvider` pasteboard) and CLI mode. Validates `file:` URLs and
  absolute paths only (remote hosts, missing paths, files, disk roots, and
  online-only cloud items refused), resolves aliases/symlinks, locates
  `com.mona.workbench` by bundle identity, verifies its code signature, and
  forwards with a single `odoc` Apple Event. Writes
  `~/Library/Application Support/Mona/services/last-handoff.json` plus a bounded
  phase trace; refusal alerts are time-bounded so the helper cannot linger.
- **`Info.plist`** — menu title **Start new DS project with Mona**, message
  `startProject`, eligibility `public.folder` only.
- **`src/main/open/`** — `folder-request.ts` (one validator for Service,
  `open-file`, second launch, argv, drop, dialog; errno mapping; launch-argument
  parsing), `coordinator.ts` (validate → register → journal → notify; **no**
  supervisor/adapter/task API, so opening cannot start work), `service-status.ts`
  (installed/registered/enabled/last-handoff facts + recovery steps).
- **Wiring** — `app.on("open-file")` registered before ready, `second-instance`
  routed through `DesktopLifecycle.onOpenRequest`, cold-start argv parsed, and
  all of it converging on `OpenCoordinator`. New IPC: `open:folder`,
  `open:status`, `service:status`, `service:refresh`, `service:open-settings`;
  pushes: `open:result` alongside the existing `projects:changed`.
- **UI** — window folder drop with an overlay and one-folder rule, composer focus
  after a handoff, and **Settings → Finder** with measured registration state,
  the last handoff, and guided recovery (plus refresh and open-settings actions).
- **Verification** — 274 tests in 33 files; native Service smoke **21/21**;
  application handoff smoke **17/17** with the app's own report **17/17**;
  Electron security smoke **20/20**; shell smoke **32/32**; local CI green (now
  also builds the Service). Evidence:
  `docs/evidence/macos/P09-finder.md`, `artifacts/p09-*`.

## Next exact action (P10)

Read spec §8 (8.1–8.5), §10.3, §17, and MONA-009/010/024; the P05 task tables
(`src/main/state/store.ts`, `schema.ts`), the P08 studio submission path
(`src/main/work/studio.ts`), and this handoff. Then deliver the work board:

1. Task/prompt creation, editing, import, dependency validation, acceptance
   checklists, and evidence links over the transactional store.
2. One explicit execution owner per task (Mona queue vs. native workflow); no
   double scheduling; one mutating run per workspace.
3. Defined task states and transitions; code changes that invalidate test
   evidence must make verification stale; "completed" cannot come from the model.
4. Deterministic next-task selection, resume reconciliation, and a concise
   handoff generated from state.
5. Tests and evidence: dependency cycles, resume at a recorded step, queue runs
   its selection then stops, `docs/evidence/macos/P10-continuity.md`.

## Nonblocking issues carried forward

1. **No automatic runtime start from a Finder handoff** — deliberate (D-019); the
   composer is focused and **Start engine** is one click. P10/P14 may add an
   explicit "start after open" preference.
2. **Service install scope** — `~/Library/Services` for development; the packaged
   installer must place it in `/Library/Services` with the app and re-register
   (D-020, P21).
3. **LaunchServices ignores `/tmp` bundles** and the Services daemon can serve a
   stale record after a bundle change — the smoke installs in `~/Applications`,
   re-installs, and retries once (D-021). P21/P24 must verify the packaged pair.
4. **Interactive multi-selection alert** — the refusal path is tested via CLI;
   clicking the native alert is human QA (P24/P26).
5. **Window drop is not automated end to end** — `selectDroppedPath` is unit
   tested and the IPC channel is contract tested; OS-level drag input is not
   scripted. The equivalent path (Service handoff) is proven end to end.
6. **VoiceOver reading of the Services menu** — P24/P26.
7. **No Developer ID signing** — P22 prerequisite; ad-hoc locally.
8. **Single-owner runtime** — enforced; parallel ownership needs a tested engine
   decision.
9. **Direct cost unknown** — `costComplete: false` whenever the engine omits a
   price; the studio shows "at least", never zero.
10. **Adapter gaps** — approvals, clarifications, steer, artifacts, workspace
    search/restore, terminal, fleet are not adapter operations yet.
11. **Attachments** — disabled in the composer with a stated reason.
12. **Prompt queueing** — P10/P11; `Cancel queued` is honest with an empty queue.
13. **Crash-time turn reconciliation** — P19/P20 own resume policy.
14. **Electron embedded Node is 24.22.2**, not the host 26.13.0.
15. **Supervisor and Service binaries are gitignored** — P21/P22 ship and sign
    them; `build.json` receipts record target, digest, and signature status.
16. **Physical sleep not performed** — manual lid-close test remains.
17. **Route editing** — P16; Settings and the studio only display real facts.
18. **Restore UI** — P19.
19. **Second macOS account not exercised** — P24.
20. **Artifact bytes are not portable** — import reports missing digests.
21. **The Electron security smoke was stale after P08** (bridge key list lacked
    the studio methods, so `bridge_is_narrow` failed). Fixed in P09; it now lists
    the full narrow bridge.
22. **Command-1…5 was disabled while a text field had focus** (`!typing` on the
    Meta-number branch) — exactly the state a Finder handoff creates. Fixed in
    P09; the handoff smoke now switches screens with the composer focused.
23. **Evidence generation now redacts the build machine's home directory**
    (`~`), because the P09 artifacts recorded absolute paths. Earlier prompts'
    artifacts (P01) still contain one; that predates the rule and is recorded,
    not silently rewritten.

## Key files

- `.mona/build-macos/state.json` — prompt status (revision from last checkpoint).
- `.mona/build-macos/attempts.jsonl` — empty; nothing failed three times.
- `.mona/build-macos/DECISIONS.md` — D-001…D-021.
- `.mona/build-macos/BLOCKERS.md` — external prerequisites only.
- `docs/requirements-macos.json` — generated traceability.
- `docs/decisions/ADR-001…005`.
- `docs/evidence/macos/P00…P09-*.md` and `artifacts/p0*-*`.
- `native/macos-services/` — Service, `Info.plist`, `test-support/`, README.
- `src/main/open/` — `folder-request.ts`, `coordinator.ts`, `service-status.ts`.
- `src/main/` — `index.ts`, `desktop-lifecycle.ts`, `ipc.ts`, `ipc-contract.ts`,
  `projects/service.ts`; `src/main/work/` (`studio.ts`, `control.ts`, `profile.ts`).
- `src/renderer/shell/` — Shell, `drop.ts`, `FinderIntegration.tsx`, Studio,
  `timeline.ts`, `markdown.tsx`, Board, Cost, Settings.
- `scripts/` — `build-service.mjs`, `build-service-fixtures.mjs`,
  `service-smoke.mjs`, `open-smoke.mjs`, `build-supervisor.mjs`, `ci.mjs`,
  `smoke.mjs`, `shell-smoke.mjs`, `studio-smoke.mjs`, `engine-smoke.mjs`,
  `lifecycle-smoke.mjs`.
- `AGENTS.md` — operating contract and commands.
