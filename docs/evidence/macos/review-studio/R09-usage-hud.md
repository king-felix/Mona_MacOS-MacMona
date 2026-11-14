# R09 — Slim usage HUD with trustworthy costs and tokens

**Reviewed against:** `MacMona_Studio_Review_PROMPTS.md` §R09.
**Requirements:** MONA-013 (usage/cost visibility), MONA-029 (partial).
**Feature:** UX-AGENT-COMMS.
**Platform:** darwin-arm64, Electron 45.

## What landed

### Three labelled scopes, one read

`StudioSnapshot.usage` (`src/shared/contracts/usage-hud.ts`) carries:

- **turn** — the active turn's receipts only;
- **thread** — the current conversation;
- **project** — every receipt for the project.

`StateStore.summarizeUsageScoped(projectId, { threadId?, turnId? })` narrows
the same aggregate query. The project scope deliberately includes the **residual**
(a cumulative thread total the ledger could not split per turn), so the HUD
cannot disagree with the Cost screen; narrower scopes never carry it, because
attributing a residual to one turn would invent an allocation the ledger refused
to make. A test asserts project-scope equality with `summarizeUsage()`.

### The states are the point

`projectUsageScope()` (`src/main/work/usage-hud.ts`, pure) produces one of five
states, and only one of them is `$0.00`-shaped — none of them:

- `waiting` — the turn is running and has reported no usage yet;
- `empty` — no receipt exists for this scope;
- `unpriced` — usage exists, no price is known for the route;
- `partial` — some turns are priced, others are not (the label says
  `at least $X` and the note names how many turns cannot be priced);
- `complete` — every turn is reported or estimated, and no residual remains.

### Cached input is never counted twice

`tokenSemantics` is read per scope from the stored rows:

- `inclusive_input` → displayed input is `input − cached`, with cached shown
  separately;
- `exclusive_input` → both counts stand alone;
- `mixed` or `unknown` → **no subtraction is invented**; the detail panel says
  the counts may overlap rather than guessing.

### No polling, no live estimate

The HUD is a projection of stored receipts computed during `snapshot()`. There
is no timer, no interval, and no provider call. Tokens appear when the engine
receipts them — the detail panel says exactly that. Elapsed time, last-event age
and the running/idle distinction stay in R08's activity strip, which derives
them from stored frames; a heartbeat never becomes "thinking".

### The strip is small; the facts are reachable

`src/renderer/shell/UsageHud.tsx` renders three chips plus a native `<details>`
disclosure. The disclosure carries: per-scope turn counts and notes, the token
semantics in words, the read provenance, the configured/observed model (with a
fallback flag), the permission posture, the connection state, and every enabled
budget with its level. Controls are native buttons and a `<summary>`, and the row
wraps, so an enlarged text size reflows rather than clipping.

## Verification

- `test/usage-hud.test.ts` — 13 passing: empty vs waiting; inclusive subtraction;
  exclusive counts; mixed semantics refuse subtraction; partial labels and
  lower-bound notes; unpriced distinct from zero; unknown semantics; a missing
  usage row is not a priced turn; scoped reads isolate a thread and a turn; the
  project scope agrees with the Cost screen and a thread scope excludes imported
  unassigned history; a replayed receipt for one turn is not double-counted;
  an idle turn is `empty`, not `waiting`.
- **Full suite:** 1,089 tests in 98 files.
- **Shell smoke:** 137/137 in the real Electron shell, including
  `usage_hud_present`, `usage_scopes_labelled` (three), `usage_detail_reachable`,
  and `usage_turn_is_empty_not_zero`. Capture:
  `docs/evidence/macos/artifacts/p-r09-usage.png`.
- Typecheck, lint (0 errors) and `format:check` clean.

## What is *not* verified

- **No live turn produced a receipt in this session.** The scopes, states and
  token arithmetic are proven against real SQLite rows and the fixture engine;
  a real provider receipt reaching the HUD is P26's live scenario.
- **Budget rendering** is exercised by the store's evaluation types and the
  detail panel, but no budget was set in the shell smoke, so the popover's
  budget line is covered by unit types rather than a rendered capture.
- The 24 hash-pinned captures were restored to their committed bytes after the
  smoke; R12 owns their reconciliation. `p-r09-usage.png` is this task's capture.

## Files

- `src/shared/contracts/usage-hud.ts` (new), `contracts/studio.ts`,
  `contracts/index.ts`
- `src/main/state/store.ts` (`summarizeUsageScoped`)
- `src/main/work/usage-hud.ts` (new), `src/main/work/studio.ts`
- `src/renderer/shell/UsageHud.tsx` (new), `Studio.tsx`, `styles.css`
- `test/usage-hud.test.ts` (new), four shell-smoke checks in `src/main/index.ts`
