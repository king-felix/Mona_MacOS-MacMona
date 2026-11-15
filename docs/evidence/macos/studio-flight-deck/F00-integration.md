# F00 — integration of the supplied Studio flight-deck implementation

Captured 2026-11-15 on the owner's Mac. This record covers only the integration
step; source qualification is F01 and native visual/install gates remain pending
until their own evidence exists.

## Host and checkout before integration

- OS: macOS 26.5.1 (build 25F80), Darwin 25.5.0, arm64 (`RELEASE_ARM64_T8122`).
- Toolchain: Node v26.13.0, npm 11.20.0, Electron 45.3.0, dependencies installed
  from the pinned lock (`npm ls --depth=0` resolved; no `npm ci` needed).
- Branch before: `main` at `c334cbbeb136f545606c1a850ecc89605e48f8bd`.
- Working tree before: clean except the untracked owner kit
  (`Mona_Studio_Future_Kit/`, `Mona_Studio_Future_Kit.zip`).
- Kit baseline: `344d41c3f154d6461bb82d873d6d3541faaa09b9`, an ancestor of HEAD
  (HEAD carries two later local commits: the D-113 dispatch guard and the
  model-route repair).
- Patch integrity: `shasum -a 256` = `4a758f1ecd61588cfa6b31ccf6aceddd9499b9bf60e346039266395f3ac0a5a3`,
  identical to `SHA256SUMS.txt` and START_HERE.

## Local work preserved

The two post-baseline commits touch `src/main/engine/types.ts`,
`src/main/work/settings.ts`, `src/main/work/studio.ts`, their tests, and the
historical ledger. The kit's source paths do not overlap any of them; its ledger
additions are prepends above the historical record, so nothing local was
replaced. No reset, checkout, stash, or history rewrite was used.

## Integration

- Branch created from HEAD: `studio-flight-deck`.
- `git apply --check Mona_Studio_Future_Kit/Mona_Studio_Flight_Deck.patch` → exit 0.
- `git apply Mona_Studio_Future_Kit/Mona_Studio_Flight_Deck.patch` → exit 0, once.
- Result: 39 files changed, 3319 insertions(+), 1057 deletions(-).
- The extracted kit stays a reference subfolder and is now listed in
  `.gitignore`; it is not committed.

Changed paths recorded by the diff:

```
.mona/build-macos/BLOCKERS.md            .mona/build-macos/HANDOFF.md
.mona/build-macos/attempts.jsonl         .mona/build-macos/flight-deck.json (new)
Mona_Studio_Flight_Deck_PROMPTS.md (new)
docs/changelog-macos.md                  docs/design-system.md
docs/owner-guide-macos.md                docs/evidence/macos/studio-flight-deck/* (new)
scripts/studio-deck-smoke.mjs (new)
src/main/index.ts
src/renderer/shell/AgentSignal.tsx (new) src/renderer/shell/Shell.tsx
src/renderer/shell/Studio.tsx            src/renderer/shell/TransientNotice.tsx (new)
src/renderer/shell/agent-signal.ts (new) src/renderer/styles.css
test/agent-signal-clock.test.tsx (new)   test/agent-signal.test.ts (new)
test/fixtures/studio-deck.html (new)     test/fixtures/studio-deck.tsx (new)
test/helpers/studio-fixtures.ts (new)    test/polish-screen.test.tsx
test/shell-races.test.tsx                test/studio-deck-accessibility.test.tsx (new)
test/studio-focus.test.tsx               test/studio-screen.test.tsx
test/transient-notice.test.tsx (new)
```

## Declared-requirement review of the changed source

Read the new modules and the changed call sites before committing:

- `agent-signal.ts` derives phases only from events matching both the current
  `threadId` and `activeTurnId`; completion/failure/interruption clears open
  items; a turn with no open item reports waiting, never progress. Silence past
  45 s is computed on a local clock, so it updates without a new snapshot. No
  engine or provider call is added.
- `AgentSignal.tsx` stops its 1 s clock when hidden or when no turn/last event
  exists, and keeps the age line out of the live region.
- `TransientNotice.tsx` keeps tone and text in one receipt (Shell now stores them
  together), restarts the 5 s timer for a replacement (`key` on notice id), pauses
  on hover/focus/hidden, and never auto-dismisses attention tones.
- `Studio.tsx` removes the inspector, replaces Send to engine with Submit plus
  Pause/Resume and Interrupt now above the prompt, and bounds the transcript to
  the viewport. `src/main/index.ts` smoke selectors were migrated to the new
  surfaces (`agent-signal`, `focus-model`, `focus-cost`, `.composer__command-bar`)
  rather than dropped.

## Checks run at integration time

- `node tools/monabuild/cli.mjs secrets` → `ok: true`, 781 files scanned, 0 findings.
- `npm run typecheck` → exit 0.
- `npm run lint` → exit 0, 0 errors, 3 pre-existing `no-explicit-any` warnings.
- `npm run format:check` → initially flagged `test/fixtures/studio-deck.html`;
  formatted that fixture with Prettier and re-ran to exit 0.
- `npm run build` → exit 0.
- Focused tests (`agent-signal`, `agent-signal-clock`, `transient-notice`,
  `studio-screen`, `studio-focus`, `studio-deck-accessibility`,
  `polish-screen`, `shell-races`, `studio-activity`) → 120 passed in 9 files.
  Full transcripts: `mac-typecheck.txt`, `mac-lint.txt`, `mac-format.txt`,
  `mac-build.txt`, `mac-focused-tests.txt` in this directory.

## State

F00 complete: the patch is integrated once on `studio-flight-deck`, local work is
intact, and `F01` is next. Nothing here claims native visual or installed-build
qualification.
