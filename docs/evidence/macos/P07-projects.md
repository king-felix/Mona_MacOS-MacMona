# P07 — Real project catalog and desktop shell

**Date:** 2026-11-11 · **Status:** complete · **Host:** macOS 26.5.1 arm64 ·
**Runtime:** Electron 45.3.0

## Result

Mona's fixture harness is replaced by a real shell backed by the transactional
project store and the supervisor's actual status. Home, Studio, Work board, Cost
lens, and Settings render live local state. Opening, importing, pinning,
renaming, archiving, relocating, revealing, and removing catalog entries all go
through validated IPC; removal never touches source files. Drafts, view state,
tasks, usage, and runtime bindings stay isolated per project.

Verification: **205 tests in 25 files pass**, including **10 project-service
tests** and **8 project-IPC contract tests**. The real Electron shell smoke
passes **29/29 checks** against a temporary project and database, with four
rendered screenshots. No fixture label, fake percentage, or hard-coded engine
badge remains in the product path.

Evidence: `p07-tests.txt`, `p07-full-suite.txt`, `p07-shell-smoke.json`,
`p07-shell-home.png`, `p07-shell-studio.png`, `p07-shell-board.png`,
`p07-shell-settings.png`.

## Architecture

- **`src/main/projects/service.ts`** — `ProjectService` over `StateStore`:
  catalog list/search, open/import, detail, rename, pin, archive, remove,
  relocate, reveal, view state, drafts, real engine snapshot, Git branch, usage
  summary, and stored events. It never starts a runtime and never spends
  inference.
- **Project identity** — canonical path + `(dev, ino)` deduplicates aliases;
  nested repositories and linked worktrees remain distinct; relocation is a
  deliberate rebind that keeps the project id and path history.
- **One shell thread** — `ensureThread` creates at most one local projection
  (`thr_<sha256(projectId)>`), so opening the same project repeatedly cannot
  duplicate threads. It never resumes a turn.
- **Engine state** — `engineSnapshot` combines supervisor status and the
  project's binding. `canExecute` is true only when a running runtime serves this
  project's canonical workspace. A runtime serving another workspace, a starting
  or reconnecting runtime, a failed runtime, and a missing binding each produce a
  specific blocked reason. Model and permission are reported as “not reported”
  and “unknown” until a real turn reports them; no badge is invented.
- **IPC** — new strict channels for catalog operations, reveal, view state,
  drafts, runtime status, and state facts. Payloads are validated; project ids
  must carry the `prj_` prefix; revisions are required for mutations. Expected
  failures cross the boundary as `{ ok: false, error: { code, message, details } }`.
  No channel deletes files; removal is catalog-only.
- **Bridge** — 17 named methods, no raw `ipcRenderer`, no Node, no filesystem
  API. `onProjectsChanged` is a main-controlled event used by the native File →
  Open Project… dialog.
- **Menu** — File → Open Project… (`⌘O`) opens the real folder dialog and sends
  the new project id to the renderer, which selects it in Studio.

## Shell behavior

- **Home** — pinned/recent catalog, local name/path search, archived toggle,
  project action menu (open, reveal, rename, pin, relocate, archive, remove),
  empty state. Opening an empty folder creates a project without scanning the
  drive.
- **Studio** — real context bar (branch, engine, model, permission, spend),
  stored event timeline, draft composer saved per project/thread, inspector tabs
  for task, requirement evidence, and context. Execution is disabled with the
  exact reason; live submission belongs to P08.
- **Work board** — real tasks in Running/Unstarted/Needs attention/Verified
  lanes, dependency titles, revisions. No percentage is inferred.
- **Cost lens** — real usage summary and per-model rows; incomplete pricing is
  labeled “at least” and unpriced rows say Unknown. No budget is invented.
- **Settings** — theme/density, database paths and modes, integrity, runtime
  status, selected binding, tool discovery, privacy boundaries, and recovery
  facts. Route editing and restore UI are explicitly deferred to P16/P19.
- **Command palette** — `⌘K`, local ranking over screens, projects, open folder,
  and reveal; focus is trapped and Escape returns focus.
- **Keyboard** — `⌘1`–`⌘5` switch every major screen, `⌘O` opens a folder, and
  all primary controls are native buttons in DOM order. The shell smoke proves
  Studio, Board, Cost, and Settings are reachable without a mouse.

## Acceptance evidence

| Requirement | Evidence |
|---|---|
| Catalog survives restart | Service test closes the store, reopens the same DB, and lists the same project id. |
| Relocation rebinds deliberately | Service test renames the folder, chooses it through the dialog seam, and verifies the same id at the new path plus one catalog entry. |
| Archived projects restore | Service test archives (hidden from the default list), restores, then removes and revives the same id. |
| Dirty and non-Git folders open | Service test opens a folder with a file and no `.git`; branch is null; a real initialized Git repository reports `main`. |
| Path aliases deduplicate | Service test opens the folder, a trailing-slash alias, and a symlink; all return one id and one catalog row. |
| Switching during simulated work is isolated | Service test gives two projects separate threads, drafts, tasks, usage, bindings, and engine snapshots; details never cross. |
| Offline history works | Service test stores an event, reopens detail, and reads it without a runtime; repeated detail calls keep one thread. |
| Reopening does not resume work | Service test leaves a task `running`, reopens the project, and verifies the same thread, status, and zero new events. |
| No fake percentage or engine badge | Shell smoke scans the product text for `%` (none) and observes `Disconnected` from the real supervisor status. |
| Every major screen without a mouse | Shell smoke uses `⌘2`, `⌘3`, `⌘4`, `⌘5`, `⌘1` and verifies each screen, plus the palette. |
| No horizontal overflow | Shell smoke reports false for all five screens at 1280×800. |

Shell smoke facts:

```text
home:     1 real project card, fixture label absent, version "Mona 0.1.0-p02"
studio:   "Shell smoke project", Disconnected, draft preserved, stored event, Send disabled
board:    4 lanes, task "Make the catalog real" visible
cost:     empty usage state ("No usage recorded for this project")
settings: database path visible, runtime panel visible
palette:  open, focus inside, project action present, Escape closes
```

## Limitations / nonblocking issues

1. **Live execution is P08.** The Studio composer saves drafts but cannot submit;
   Pause/Interrupt controls are disabled with an explicit title. The engine badge
   and blocked reason are real.
2. **Task creation is P10.** The board displays stored tasks; there is no task
   composer yet.
3. **Route editing is P16.** Settings shows the actual engine/binding but does
   not modify provider, model, or reasoning.
4. **Restore UI is P19.** The recovery panel states the transactional mechanism
   and snapshot location without a restore button.
5. **Model/permission “unknown” is intentional.** Without a live turn, Mona has
   no verified effective route to report. It does not display a remembered or
   hard-coded value.
6. **Human aesthetic and VoiceOver QA remain P24/P26.**
7. **Second macOS account not exercised**; P05/P24 own multi-user isolation.
8. **Native menu Open Project uses the real dialog**, verified by code and the
   renderer event path; the shell smoke seeds a project directly to avoid a
   modal dialog in automation. The folder picker path itself is exercised by
   service tests through the dialog seam.

## Commands run

```sh
npx vitest run                      # 205 tests / 25 files
npm run build && npm run smoke      # 21/21 checks
node scripts/shell-smoke.mjs        # 29/29 checks, 4 screenshots
npm run lint                        # 0 errors
```
