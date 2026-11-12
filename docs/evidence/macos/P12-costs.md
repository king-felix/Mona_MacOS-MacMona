# P12 — Cost ledger and optional budget controls

**Date:** 2026-11-11 · **Engine:** Codewhale 0.10.2 (`ff466b2…`) · **Host:**
Mac15,12, macOS 26.5.1, native arm64 · **Schema:** v5
(`cost-ledger-rates-and-budgets`).

## Verdict

**PASS.** Cost is now a durable ledger with explicit provenance. Every observed
turn is recorded once with one of five labeled cost states; the engine's
cumulative thread total is converted into an exact per-turn delta; cache and
reasoning buckets are never double-counted; a user-set budget can warn or stop
the next dispatch and cannot pretend to be an invoice cap; and no screen or
export ever renders an unknown price as `$0.00`.

Evidence files:

- `artifacts/p12-cost-sample.json` — 20/20 ledger checks on a real database.
- `artifacts/p12-cost-sample.log` — the same run's readable check list.
- `artifacts/p12-tests.txt` — **337 tests in 37 files**.
- `artifacts/p12-shell-cost.json` — **49/49** real Electron shell checks.
- `artifacts/p12-shell-cost.png`, `artifacts/p12-shell-cost-detail.png` — the
  rendered lens, seeded with a reported turn and an unpriced turn.
- `artifacts/p12-schema.txt` — migration v5, the four cost tables, the columns
  and the `usage_turn_once` unique index.
- `artifacts/p12-ci.txt` — local CI green: format, lint, typecheck, supervisor
  and Service builds, tests, build, board smoke, **cost smoke**, renderer scan.

## What the engine actually provides (measured in P01, re-read at P12)

- `GET /v1/usage?group_by=thread` is the **only** route that carries a price. It
  returns cumulative `cost_usd`, `cost_complete`, `priced_turns` and
  `unpriced_turns` for a time range, and `cost_usd` is computed from the engine's
  model→pricing map. Turns whose model has no pricing entry contribute tokens
  and `0.0` cost — which is unknown, not free.
- A turn record (`TurnRecord.usage`) carries tokens only, and its
  `input_tokens` is **inclusive** of cache hits (P01: 53,377 = 39,680 hits +
  13,697 misses). A `/v1/usage` bucket's `input_tokens` is **exclusive**
  (P01: 12,659 with 40,448 cached).
- There is no per-turn price endpoint and no balance endpoint. Spec §9.3 forbids
  scraping a balance, so Mona states that balance is unavailable.

Consequence, recorded in ADR-007: a cumulative thread total is the only engine
price signal, so the ledger stores one mark per thread and records the
**non-negative delta** as the turn's reported cost. A total that moves backwards
(engine restart, window reset) or that arrives after unpriced turns produces an
`unallocated` turn instead of a negative or invented attribution.

## Design

### Five cost states, never a silent zero

| State | Meaning |
|---|---|
| `reported` | The engine returned a complete price for the turn, directly or as an exact thread delta. |
| `estimated` | A recorded rate card priced the reported tokens. Labeled as an estimate. |
| `unknown_price` | Tokens exist; no complete price and no applicable rate card. |
| `missing_usage` | The engine reported no usage for the turn. |
| `unallocated` | A thread total that cannot be attributed to one turn; counted once as a residual. |

`cost_complete` is true only when every observed turn is definite **and** no
residual remains. `cost_basis` reports `reported`, `estimated`, `mixed`, or
`none`.

### Exact integer money

Costs are stored as integer pico-USD (`1 USD = 1e12 pico`), so
`$0.28/M` converts to exactly `280,000` pico per token and fixture sums are exact
rather than "close enough". The specification's formula is implemented directly
as `hit × hit_rate + miss × miss_rate + output × output_rate`; reasoning is added
to output only when the rate card says the provider bills it separately.

### No shipped price table

The installed runtime exposes no pricing catalog, and copying a remembered rate
into code would be invention. `rate_cards` starts empty; a human records rates
with source and read time. Every estimate names the card it used, and a new
revision never rewrites an already-priced turn. `previewRecalculation` is
read-only and exists precisely so a rate change can be inspected without a
silent historical rewrite.

### Attribution

`task_id` is filled from the dispatch link when Mona started the prompt; an
untasked composer turn stays under “No task attributed” rather than being guessed
from timing or thread. Rollups exist per turn, task, session, model, and civil
day.

### Budgets and the dispatch gate

Budgets are optional, user-set, and scoped to `session`, `project`, or `day`. A
day window is the user's civil day (IANA zone, default the host zone), computed
with `Intl.DateTimeFormat` and verified across a 23-hour DST day.

The gate is evaluated **before** a task run starts (board preflight) and again in
`studio.submit`, so a refused dispatch is never recorded as an unknown outcome
and no request reaches the engine. A `stop` level blocks the next dispatch; a
`warn` level does not. An in-flight provider request can still complete, so the
UI says the limit is not an invoice cap. When any turn in scope is unpriced, the
known spend is labeled a lower bound and the gate still stops, because the bound
already crossed the limit.

Mona serializes mutating work (one running task, one owned runtime per
workspace), so there is at most one in-flight turn to account for and no dollar
“reservation” is invented. `cost_reservations` is therefore a count of in-flight
slots, and a future concurrent executor must re-run the same gate per slot —
recorded as a P15/P21 constraint, not assumed away.

## Verification

- **Arithmetic** — inclusive and exclusive fixtures match hand-computed
  expectations exactly; a conflicting bucket set refuses to estimate; reasoning is
  billed once.
- **Deduplication** — recording the same turn twice returns the stored row; a
  reconnect, replay, or restart adds no charge.
- **Thread deltas** — `$0.001` then `$0.0035` stores `$0.001` and `$0.0025`;
  a backwards total stores `unallocated` and keeps the total, never a negative
  delta.
- **Unknown** — no price and no rate card stays `unknown_price` with `costUsd:
  null`, `costBasis: "none"`, and no dollar subtotal in the UI.
- **Rates** — an estimate names its card; a second revision leaves the stored row
  and its pico value untouched; the recalculation preview writes nothing.
- **Civil days** — 2026-03-08 in `America/New_York` is 23 hours; an 03:30Z turn
  belongs to the previous day in Los Angeles.
- **Budgets** — warn then stop; an unpriced turn makes the check a lower bound;
  clearing restores dispatch; a day budget is scoped to the civil day.
- **Export** — JSON and CSV carry cost state, allocation, rate provenance and an
  explicitly null balance.
- **Zero inference** — ledger reads, budget edits, rate edits, recalculation
  previews, and export issue **zero** transport calls (fixture transport asserts
  an empty call list); `costs.ts` and `cost-math.ts` contain no adapter,
  transport, `fetch`, `readUsage`, or `submitTurn` reference; the cost screen
  calls no submit/start/interrupt path.
- **Real shell** — the Electron shell renders the seeded lens with known spend,
  the incomplete callout, an unknown-price turn, a budget row, no balance claim,
  and both export controls, without horizontal overflow.

## Honest limitations carried forward

1. **No per-turn engine price.** Attribution depends on a cumulative thread
   total. A total observed after earlier unpriced turns becomes an unallocated
   residual instead of being split; the residual is counted once and named.
2. **No shipped rates.** Until Victor records a card, every unpriced route stays
   unknown and Mona performs no local estimate. Providers that bill quota rather
   than dollars remain unknown even with a card, because the card is USD-only.
3. **A local limit is not an invoice cap.** An in-flight provider request can
   complete after a stop; the UI says so.
4. **No balance.** Not derived, not scraped, not displayed.
5. **No concurrent reservation currency.** Serialized work makes it unnecessary
   today; a qualified concurrent executor must extend the gate.
6. **Reasoning-token billing is a card property.** If a provider bills reasoning
   inside completion tokens, the card must say so; Mona cannot detect it per turn.
7. **Tool/API charges are not split out.** The engine's total is one number; a
   `tool_call_pico` field exists on the card but no provider breakdown is
   available to attribute it.
8. **Historical rewrite is preview-only.** Applying a recalculation to stored
   rows needs an explicit future decision; today a card change affects new turns.

## Files

- `src/main/state/schema.ts` — migration v5: cost columns, `rate_cards`,
  `budgets`, `cost_thread_marks`, `usage_turn_once` unique index, and a
  de-duplicating cleanup of pre-P12 rows.
- `src/main/state/store.ts` — ledger storage: dedupe-on-insert, cost upgrades,
  summaries with residual, marks, rate-card revisions, budgets.
- `src/main/work/cost-math.ts` — exact money, bucket estimation, civil days.
- `src/main/work/costs.ts` — ingestion, allocation, rollups, budgets, gate,
  recalculation preview, export.
- `src/main/work/studio.ts` — ingestion from a terminal turn and the dispatch
  gate in `submit`.
- `src/main/ipc.ts`, `src/main/ipc-contract.ts`, `src/preload/index.ts`,
  `src/shared/contracts/{bridge,cost}.ts` — six narrow call: read, export,
  export-file, budget set, budget clear, rate set, recalculation preview.
- `src/renderer/shell/Cost.tsx` — the real lens.
- `test/work-costs.test.ts`, `test/cost-screen.test.tsx`,
  `test/work-studio.test.ts`, `test/ipc-contract.test.ts`,
  `test/boundary.test.ts` — the added coverage.
- `scripts/cost-smoke.mjs`, `scripts/ci.mjs`, `package.json` — repeatable sample
  run wired into local CI.
- `docs/decisions/ADR-007-usage-semantics-and-rates.md` — the semantics and rate
  provenance decision.

No attempt failed three times; `attempts.jsonl` remains empty.
