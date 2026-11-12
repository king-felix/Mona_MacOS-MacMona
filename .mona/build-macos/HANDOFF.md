# Handoff — Mona macOS build

**Last checkpoint:** 2026-11-11 (P07, revision 74) · verified commit `82e6329`
**Current prompt:** P07 completed. **Queue complete** (P05–P07). Next eligible:
P08 — not started, not authorized in this session.

## Where the build stands

P00–P07 are complete: qualified headless integration, a secure shell, a
contract-tested engine adapter, a native process supervisor, transactional
per-user state, a measured design system, and a real multi-project catalog and
desktop shell. The shell reads real state and the real supervisor status; it
does not submit work or start an engine yet (P08).

### P07 — real catalog and shell (complete)

- **ProjectService** over `StateStore`: list/search, open/import, detail, rename,
  pin, archive/restore, remove, relocate, reveal, view state, drafts, Git branch,
  usage, stored events, and a real engine snapshot. Removal never touches source
  files. One shell thread per project; reopening never resumes work.
- **IPC/bridge** — strict channels with typed result envelopes; project ids
  branded; revisions required for mutations; no filesystem-delete channel. 17
  named bridge methods; no raw ipcRenderer. Native File → Open Project… (`⌘O`)
  opens the real folder dialog and selects the project.
- **Shell** — real Home, Studio, Work board, Cost lens, Settings. Engine badge,
  blocked reason, branch, usage, local paths, permissions, and integrity are
  real. Model/permission say “not reported”/“unknown” until a live turn verifies
  them. Drafts and view state are per project; command palette and `⌘1`–`⌘5`
  reach every screen.
- **Verification** — 205 tests in 25 files (10 service, 8 IPC), shell smoke 29/29
  checks with four rendered screenshots, Electron smoke 21/21, lint 0 errors,
  `monabuild validate` clean. Evidence: `docs/evidence/macos/P07-projects.md`,
  `artifacts/p07-*`.

## Next exact action (P08)

Read spec §4, §5.2, §6, §7 (007, 008, 012, 014), §13; the P03 adapter and
`SqliteSubmissionStore`; P04 supervisor transition API; the P07
`ProjectService` detail/engine snapshot; this handoff. Then deliver the live work
studio:

1. Wire the real adapter runtime to the selected project: start/attach through
   `RuntimeSupervisor`, authenticate loopback, bind the project and thread, and
   keep one mutating turn per workspace.
2. Persist submission intent before sending; reconcile lost responses; never
   blind-retry. Stream events into the store (transactional projections and
   cursors), deduplicate replay, and render the timeline from real events.
3. Enable the composer with Plan/Work and effective profile/permission display;
   save drafts; show actual cost/usage, unknown when unpriced.
4. Connect Pause after task, Interrupt now, cancel-queued, and quit-and-stop to
   `WorkController`, with receipts and honest uncertainty. Do not hide controls.
5. Handle connecting, running, reconnecting, disconnected, failed, missing
   runtime, missing credentials, and unknown-cost states. No fake completion or
   percentage.
6. Tests and evidence: real pinned-engine smoke through the shell, submission
   loss/reconcile, replay dedup, interrupt receipt, project isolation during a
   live turn, offline history; `docs/evidence/macos/P08-studio.md`.

The authorized queue was P05–P07; P08 is the next eligible prompt but waits for
the next instruction.

## Nonblocking issues carried forward

1. **Single-owner runtime** — enforced; parallel ownership needs a tested engine
   decision.
2. **Direct cost unknown** — `codewhale exec` agent mode omits the usage split
   and price coverage.
3. **Adapter gaps** — approvals, clarifications, steer, artifacts, workspace
   search/restore, terminal, fleet are not adapter operations yet.
4. **Usage cost completeness** — `costComplete: false` when unpriced turns exist.
5. **Electron embedded Node is 24.22.2**, not the host 26.13.0.
6. **No Developer ID signing** — P22 prerequisite; local/ad-hoc only.
7. **Supervisor packaging** — compiled binary gitignored; P21/P22 ship and sign.
8. **Physical sleep not performed** — manual lid-close test remains.
9. **Live studio not wired** — P08; composer disabled with reason, no fake run.
10. **Task creation** — P10; board shows stored tasks only.
11. **Route editing** — P16; Settings shows actual engine facts only.
12. **Restore UI** — P19; recovery panel describes the mechanism.
13. **Human aesthetic and VoiceOver QA** — P24/P26.
14. **Second macOS account not exercised** — P24; path/mode/no-token verified.
15. **Network filesystem check** — `/usr/bin/stat -f %T`; skipped if unavailable.
16. **Artifact bytes are not portable** — import reports missing digests.
17. **Native menu folder picker** — automation seeds the project; the dialog seam
    is covered by service tests.

## Key files

- `.mona/build-macos/state.json` — prompt status (revision 74).
- `.mona/build-macos/attempts.jsonl` — empty; nothing failed three times.
- `.mona/build-macos/DECISIONS.md` — D-001…D-017.
- `.mona/build-macos/BLOCKERS.md` — external prerequisites only.
- `docs/requirements-macos.json` — generated traceability.
- `docs/design-system.md`, `docs/decisions/ADR-001…004`.
- `docs/evidence/macos/P00…P07-*.md` and `artifacts/p0*-*`.
- `src/main/state/`, `src/main/projects/service.ts`, `src/main/supervisor/`,
  `src/main/engine/`, `src/main/work/`, `src/main/ipc.ts`,
  `src/main/ipc-contract.ts`, `src/main/menu.ts`, `src/preload/index.ts`.
- `src/renderer/shell/` — Shell, Home, Studio, Board, Cost, Settings, visual
  helpers. `src/renderer/design/` — tokens, primitives, icons, harness.
- `scripts/shell-smoke.mjs`, `scripts/smoke.mjs`, `scripts/ci.mjs`,
  `scripts/lifecycle-smoke.mjs`, `scripts/engine-smoke.mjs`.
- `native/macos-supervisor/`, `native/macos-services/`.
- `AGENTS.md` — operating contract and commands.
