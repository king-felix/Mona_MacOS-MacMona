# ADR-007 — Usage semantics, cost states, and rate provenance

- **Date:** 2026-11-11 (P12)
- **Status:** accepted
- **Prompt:** P12 — Build the cost ledger and optional budget controls
- **Requirements:** MONA-003, MONA-013
- **Related:** spec §9.1, §9.3, §9.4; P01 economics evidence; ADR-005; ADR-006

## Context

The pinned engine reports two different usage shapes, and a ledger that treats
them as interchangeable double-counts tokens or dollars:

1. **A turn record** (`TurnRecord.usage`, from history and the SSE terminal
   event) reports `input_tokens` as the **inclusive** prompt total. In the P01
   live run the same turn read `input_tokens = 53,377` while also reporting
   `prompt_cache_hit_tokens = 39,680` and `prompt_cache_miss_tokens = 13,697`
   (39,680 + 13,697 = 53,377). Cache and reasoning buckets are subsets, not
   additional buckets.
2. **A `/v1/usage` bucket** reports `input_tokens` as the **exclusive**
   cache-miss count and `cached_tokens` separately. In the P01 economics run the
   same file-change turn read `input_tokens = 12,659`, `cached_tokens = 40,448`.
   Adding `input_tokens` and `cached_tokens` from a bucket is correct; doing the
   same with a turn record would count cache hits twice.

`/v1/usage` is the only route that carries a price: the engine computes
`cost_usd` from its model→pricing map and, when the pinned build supports it,
reports `cost_complete`, `unpriced_turns`, and `pricing_provenances`. A turn
record carries no price at all. There is no per-turn cost endpoint and no
account-balance endpoint. Reading a balance is forbidden by spec §9.3.

The provider's own billing remains authoritative. The engine's number is a
provider-derived report, not an invoice. Mona's job is to preserve that
distinction in durable, testable state.

## Decision

### 1. One ledger row per completed turn, never per aggregate read

`usage_records` is the ledger. A row is keyed by `(thread_id, turn_id)` with a
partial unique index, and it is written **once** when the turn reaches a terminal
state. A reconnect, a history replay, or a new process re-observes the same turn
and updates the existing row only when the new observation carries strictly
better price evidence (reported > estimated > unknown). It never inserts a
second row and never increases a total by re-reading.

`/v1/usage` aggregates are used for **allocation**, not as additional ledger
rows. They are cumulative for a stable window, so a reported thread total is
converted into a per-turn delta and the delta is what the ledger stores. The
sum of deltas equals the reported total exactly. Parent and child threads each
keep their own mark; a project rollup sums turn rows, so a parent aggregate that
already includes a child is never added a second time.

### 2. Token buckets are labeled, not guessed

Each row records:

- `input_tokens` — the turn's **inclusive** prompt total;
- `cached_tokens` — cache-hit input, a subset of `input_tokens`;
- `cache_miss_tokens` — cache-miss input when the engine reports it separately;
- `output_tokens` — billed completion tokens;
- `reasoning_tokens` — reported separately, **not** added to output when the
  provider includes reasoning in completion tokens (DeepSeek does; the rate card
  says so explicitly).

A local estimate uses `miss = input − cached` only when the row is
inclusive-input and `cached ≤ input`. If the buckets disagree (`cached > input`)
the row is marked `token_conflict` and no estimate is produced, because the
provider's semantics changed and subtracting would invent a number.

### 3. Four distinct cost states, plus one honest residual

| State           | Meaning                                                                                             | UI                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `reported`      | The engine returned a complete price for this turn (directly or as an exact thread delta).          | “Reported”, authoritative-as-reported                                                  |
| `estimated`     | A user-supplied rate card priced the reported tokens.                                               | “Estimated”, never “reported”                                                          |
| `unknown_price` | Tokens exist; no complete price and no applicable rate card.                                        | “Unknown”, excluded from a complete total                                              |
| `missing_usage` | The engine reported no usage for the turn.                                                          | “No usage”, excluded from every total                                                  |
| `unallocated`   | The thread total moved backwards (window reset or engine restart), so no non-negative delta exists. | “Unallocated”, excluded from turn totals; the thread total is retained by its own mark |

`cost_complete` means **every observed turn has a definite number** (reported or
estimated). `cost_basis` says whether the known total is all reported, mixed, or
all estimated. A project is never shown as a complete reported total when any
turn is estimated or unknown. Unknown is never rendered as `$0.00`.

### 4. Rate cards are explicit, versioned, and historical

`rate_cards` stores provider, model, currency (USD only for now), unit
(`per_million_tokens`), cache-hit / cache-miss / output rates, the
`reasoning_in_output` flag, an optional tool-call rate, the source
(`user_supplied` today; `provider_docs` reserved for a captured citation), the
source reference, a content revision hash, `read_at`, and an optional
`effective_from`/`effective_to`.

**Mona ships no built-in price table.** The P01 artifacts record engine-reported
totals, not the provider's rate sheet, and the installed runtime exposes no
pricing catalog. Copying a remembered price into code would be invention. A
rate card exists only when a human enters one; until then `estimated` is
unavailable and the engine's report (or `unknown_price`) is the only truth.

Updating a rate card creates a new revision. Existing rows keep the
`rate_card_id` and `pricing_read_at` they were priced with, so history is
preserved. A recalculated view is available only as an explicit **preview**
(`CostLedger.previewRecalculation`) that writes nothing; rewriting stored
history requires a future, explicit migration decision.

### 5. Currency and arithmetic use integers

Costs are stored as **pico-USD integers** (`1 USD = 1e12 pico`). A rate in USD
per million tokens converts exactly: `pico_per_token = rate_per_million × 1e6`
for rates with at most six decimals. Sums are exact integer additions; the UI
formats dollars at display time. This makes the fixture arithmetic exact instead
of “close enough”, including the specification's

`estimated = hit × hit_rate + miss × miss_rate + output × output_rate + tools`.

### 6. Day boundaries are civil, not UTC

A `day` budget uses the user's configured IANA time zone (default: the host's
current zone). `civilDayRange(at, zone)` computes the local civil date and its
`[start, end)` UTC instants with `Intl.DateTimeFormat`, including short and long
days. A day budget shown as “today” is the user's today, and a test pins the
result across a DST transition.

### 7. Budgets are optional, user-set, and disclosed

A budget has a scope (`session`, `project`, `day`), a limit, an optional warning
threshold, an enabled flag, and the time zone used for `day`. The default is no
budget. When enabled:

- **warn** before the next dispatch when known spend crosses the threshold;
- **stop** blocks the **next** dispatch when known spend reaches the limit;
- an in-flight provider request can complete after a stop request, so a local
  limit is **not** an invoice cap;
- if any turn in scope is unknown, the known spend is a lower bound and the UI
  says so; the gate still stops because the bound already crossed the limit;
- no budget is mandatory and no budget silently interrupts an authorized prompt
  midway. Raising or clearing a budget is an explicit human action.

Mona serializes mutating work (one running task and one owned runtime per
workspace). Therefore the gate evaluates at dispatch and there is exactly one
in-flight turn to account for; a dollar “reservation” would require inventing a
per-turn estimate. Instead the ledger records the dispatch intent
(`cost_reservations`) as a slot and re-evaluates after the turn lands. A future
qualified concurrent executor must re-run this gate for every slot.

### 8. No inference, no router, no balance

Every number in this ledger comes from an engine usage response or integer
arithmetic over a user-supplied rate card. The ledger has no model client. UI
navigation, ledger reads, budget evaluation, export, and rate edits perform zero
inference and never mutate an outgoing request. No auto-fallback, no
summarizer, no balance scrape.

## Consequences

- The engine's partial pricing (`cost_complete: false` or a bucket missing a
  price) appears as `unknown_price`, not as a cheap turn.
- A missing per-turn price for a multi-turn thread is resolved by exact
  thread-delta allocation, not by dividing, averaging, or asking a model.
- Providers that bill quota instead of dollars (Kimi Code membership, MiniMax
  Token Plan, Xiaomi token plan) remain `unknown_price` unless the user supplies
  a rate card; no dollar value is borrowed from another product.
- Tests use fixture rate cards only. Production starts with an empty
  `rate_cards` table, and the UI states that local estimates are unavailable
  until a rate source is recorded.
- `usage_records.cost_usd` is kept as a formatted mirror of the canonical
  `cost_pico_usd` for existing readers; every rollup uses the integer column.
