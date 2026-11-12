# Decisions — Mona macOS build

Durable decisions with rationale. Newest first. Product decisions from the
specification are not repeated here; this file records implementation choices
and deviations discovered while building.

## D-008 — Local Git repository only, no remote

- **Date:** 2026-11-11 (P00)
- **Decision:** Initialize this directory as a local Git repository and make
  local checkpoint commits. No remote is configured.
- **Why:** Spec §17 requires a local checkpoint commit when Git is available;
  no authorized Mona remote exists on this machine, and inventing one is
  forbidden. Pushing remains a separate, explicitly authorized action.
- **Consequence:** History exists for reconciliation and rollback on this Mac.
  Remote coordination with the Windows build waits for a real repository.

## D-007 — Engine pinned to installed Codewhale 0.10.2

- **Date:** 2026-11-11 (P00)
- **Decision:** Treat `/opt/homebrew/lib/node_modules/codewhale` (npm wrapper)
  and its native ad-hoc-signed arm64 binary (SHA-256
  `da0229610647f1cc2dd14c4227b333a92ea276a49f5d4d79160fa19e515e590d`) as the
  pinned engine for compatibility work.
- **Why:** Compatibility must be established against the installed binary
  (spec §2.1). Silent upgrades would invalidate every qualification.
- **Consequence:** P01 qualifies this exact build. Any later change is a
  deliberate, re-tested compatibility decision recorded here, not an automatic
  update. Because the binary is only linker-signed, P21/P22 must re-sign it and
  record both digests.

## D-006 — No full Xcode: CLT-based native plan, flagged early

- **Date:** 2026-11-11 (P00)
- **Measured:** `xcode-select -p` is `/Library/Developer/CommandLineTools`;
  `xcodebuild` fails; CLT SDK 14.4, Swift 5.10, clang 15.0.0.
- **Decision:** Proceed with CLT (`swiftc`, `codesign`, `pkgbuild`,
  `productbuild`) for the P02/P09 native helpers, and surface a named build
  prerequisite if a later step genuinely requires a full Xcode installation or
  `.xcodeproj` target. Do not fake Xcode-only steps.
- **Why:** Full Xcode is a large install; the spec permits authorized installs
  but does not require one where CLT suffices. Recipient machines must never
  need developer tools at all.

## D-005 — Attempt counters live in an append-only ledger, enforced in code

- **Date:** 2026-11-11 (P00)
- **Decision:** `.mona/build-macos/attempts.jsonl` records every hypothesis →
  observed-result cycle. `monabuild attempt` refuses a fourth consecutive
  no-progress attempt; `monabuild reopen` requires a named human decision or new
  evidence. Counters are recomputed from disk on every read.
- **Why:** Spec §8.4 requires counters that survive sessions and cannot be reset
  by convenience. Enforcement in the tool is mechanism; prose alone is not.
- **Consequence:** Engine-internal loops remain only cooperatively observable;
  the ledger enforces Mona's own dispatch discipline and says so.

## D-004 — Requirements registry is generated, status is merged

- **Date:** 2026-11-11 (P00)
- **Decision:** `docs/requirements-macos.json` is generated deterministically
  from the two Markdown specifications (prompt map, requirement tables, prompt
  counts, dependency order). Regeneration preserves recorded requirement status
  and evidence; the generated structure itself is never hand-edited.
- **Why:** The spec demands that every referenced ID exists and the graph is
  acyclic (spec §3). Deriving it from the documents removes transcription drift;
  merging preserves traceability across regenerations. Skill/tool output is not
  trusted over the checked file: `monabuild validate` re-checks hashes.

## D-003 — `.mona/build-macos/state.json` is the single runtime authority

- **Date:** 2026-11-11 (P00)
- **Decision:** Prompt status, current prompt, evidence pointers, and blockers
  live in one validated JSON document with monotonic revisions. Writes are
  atomic, revision-checked, single-writer, and backed up.
- **Why:** Spec §8.3. A single authority makes conflict detection real instead
  of conventional.
- **Consequence:** `monabuild recover` restores the last committed revision from
  `state.json.bak` and preserves damaged copies as evidence.

## D-002 — Zero-dependency Node utility for the build ledger

- **Date:** 2026-11-11 (P00)
- **Decision:** Implement `tools/monabuild` with Node's standard library only
  (custom JSON-Schema subset, `node:fs` atomic writes, `node:test`).
- **Why:** P00 must not choose the product's schema library or test runner;
  P02 owns that. A dependency-free bootstrap avoids installing packages before
  the product stack is pinned and keeps the tool auditable.
- **Consequence:** The validator is intentionally narrow; unknown keywords are
  ignored. Product schemas at P02 use the chosen product library.

## D-001 — This directory is the Mac build root

- **Date:** 2026-11-11 (P00)
- **Decision:** Build in the current workspace directory (`<workspace>`) on a local APFS
  volume, as Victor directed, rather than creating `~/Developer/Mona-macOS`.
- **Why:** The user's current request names this working directory. No common
  Windows source tree exists here, so no shared worktree conflict arises.
- **Consequence:** The Mac ledger is `.mona/build-macos/`; the Windows
  `.mona/build/` ledger and Windows sources are untouched and absent here.
