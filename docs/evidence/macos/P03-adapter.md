# P03 — Real versioned engine adapter

**Date:** 2026-11-11 · **Engine:** pinned Codewhale 0.10.2
(`ff466b2ed0bf`) · **Status:** complete

## Result

The P01 spike is replaced by a reusable adapter in `src/main/engine/` with a
typed interface, explicit version/capability policy, durable submission intent,
read-only reconciliation, bounded replayable streaming, wrong-thread rejection,
and effective-profile verification. Recorded contract fixtures and a real
pinned-runtime smoke test pass. 70 tests pass; local CI is green.

## Interface and files

- `types.ts` — `EngineAdapter` and result types (discover, owned runtime,
  thread, submit, reconcile, subscribe, interrupt, history, usage, effective
  profile, capability invocation, shutdown).
- `compat.ts` — pinned version/commit and required capabilities.
- `wire.ts` — upstream response validation (loose on unknown fields).
- `transport.ts` — `RuntimeTransport`; `HttpRuntimeTransport` (loopback only,
  bearer token, streaming UTF-8 decode).
- `adapter.ts` — `CodewhaleAdapter`, the versioned boundary.
- `submission-store.ts` — atomic JSON store / in-memory store; P05 replaces the
  storage mechanism, not the ordering contract.
- `projector.ts` — deterministic event projection with cursor dedupe.
- `sse.ts` — bounded incremental SSE parser.
- `runtime-process.ts` — native binary resolution, loopback spawn, health and
  socket ownership, process-group stop. P04 owns the full supervisor.

**Deviation, stated plainly:** `subscribe()` yields typed items
(`event` / `progress` / `diagnostic` / `end`) rather than bare `EventEnvelope`
values. The pinned API mixes durable events with transport progress frames and
terminal `stream.end`; collapsing them into one type would hide the distinction
P03 is required to preserve.

## Compatibility policy

`evaluateCompatibility` requires **exactly** Codewhale `0.10.2` at commit
`ff466b2ed0bfb4ae5267d4d8d0ecb562cf46956e` and the `threads`, `turns`, and
`event_replay` capabilities. A different version, commit, or missing core
capability fails closed with `INCOMPATIBLE_ENGINE` before any mutation. Interrupt
is optional at discovery and returns a typed `UNSUPPORTED_CAPABILITY` when not
advertised. Any widening is a recorded, tested decision.

## Submission safety

1. The submission record (`operation_key`, thread, status `sending`) is written
   **before** the POST. A store failure means no send.
2. A successful response updates the record with the turn id and status.
3. A transport error, 409, or 5xx marks `outcome_unknown`; it is never retried.
4. `reconcileSubmission` uses
   `GET /v1/threads/{id}/turn-operations/{key}` (read-only):
   - `200` returns the existing turn and updates the record;
   - `404` stays `outcome_unknown` with explicit "do not resubmit" guidance;
   - `409`/`5xx` stay `outcome_unknown` and advise retrying the lookup only.
5. A response whose turn belongs to another thread is rejected (`WRONG_THREAD`)
   and its submission is marked `outcome_unknown`.

Local operation keys alone are not claimed to make upstream writes idempotent;
the runtime's advertised `turn_operation_idempotency` and
`turn_operation_lookup` are required for the safe path.

## Streaming, replay, and projection

- Frames are parsed incrementally; a split frame waits for its blank line, and a
  frame over 8 MiB is rejected (`event_too_large`).
- UTF-8 decoding is streaming, so a multi-byte character split across network
  chunks is reassembled (tested).
- Durable events are validated, deduplicated by per-thread `seq`, and applied to
  an `EventProjector`. An accepted sequence is never applied twice.
- `stream.progress` is a transport frame: it carries no timestamp/payload and
  never advances the accepted cursor.
- Malformed JSON, schema drift, and an event for another thread become typed
  diagnostics and do **not** mutate projection state. Unknown event kinds are
  kept in `unknownEventKinds` for inspection.
- `stream.end` is terminal. Reconnect with `since_seq` replays display state; it
  never re-executes tool work or recounts a charge.

## Effective profile, not requested profile

`getEffectiveProfile` reads the persisted turn and returns both requested and
effective provider/model/permission posture plus `usedFallback`. With
`strict: true` it fails `PROFILE_MISMATCH` if the route differs or Full Access
was requested but not effective. The real smoke used `strict: true` and observed
`deepseek` / `deepseek-flash` / `full_access`.

## Capability invocation

Whitelisted: `runtime.info`, `providers.list`, `providers.models`,
`usage.read`, `session.resume`. Anything else is a typed unsupported result.
One-shot `exec` is deliberately not part of this adapter.

## Contract fixtures

`test/fixtures/engine/` contains recorded-shape fixtures transcribed from the
pinned API and P01 runs: `runtime-info.json`, `thread.json`,
`turn-accepted.json`, `events.json` (8 envelopes including an unknown event),
and `usage.json`. `p03-fixtures.txt` records their hashes. A `FixtureTransport`
in `test/helpers/` substitutes the network without changing adapter logic.

## Test evidence (70 total)

Engine-specific coverage:

- compatibility: pinned accepted; version drift, commit drift, and missing
  capabilities rejected;
- thread create: workspace/execution posture sent, no route override;
- submission intent persisted **before** POST; prompt sent byte-for-byte with no
  metadata suffix;
- lost response: `outcome_unknown`, exactly one POST, lookup reconciles the same
  turn;
- absent operation: 404 stays `outcome_unknown` with no blind resubmit;
- wrong-thread submit response and wrong-thread history rejected;
- replay projection: completed state, message text, tool item, unknown event,
  Full Access posture; second subscription produces an identical projection;
- malformed JSON, schema drift, and wrong-thread frames become diagnostics while
  valid frames continue;
- interrupt confirms only from terminal turn state; unsupported interrupt is
  typed;
- effective profile: match, fallback detection, strict route failure, strict
  Full Access failure;
- usage: unknown cost completion preserved (`costComplete: false`);
- unknown capability invocation is typed unsupported;
- SSE parser: split frames, CRLF, multi-line data, malformed JSON, oversize
  rejection, UTF-8 chunk boundary.

## Real pinned-runtime smoke

`scripts/engine-smoke.mjs` starts the installed native binary, creates a
tool-free Full Access thread, submits one small turn, follows the live stream,
reads history, verifies strict effective profile, reconciles by operation
lookup, reads usage, exercises the interrupt route on the now-completed turn,
and shuts the runtime down.

Observed (`artifacts/p03-engine-smoke.json`):

- Thread `thr_5e260c6d18b24e4abe20e86731b072b9`, turn
  `turn_4eb8fe6fe767453782b3379d0d7fc0ca`, status **completed**.
- Effective `deepseek` / `deepseek-flash` / `full_access`; strict verification
  passed.
- 15 durable events; 0 stream diagnostics; projection status `completed`,
  message text `pong`, Full Access posture, five unknown-but-preserved event
  kinds.
- Operation lookup returned the **same** turn (`evidence: lookup`).
- Interrupt on a completed turn returned `409` and was represented honestly as
  "no active turn to interrupt", not as a confirmed stop. Active-turn interrupt
  was proven in P01 and is covered by the adapter fixture test.
- Usage reported 12 turns in the 10-minute window; `costComplete: false`
  because some prior fixture/interrupted turns are unpriced. No cost was
  invented.

All ten smoke checks passed.

## Acceptance mapping

| Requirement | Evidence |
|---|---|
| Recorded fixtures + real smoke pass | `p03-fixtures.txt`, 70 tests, `p03-engine-smoke.json` |
| Wrong-thread responses cannot mutate another project | `engine-adapter.test.ts` wrong-thread submit/history tests; projection asserts thread identity |
| Response-loss simulation does not duplicate work | lost-response test: one POST, lookup-only reconciliation |
| Reconnect yields the same projected state | replay test: second subscription projection deep-equals the first |
| Permission/model verified effective | strict profile test + real smoke effective route/posture |

## Deliberate gaps

- Approvals and clarifications are not wired to UI yet; the adapter does not
  auto-answer them.
- Steer, artifacts, workspace search/restore, terminal, and fleet are not
  adapter operations in P03.
- Process supervision is deliberately minimal: P04 owns liveness, descendants,
  crash restart, and quit/stop semantics.
- P05 replaces the JSON submission store with the product database; the
  ordering guarantee stays.
