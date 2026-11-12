# Handoff — Mona macOS build

**Last checkpoint:** 2026-11-11 (P08) · verified commit `5676c52`
**Current prompt:** P08 completed. Next eligible: **P09** — not started, not
authorized in this session.

## Where the build stands

P00–P08 are complete: qualified headless integration, a secure shell, a
contract-tested engine adapter, a native process supervisor, transactional
per-user state, a measured design system, a real multi-project catalog and
desktop shell, and now a **live work studio**. A real task submitted from Mona
wrote a file, ran a test, streamed the engine's own events, and displayed the
result with real cost and observed permission.

### P08 — live work studio (complete)

- **`WorkStudio`** (`src/main/work/studio.ts`) owns one authenticated loopback
  session per launch. It starts the runtime only on explicit user action,
  verifies the supervisor reports the project's canonical workspace, refuses an
  external runtime, and refuses a second project while the first is live
  (`STUDIO_BUSY`). One mutating turn per workspace is enforced before any write
  (`TURN_ACTIVE`).
- **Profile** (`src/main/work/profile.ts`) — the saved DS Full Access profile is
  written once from the P01 measured route (`deepseek` / `deepseek-flash`) and
  shown as *Configured* until a real turn reports it as *Observed*. Plan binds an
  `ask` posture with no auto-approve/trust/shell; Work uses the saved profile.
- **Submission safety** — intent is persisted through `SqliteSubmissionStore`
  before the POST; a lost response performs exactly one read-only operation
  lookup and never resends. `outcome_unknown` is a first-class UI state with a
  Reconcile control.
- **Events** — inserted with `INSERT OR IGNORE` on `(thread_id, seq)`, cursor
  advanced in the same transaction. `readProjectEvents` reads a project's whole
  timeline so the live thread sits beside the shell thread. Replay is
  display-only: the 2nd full replay pass ingested 0 events with 61 duplicates.
- **Controls** — Pause after task, Resume queue, Interrupt now (receipt +
  terminal-state poll), Cancel queued, Stop engine, and quit-and-stop work are
  distinct transitions with honest notes; nothing claims rollback.
- **Studio UI** — real timeline (delta merging, dedupe, tool/status/error cards,
  unknown kinds surfaced, plumbing counted not hidden), safe Markdown with no
  HTML surface and inert links, large output expanded on demand, auto-follow,
  Plan/Work control, drafts, cost, and a persistent control strip. Seven
  connection states each have their own copy.
- **Verification** — 236 tests in 29 files, local CI green, real pinned-engine
  Electron smoke **22/22** checks with three live screenshots. Evidence:
  `docs/evidence/macos/P08-studio.md`, `ADR-005-live-studio.md`,
  `artifacts/p08-*`.

## Next exact action (P09)

Read spec §5 (J1), §14.1–14.2, §19.2, §21 (MAC-002); the P07 `ProjectService`
open/relocate path; `DesktopLifecycle.handleSecondInstance` and `openWindow`;
`src/main/navigation.ts`; `native/macos-services/`; this handoff. Then deliver
Finder selected-folder launch:

1. Build the signed native macOS Service that receives a folder URL, validates
   it, and signals the running Mona instance; it must not run the model or read
   repository instructions.
2. Implement single-instance dispatch: a second launch hands its folder to the
   existing owner instead of starting a second owner; dock/folder drop and
   `File → Open Project…` share the same validated path.
3. Make registration idempotent (no duplicate catalog records, no alias
   duplicates) and open the project without starting a runtime or authorizing a
   task.
4. Validate file URLs (scheme, existence, directory) and reject anything else
   with a concrete reason; never accept an empty Finder-background invocation.
5. Tests and evidence: Service plumbing, URL validation, single-instance
   handoff, idempotent registration; `docs/evidence/macos/P09-finder.md`.

The authorized scope was P08 only; P09 is next but waits for the next
instruction.

## Nonblocking issues carried forward

1. **Single-owner runtime** — enforced; parallel ownership needs a tested engine
   decision.
2. **Direct cost unknown** — `costComplete: false` whenever the engine omits a
   price; the studio shows "at least", never zero.
3. **Adapter gaps** — approvals, clarifications, steer, artifacts, workspace
   search/restore, terminal, fleet are not adapter operations yet.
4. **Attachments** — disabled in the composer with a stated reason.
5. **Prompt queueing** — P10/P11; `Cancel queued` is honest with an empty queue.
6. **Crash-time turn reconciliation** — a turn left non-terminal by a crash stays
   non-terminal; P19/P20 own resume policy.
7. **Electron embedded Node is 24.22.2**, not the host 26.13.0.
8. **No Developer ID signing** — P22 prerequisite; local/ad-hoc only.
9. **Supervisor packaging** — compiled binary gitignored; P21/P22 ship and sign.
10. **Physical sleep not performed** — manual lid-close test remains.
11. **Route editing** — P16; Settings and the studio only display real facts.
12. **Restore UI** — P19; recovery panel describes the mechanism.
13. **Human aesthetic and VoiceOver QA** — P24/P26.
14. **Second macOS account not exercised** — P24; path/mode/no-token verified.
15. **Network filesystem check** — `/usr/bin/stat -f %T`; skipped if unavailable.
16. **Artifact bytes are not portable** — import reports missing digests.
17. **Native menu folder picker** — automation seeds the project; the dialog seam
    is covered by service tests.
18. **Shell smoke screenshots** — `npm run smoke:shell` regenerates
    `p07-shell-*.png`; they were restored to the committed P07 images after the
    P08 layout changed. A prompt-scoped prefix would keep history clean.

## Key files

- `.mona/build-macos/state.json` — prompt status (revision from last checkpoint).
- `.mona/build-macos/attempts.jsonl` — empty; nothing failed three times.
- `.mona/build-macos/DECISIONS.md` — D-001…D-018.
- `.mona/build-macos/BLOCKERS.md` — external prerequisites only.
- `docs/requirements-macos.json` — generated traceability.
- `docs/decisions/ADR-001…005`.
- `docs/evidence/macos/P00…P08-*.md` and `artifacts/p0*-*`.
- `src/main/work/` — `control.ts`, `studio.ts`, `profile.ts`.
- `src/main/engine/`, `src/main/supervisor/` (`runtime-supervisor.ts`,
  `driver.ts`, `native.ts`), `src/main/state/`, `src/main/projects/service.ts`,
  `src/main/ipc.ts`, `src/main/ipc-contract.ts`, `src/preload/index.ts`.
- `src/renderer/shell/` — Shell, Studio, `timeline.ts`, `markdown.tsx`, Board,
  Cost, Settings, visual helpers.
- `scripts/studio-smoke.mjs`, `scripts/shell-smoke.mjs`, `scripts/ci.mjs`,
  `scripts/engine-smoke.mjs`, `scripts/lifecycle-smoke.mjs`.
- `native/macos-supervisor/`, `native/macos-services/`.
- `AGENTS.md` — operating contract and commands.
