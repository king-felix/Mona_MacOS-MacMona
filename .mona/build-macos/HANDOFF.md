# Handoff — Mona macOS build

**Last checkpoint:** 2026-11-11 (P12) · revision 130 · next commit is the P12
verification commit
**Current prompt:** P12 completed. Next eligible: **P13** — not started, not
authorized in this session.

## Where the build stands

P00–P12 are complete: qualified headless integration, a secure shell, a
contract-tested engine adapter, a native process supervisor, transactional
per-user state, a measured design system, a real multi-project catalog and
desktop shell, a live work studio, Finder integration, a prompt work board and
durable continuation, an enforced attempt ledger, and now a **durable cost
ledger with optional budget controls**.

### P12 — Cost ledger and optional budgets (complete)

- **`docs/decisions/ADR-007`** — usage semantics and rate provenance. The
  engine's `/v1/usage` thread total is the only price signal; a turn record's
  `input_tokens` is inclusive of cache hits while a usage bucket's is exclusive.
  Five cost states: `reported`, `estimated`, `unknown_price`, `missing_usage`,
  `unallocated`. Mona ships **no** price table.
- **`src/main/state/schema.ts` migration v5** — `rate_cards` (revisioned,
  route-scoped), `budgets` (session/project/day with an IANA zone),
  `cost_thread_marks` (one cumulative mark per thread), new
  `usage_records` columns (`task_id`, `cache_miss_tokens`, `cost_pico_usd`,
  `cost_state`, `cost_allocation`, `rate_card_id`, `pricing_read_at`,
  `token_semantics`, `note`), a `usage_turn_once` unique index on
  `(thread_id, turn_id)`, and a de-duplicating cleanup of pre-P12 rows.
- **`src/main/work/cost-math.ts`** — integer pico-USD, exact rate conversion,
  inclusive/exclusive bucket estimation, civil-day windows that survive a 23-hour
  DST day.
- **`src/main/work/costs.ts`** — `CostLedger`: dedupe-on-insert, thread-delta
  allocation, conservative route state, rollups by model/task/session/civil day,
  budget evaluation, dispatch gate, read-only recalculation preview, JSON/CSV
  export.
- **Studio + IPC** — `studio.submit` and the board dispatch preflight both
  consult the gate, so a refused dispatch starts no task run and sends no
  request. Six narrow channels: `cost:ledger`, `cost:export-file`,
  `cost:budget-set`, `cost:budget-clear`, `cost:rate-set`,
  `cost:recalc-preview`.
- **UI** — the real Cost lens: known spend with a lower-bound qualifier, the
  incomplete-spend callout, budgets with a visible warn/stop level, price
  evidence per route, rate-card entry, per-group rollups, recent turns, and
  export. A sub-cent total is never rounded to `$0.00`.
- **Verification** — 337 tests in 37 files; the sample ledger run **20/20**;
  Electron shell **49/49** with a seeded reported and unpriced turn; local CI
  green including the new `smoke:cost`. Evidence:
  `docs/evidence/macos/P12-costs.md`.

## Next exact action (P13)

Read spec §5.5, §7 (014/015), §10, §11 source review, the P13 prompt body, O1/O2,
and this handoff. Then make changes, evidence, Git, and restore trustworthy:

1. File change lists with lazy text/diff views, binary/oversized indicators, tool
   output artifacts, and source links tied to real receipts.
2. Distinguish attributable tool changes from workspace-wide deltas and
   pre-existing user edits; never infer sole agent authorship from timing.
3. Git status, branch/worktree display, selected-file staging/commit, and honest
   non-Git behavior. Do not touch unrelated staged work and do not reset/clean.
4. Verified native undo/restore with exact scope, exclusions, conflicts, and
   recovery information; represent unavailable snapshots and unsupported
   binary/external effects instead of building a second snapshot engine.

## Nonblocking issues carried forward

1. **No per-turn engine price** — attribution uses the cumulative thread total;
   an unsplittable total becomes an `unallocated` residual counted once.
2. **No shipped rate table** — until a card is recorded, unpriced routes stay
   unknown and no local estimate is produced (ADR-007).
3. **Quota-billed providers stay unknown** even with a card, because cards are
   USD-only.
4. **A local budget is not an invoice cap** — an in-flight provider request may
   complete after a stop; the UI says so.
5. **No balance** — never derived from local usage.
6. **Concurrent reservation currency is unproven** — Mona serializes mutating
   work, so the gate counts in-flight slots; a concurrent executor must re-run
   the gate per slot (P15/P21).
7. **Tool/API charges are not split out** — the engine reports one total.
8. **Recalculation is preview-only** — applying it to stored rows needs an
   explicit future decision.
9. **Engine-internal loops are cooperative** (ADR-006).
10. **Turn completion is not auto-projected** — P14 owns moving a finished turn
    into verification.
11. **Native workflows are not gated by pause-after-task** — P15.
12. **The attempt ledger is not in the portable bundle** — P19 may extend it.
13. **Confirmed live interrupt remains P08 evidence**; interactive QA is P24/P26.
14. **No automatic runtime start from a Finder handoff** — deliberate (D-019).
15. **Service install scope** — `~/Library/Services` for development; the
    packaged installer must use `/Library/Services` (D-020, P21).
16. **LaunchServices ignores `/tmp` bundles** (D-021); P21/P24 verify the pair.
17. **Interactive multi-selection alert and VoiceOver** — P24/P26.
18. **No Developer ID signing** — P22 prerequisite; ad-hoc locally.
19. **Single-owner runtime** is enforced; parallel ownership needs an engine
    decision.
20. **Adapter gaps** — approvals, clarifications, steer, artifacts, workspace
    search/restore, terminal, fleet are not adapter operations yet.
21. **Attachments** are disabled in the composer with a stated reason.
22. **Fingerprint is bounded and local** (20,000 files / 64 MB).
23. **Plan export does not carry task status** — P19.
24. **Electron embedded Node is 24.22.2**, not the host 26.13.0.
25. **Supervisor and Service binaries are gitignored** — P21/P22 ship them.
26. **Physical sleep and a second macOS account** — manual QA (P24).
27. **Artifact bytes are not portable** — import reports missing digests.
28. **Evidence generation redacts the build machine's home directory.**
29. **P07/P11 shell screenshots are hash-pinned evidence.** The P12 shell smoke
    rewrote them; they were restored to their committed bytes, so P07 and P11
    stay valid. `p12-shell-cost*.png` keep the P12 captures.

## Key files

- `.mona/build-macos/state.json` — prompt status (revision 130).
- `.mona/build-macos/attempts.jsonl` — empty; nothing failed three times.
- `.mona/build-macos/DECISIONS.md` — D-001…D-028.
- `.mona/build-macos/BLOCKERS.md` — external prerequisites only.
- `docs/requirements-macos.json` — MONA-003/013 satisfied with P12 evidence.
- `docs/decisions/ADR-001…007`; ADR-007 is the usage/rate semantics.
- `src/main/work/` — `board.ts`, `control.ts`, `costs.ts`, `cost-math.ts`,
  `fingerprint.ts`, `studio.ts`, `profile.ts`.
- `src/renderer/shell/` — Shell, Board, Studio, Home, Cost, Settings, drop,
  FinderIntegration.
- `scripts/` — `board-smoke.mjs`, `cost-smoke.mjs`, `ci.mjs`, `smoke.mjs`,
  `shell-smoke.mjs`, `studio-smoke.mjs`, `engine-smoke.mjs`,
  `lifecycle-smoke.mjs`, `open-smoke.mjs`, `service-smoke.mjs`, build scripts.
- `AGENTS.md` — operating contract and commands (rule 3 is the stable
  three-attempt instruction).
