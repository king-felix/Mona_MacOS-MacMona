# R00 — Adopt the review, reconcile the baseline, apply verified hotfixes

**Date:** 2026-11-14 · **Platform:** darwin-arm64, macOS 26.5.1 (25F80) ·
**Node:** v26.13.0 · **npm:** 11.20.0 · **Electron:** 45.3.0 (project pin)
**Review document:** `MacMona_Studio_Review_PROMPTS.md`
sha256 `7e1e16d1646193c540d3886f9d4cb8c511376eb6f57768861f6fe859566bfca0`
**Companion patch:** `MacMona_Review_Hotfix.patch`
sha256 `a253a05e5205438b01492d8ff7840291189605d8aee99f4f7516c4b4182aa4fb`
(matches the hash declared in the review document)

## 1. Baseline reconciliation

- **Repository HEAD at adoption:** `656b12a69e01e32242edcf234ea0a2478a3c20e9`
  (“Ledger: record the public repo's security posture as measured, not
  assumed”).
- **Reviewed remote baseline:** `10d8375e9644c0563178a9d4b645d1a0ef8c999a`
  (“Studio: stop calling plumbing and known frames ‘unrecognized’”). Under the
  D-101 history rewrite that content is local commit
  `4d893fc663addd790a20b4c997c9f52104c3755f` (mapping already recorded in
  `DECISIONS.md`).
- **Dirty files at adoption:** the two supplied files, untracked and otherwise
  clean — `MacMona_Review_Hotfix.patch`,
  `MacMona_Studio_Review_PROMPTS.md`.
- **Original ledger before any edit:** `monabuild validate` → `ok: true`,
  revision **764**, 28 tasks, 38 requirements, attempts empty, index clean.
  `monabuild status` → P23 completed, 23 of 28, next eligible P22 and P25.
- **What changed between the reviewed baseline and HEAD** (`git diff
  4d893fc..HEAD`): 21 files, none of them part of the hotfix. They are
  (a) the format-only cleanup of `src/main/engine/adapter.ts`, `src/main/ipc.ts`,
  `src/renderer/shell/Settings.tsx`, `test/runtime-process.test.ts` at
  `4411ef1`; (b) shortened secret-scan fixtures in
  `scripts/terminal-smoke.mjs` and `test/settings-workbench.test.ts`; (c) the
  ledger, decision and captured-run artifacts. **The six hotfix files were
  byte-identical to the reviewed baseline**, which is why the patch applied
  without adaptation.

Verification:

```text
$ git apply --check MacMona_Review_Hotfix.patch   → exit 0
$ git apply --check -R MacMona_Review_Hotfix.patch → exit 1 (fixes not present)
$ git apply --stat MacMona_Review_Hotfix.patch
 src/main/state/store.ts        |  9 +++++++
 src/renderer/shell/Studio.tsx  | 18 +++++++++++++-
 src/renderer/shell/timeline.ts | 34 +++++++++++++++++++++++++-
 test/state-portable.test.ts    | 41 ++++++++++++++++++++++++++++++++
 test/studio-render.test.tsx    | 20 ++++++++++++++++
 test/studio-screen.test.tsx    | 51 +++++++++++++++++++++++++++++++++++++++-
```

## 2. Hotfix application and adaptation list

The patch was applied unmodified with `git apply`. **No fix was adapted,
dropped, or re-applied over newer work** — there was no newer work in these
files to preserve. Each reviewer finding was re-checked against the current
source before application:

- **RV-03 (replacement retains journal rows/cursors).** `deleteProjectContents`
  deleted `event_gaps` but not `events` or `event_cursors`, and both tables
  deliberately have no thread foreign key. The fix deletes both before the
  threads, inside the existing transaction. Verified by
  `test/state-portable.test.ts` → “replacement clears old events, cursors and
  gaps without touching another project”.
- **RV-04 (timeline merges threads).** `projectTimeline` accumulated one
  `openDelta` across the whole event list, matching only the item kind. The fix
  groups frames by `threadId`, projects each thread independently, namespaces
  each entry key with its thread, and merges for display. Verified by the
  interleaved-thread test in `test/studio-render.test.tsx`.
- **RV-05 (heartbeat splits a message).** Every plumbing frame except
  `item.started` flushed the open delta, so `ALPHA` + heartbeat + `BETA` +
  completed `ALPHABETA` produced two cards. Plumbing no longer ends a message;
  it is still counted in `internalActivity`. Verified by the heartbeat test.
- **RV-07 / UX-COMPOSER (Enter vs Command-Enter).** The composer had only
  `onChange`, and Send accepted whitespace until the backend refused. The fix
  adds a scoped `onKeyDown` — plain Enter, Shift/Alt/Ctrl combinations and IME
  composition are untouched; Command-Enter alone prevents default and submits,
  never on `event.repeat`, and only when the shared `sendBlocked` gate allows.
  `sendBlocked` now includes an empty-after-trim draft, so the shortcut and the
  Send button use one gate. Verified by two `test/studio-screen.test.tsx` cases.

Deliberately **not** claimed by R00: the reviewed patch does not make drafts or
navigation lossless (RV-01/RV-02 → R01), does not paginate history (RV-06 →
R02), and does not add slash-command dispatch (R03/R04). Those remain `open` in
the review registry.

### 2a. Pre-fix observation

The regression tests ship with the fix, so they were also run with the three
source fixes removed (kept in a stash) and the tests in place. Exactly the five
expected tests failed, each with the defect's signature:

```text
× replacement clears old events, cursors and gaps …
    expected [ { threadId: 'thr_abcdefgh', …(6) } ] to deeply equal []
× keeps interleaved threads separate, even when sequence numbers match
    expected [ 'ALPHABETA' ] to deeply equal [ 'ALPHA', 'BETA' ]
× does not split streamed text at heartbeat or other plumbing frames
    expected [ 'ALPHA', 'ALPHABETA' ] to deeply equal [ 'ALPHABETA' ]
× submits with Command-Enter only, leaving plain Enter and IME alone
× uses the same disabled gate for shortcut and send button
→ 5 failed | 24 passed
```

Every other test in the three files passed unchanged. The fixes were restored
with `git stash pop` before the post-patch run above. Artifact:
`artifacts/r00-prefix-failures.txt`.

## 3. Formatting cleanup kept separate from behavior (RV-11)

The review found `format:check` red on four untouched files. That was already
closed before R00 by `4411ef1` (“Build: format the four files that kept CI red,
and refresh the run records”) — a formatting-only change, no logic. R00 did not
mix formatting into the behavioral patch. The only formatting-relevant change
made here is configuration: `MacMona_Studio_Review_PROMPTS.md` joins the other
owner-supplied law documents in `.prettierignore` so CI does not reformat the
review text. Gate result: `prettier --check .` → **all files clean**.

Secret scan: `monabuild secrets` scans 548 tracked files with **0 findings**;
the two key-shaped fixtures the review flagged were shortened at `5b15c66`
before R00. R12 still owns confirming that provenance repository-wide.

## 4. Native source-hash evidence invalidated by the patch

`src/main/state/store.ts` is recorded evidence for **P10** and **P19**
(sha256 `89944463f5ac097ece0ad55fd7f3a66e8e279a3157585c72777828acae2d3d49`,
re-recorded at P15). The hotfix changes that file, so the old hash no longer
describes the bytes. Following the review’s instruction, this was **not**
“repaired” by silently replacing hashes and pointing at the old reports:

- The invalidation is recorded here and in the review registry (`R00`
  `source_hashes`, with the reviewed-baseline hash in each note).
- The P10 and P19 ledger entries were refreshed only **after** re-running their
  assertions against the new bytes (full suite below), and their notes now say
  what changed and why.
- P10’s and P19’s human evidence documents were **not** rewritten; they still
  describe the pre-review bytes and their original commit association.

Shell-smoke captures: the run below rewrote 19 hash-pinned PNGs (Studio hint
text, clock/receipt text). Their hashes were re-recorded per task (P07, P11,
P12, P13, P14, P15, P18, P19) with a note naming this run — the established
precedent (ledger items 33/51/63/83/95/112). No assertion was removed and no
requirement status was lowered.

## 5. Actual Mac baseline checks

| Gate | Before the patch | After the patch |
|---|---|---|
| `npx vitest run` on the three focused files | 24 passed | **29 passed** (5 new regression tests) |
| `npm test` (full) | 791 passed / 79 files | **796 passed / 79 files** |
| `npm run typecheck` | clean | clean |
| `npm run lint` | 0 errors, 3 pre-existing `no-explicit-any` warnings | unchanged |
| `npm run format:check` | red only on the supplied review document | **clean** |
| `npm run smoke:shell` (real Electron) | — | **127/127 checks, exit 0** |

`smoke:shell` also confirms the composer renders with the new hint, the draft
survives, `send_enabled` is truthful for a non-empty draft, and the Studio
layout facts (352 px console, 350 px inspector beside 632 px composer) are
unchanged.

## 6. What R00 did not verify

- **No live engine turn and no provider request.** The acceptance is
  source-level and fixture-level; the route and cost controls were untouched.
- **No installed-app run.** The packaged candidate is R13’s.
- **Native fullscreen, VoiceOver, 200% scale** — R05/R11.
- Shell smoke captures come from the fixture-fed shell, not a user session.

## 7. Registry and checkpoint

The subordinate review ledger lives in
`.mona/build-macos/reviews/studio-v2/state.json`, written only through
`monabuild review` (schema validation, revision checks, atomic replacement,
single-writer lock, evidence hashing). It tracks R00–R15, RV-01…RV-13 and the
five UX feature IDs, and reads attempts from the shared
`.mona/build-macos/attempts.jsonl` — a review task never resets a count.
The original P00–P27 ledger remains authoritative for product requirements and
was checkpointed separately.
