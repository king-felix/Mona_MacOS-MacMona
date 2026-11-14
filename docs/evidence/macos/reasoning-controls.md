# Reasoning controls for the DeepSeek route

Status: **implemented and verified** · Date: 2026-11-14 · Route:
`deepseek` / `deepseek-flash` · Engine: Codewhale **0.10.2**
(`ff466b2ed0bfb4ae5267d4d8d0ecb562cf46956e`, unchanged) · Endpoint:
`https://api.deepseek.com/beta` (unchanged)

This is an amendment to P16 (MONA-020). It changes no requirement and no
platform; it makes the configuration workbench report and offer what the pinned
engine actually supports for this route.

## The reported problem

Settings → Providers & route showed one reasoning option, labelled **“Model
default (omit)”**, for a route that demonstrably reasons. The model's live
catalog row said `reasoning_effort: "unknown"`, so Mona offered no tier, no
thinking control, and no explanation of what omission inherited. The separate
“show reasoning in the interface” choice did not exist.

## What was traced

1. **Saved profile.** `engine:profile` holds provider, exact id, model,
   `reasoningEffort`. `loadExecutionProfile` reads it when a studio session
   starts; `saveDefault` writes it with compare-and-swap revisions. Omission is
   stored as the field being absent.
2. **Thread creation.** `POST /v1/threads` accepted `reasoning_effort` and
   echoed it on the thread record. Mona did not send it: new conversations
   carried no reasoning default of their own.
3. **Turn creation.** `POST /v1/threads/{id}/turns` already sent
   `reasoning_effort` when the profile held a value, and sent nothing when it did
   not. The runtime's receipt for that turn reports `effective_provider`,
   `effective_model`, and `effective_billing_surface` — but **not** the effective
   reasoning setting, and its `turn.provider_request` payload carries no
   reasoning field at all.
4. **What omission inherits.** `GET /v1/config` on the user's home reports
   `reasoning_effort: "auto"`. The engine documents `auto` as a value that its
   auto-reasoning selector dispatches as a concrete tier per turn; only an
   omitted setting with no configured default leaves the provider default in
   control. So Mona's omission inherits the engine's `auto`, not the provider's
   default — and it is **not** “thinking off”. The effective tier remains
   unreported and is shown as unknown.

Measured, not inferred: a tool-free live turn with an explicit `low` completed on
`deepseek-flash` (`openai-responses` wire) and the runtime stored the requested
value on the thread while reporting no effective value
(`docs/evidence/macos/artifacts/reasoning-live-turn.json`). The same call with
an unrecognized value is refused with the canonical vocabulary list, so the
runtime validates what it accepts.

## Why the model published no effort ladder

All five candidates were tested against the pinned binary:

- **Adapter parsing — no.** `GET /v1/providers/deepseek/models` really returns
  `reasoning_effort: "unknown"`, `reasoning_effort_levels: []`,
  `reasoning_effort_source: null`, and `facts.reasoning_options: []` for
  `deepseek-flash`. Mona mapped those fields faithfully.
- **Alias matching — no.** The same answer comes back for the canonical id
  `deepseek-v4.1-flash-1017`, for `?model_provider_id=deepseek`, and for
  `deepseek-v4-pro`. No spelling resolves to a richer row.
- **Stale cache — not the cause.** `POST /v1/providers/deepseek/models/refresh`
  succeeded and the answer stayed `unknown` with no levels. A hand-seeded
  **fresh** live roster produced the same result as the stale one.
- **Missing metadata — no.** The engine's own Models.dev cache
  (`<CODEWHALE_HOME>/catalog/models-dev-catalog.json`, fetched
  2026-11-14T18:01:32Z) publishes, for `deepseek-flash`:

  ```json
  "reasoning": true,
  "reasoning_options": [{"type": "toggle"}, {"type": "effort", "values": ["low", "high", "max"]}],
  "canonical_model_id": "deepseek/deepseek-v4.1-flash-1017"
  ```

  The same binary in an isolated home — where the live roster does not shadow the
  metadata — publishes exactly `low, high, max` with
  `reasoning_effort_source: "catalog"`.
- **Actual limitation — yes, in the projection.** When the provider's live roster
  is present, the runtime's model facts say `source.kind: "live"`,
  `canonical_model_id: null`, `reasoning: null`, `reasoning_options: []`. The
  metadata join is skipped, so the API cannot answer “what does this model
  publish?” even though the engine holds the answer.

**Cause:** the pinned engine's live provider-roster projection drops the
Models.dev reasoning metadata it still holds on disk. Mona treated that single
`unknown` as “no reasoning controls” and offered nothing.

## The fix

### The ladder is recovered from the engine's own metadata, not invented

`src/main/work/reasoning.ts` reads the engine's Models.dev catalog cache for the
**exact** provider and model id. It:

- bounds the file (64 MiB) and accepts only a regular file;
- parses the two-document cache (header + body) and refuses a newer
  `schema_version` instead of guessing;
- keeps only canonical effort values (`minimal`, `low`, `medium`, `high`,
  `xhigh`, `ultra`, `max`) and requires an exact model key — no family, alias, or
  name matching;
- returns `null` for a missing provider, model, or file.

The resulting support view separates four states, each with a source:

- `published` — the live catalog publishes the ladder now;
- `metadata` — the live projection withheld it, but the engine's own catalog
  publishes it for this exact model; marked `degraded: true` and labelled
  “engine catalog metadata”, never “live catalog”;
- `unsupported` — metadata explicitly publishes no selectable ladder; the note
  says this is **not** evidence that thinking is disabled;
- `unknown` — nothing proves a level; Mona offers none and says so.

An explicit engine answer always outranks cached metadata. No level is inferred
from a provider default or a model name.

### Validation stays fail-closed

`validateRoute` accepts a value only when the exact model proves it:

- an active tier must be in the published/metadata ladder;
- `off` is accepted only when the metadata publishes a thinking toggle;
- `unsupported` and `unknown` still refuse every value;
- a model with no metadata cannot borrow another model's ladder.

The IPC schema for `settings:save-default` previously enumerated every tier but
**omitted the engine's canonical `off`**, so disabling thinking could never have
been saved even if it had been offered. `off` is now admitted by the transport,
and route validation decides whether the route publishes it.

### What the screen says (D-110, current)

Reasoning is one card, and it declares rather than offers:

- **Reasoning setting: `auto`**, with a read-only badge and no control to change
  it. Auto is the engine's own default; its selector resolves a concrete tier for
  each turn. Mona sends `auto` explicitly, so the setting is stated rather than
  implied, and the engine's own configured default does not govern the route.
- **Stored or declared** — the card says whether the stored profile already
  carries the value. A read never writes, so a profile saved before this decision
  reads "declared default · not yet stored" until the next explicit save.
- **Published tiers are information only** — the card names what the model
  publishes (`low, high, max`) and labels it as informational, because Auto is
  what Mona sends. It offers no way to pick one.
- **Effective stays `unknown`**, with the engine's configured default and its
  source beside it. The card says the request is not proof of what the provider
  did, and — when a later engine reports it — shows an engine-reported value with
  the turn it belongs to.
- **Show reasoning in Mona's transcript** — a display-only preference, stored in
  Mona's own settings scope, never sent to the engine.

The earlier version of this screen offered a changeable `Engine decides` / `Off` /
`On` control with a published-tier menu. The owner replaced it with the single
declared setting above; the validation that gated those choices is retained
(it still refuses unpublished tiers and `off` without a published toggle) so a
later re-enable cannot become a bypass.

### Propagation

- A saved level is written to `engine:profile` with a revision and is sent on
  `POST /v1/threads` for a **new** conversation and repeated on every turn.
- An active session keeps the profile it started with. A later saved-default
  change does not rewrite its reasoning, its route, or any turn.
- The display preference is read by the studio snapshot and applied by the
  timeline projection: it hides only `agent_reasoning` cards. The frames are
  still stored and the request is unchanged.

## Verification

- **Unit tests** — 1,159 pass in 104 files (`npx vitest run`), twice in a row.
  One earlier run flaked on `test/supervisor-native.test.ts` "records the escaped
  process group and stops it by identity" — a pre-existing process-group timing
  test this change does not touch. It passed alone, in both later full runs, and
  in the final gate; it is reported here rather than hidden.
  - `test/reasoning-support.test.ts` — cache parsing, newer-layout refusal,
    canonical filtering, exact-key lookup, the four support states, and the
    requested/effective prose;
  - `test/settings-workbench.test.ts` — recovery from metadata, saving `high`
    and `off`, refusing `medium`, failing closed with no metadata, refusing
    `off` without a toggle, and persisting the display preference;
  - `test/engine-adapter.test.ts` — request capture: `reasoning_effort` on
    thread creation only when set, and on a turn only when requested;
  - `test/work-studio.test.ts` — the saved level reaches the new thread and both
    turns; a saved-default change does not alter the running session; the
    display preference never appears in a request;
  - `test/route-settings-reasoning.test.tsx` — the card names the inheritance,
    distinguishes thinking/effort/display, and saves the display preference;
  - `test/studio-reasoning-display.test.ts` — hiding reasoning removes only
    reasoning cards.
- **Live route check** — `npm run smoke:reasoning`, **10/10 checks**
  (`docs/evidence/macos/artifacts/reasoning-smoke.json`). It reproduces the
  user's two sources (live roster + Models.dev cache) in an isolated home,
  proves the engine answers `unknown`, proves Mona recovers
  `low, high, max` + toggle as *metadata*, saves `high`, refuses `medium`,
  saves `off`, persists the display preference, and starts **no** turn.
- **`npm run ci`** — **25 of 25 steps pass**, including the new
  `smoke:reasoning` step and `smoke:lifecycle` (58 rows): format, lint,
  typecheck, catalog, the three native builds, 1,159 tests, and every smoke.
  Two intermediate runs failed only `smoke:lifecycle`, because
  `/Applications/Mona.app` was running and held Electron's single-instance lock,
  so the smoke's instance exited before writing its `ready`/`crash.json` files;
  that cause was proven by launching the same command with a separate
  `--user-data-dir`. The app was then quit, and the step passed unchanged. No
  lifecycle assertion was modified or skipped.
- **Minimal live turn** — one tool-free turn with explicit `low`; requested
  value stored, effective value unreported
  (`docs/evidence/macos/artifacts/reasoning-live-turn.json`). No provider,
  endpoint, model, or engine change; temporary threads archived and the
  temporary workspace removed.

## What is not proven

- **Effective reasoning on 0.10.2.** The pinned engine reports no effective
  reasoning setting on any documented route, so on this build Mona shows
  `unknown` and the engine's token evidence. The forward-compatible path that
  consumes the field is implemented and tested; it activates with a later engine
  and needs no further change. This was not assumed: one tool-free turn with
  an explicit `low` was run, and every documented read surface was inspected —
  thread record and turns, `turn.completed`, `turn.provider_request`, the turn
  receipt (API and `codewhale receipts --format json`), thread usage, thread
  context, `/v1/sessions`, `codewhale metrics` (text and `--json`), the settings
  schema, and the model catalog. None carries an effective value; the identifier
  `effective_reasoning_effort` appears only in the binary and in a static
  descriptor. The matrix is
  `docs/evidence/macos/artifacts/reasoning-engine-gap.json`. Mona shows
  `unknown`; it never presents the request as the effective value.
- **`off` on the wire.** The engine documents `off` as `reasoning.effort: "none"`
  on the Responses path and `thinking: {"type":"disabled"}` on Chat. The live
  receipt does not expose the wire field, so Mona claims only that `off` is
  published by the metadata and accepted by the runtime, not that it was
  observed on the wire.
- **Machines without the metadata cache.** If the engine has neither the live
  catalog ladder nor its Models.dev cache, Mona offers no controls and says the
  metadata is unavailable. It does not fall back to a hard-coded list.
- **The live catalog itself.** `POST /v1/providers/deepseek/models/refresh`
  succeeds and still reports no ladder, so Mona's metadata fallback is the only
  non-inventing source on this build. The two smallest engine changes that would
  remove the fallback — join the canonical id on live roster rows, and add
  `effective_reasoning_effort` to `TurnRecord` — are recorded in `BLOCKERS.md`
  under "Needs the Human". There is no supported way to reach either from Mona,
  and the engine's private session documents are not parsed to fake one.
- **Custom and named routes.** The engine's metadata describes the provider's
  first-party endpoint, so Mona does not use it for a named exact route or a
  configured `base_url`. Those routes show whatever their own live catalogue
  publishes — often `unknown` — and Mona offers no levels there rather than
  borrowing the first-party ladder.

## The review pass

An independent reviewer read the working tree diff against the change's risks. It
raised four defects. All four were reproduced, fixed, and covered by a test; none
was dismissed without a measurement.

1. **`Off` was offered but refused (blocker).** `deriveReasoningSupport` returns
   `effort: "unsupported"` **and** `thinking: "toggle"` for a model whose live
   catalogue publishes no ladder but whose metadata publishes a toggle — and
   `validateRoute` rejected every level, including `off`, before it ever looked at
   the toggle. The engine's own cache holds **993 such models** (measured), so this
   was a user-visible refusal on a large real population. `off` is now gated on
   the thinking control alone, before the ladder state is consulted, in
   `validateRoute` and in the screen's option list.
   Tests: `test/settings-workbench.test.ts` "accepts off for a toggle-only model
   and still refused a tier it does not publish"; `test/route-settings-reasoning.test.tsx`
   "offers Off for a toggle-only model, matching what validation accepts".
2. **The metadata fallback was not route-scoped (major).** The cache is keyed by
   provider and model, while the screen said "this exact route". A named exact
   route, or a provider whose `base_url` the user configured, is a different
   endpoint — the runtime itself refuses to infer levels there. Mona now uses the
   cached metadata only when the catalogue reports no exact id **and** the config
   contains no `base_url` for that provider (top level, `[providers.<name>]`, an
   accepted spelling, or a profile). Anything unreadable fails closed; a missing
   config is not a custom endpoint, because the engine writes that file itself.
   Tests: `test/reasoning-support.test.ts` "endpoint scoping" (3 tests);
   `test/settings-workbench.test.ts` "does not borrow first-party metadata for a
   configured endpoint"; and a 10th live check.
3. **The `unsupported` note overstated (minor).** It said the engine's catalogue
   publishes no ladder even when the metadata did, and its `sourceDetail` ignored
   the engine's own source. It now names this route's catalogue answer, carries
   the engine source, and says when the provider's metadata disagrees.
4. **A cached engine default was labelled current (minor).** With the engine
   disconnected, the last read was reported as `engine_config`. It is now
   `engine_config_cached`, shown with its read time and the words "may have
   changed"; `unavailable` stays distinct from both.
   Test: `test/settings-workbench.test.ts` "labels a cached engine default as
   stale rather than current".

It also independently confirmed the earlier finding that one implementation
resolved the catalogue once per model: a roster can list hundreds of models, so
that path could start hundreds of concurrent multi-megabyte reads. The reader now
has a single-flight load and the screens resolve a whole roster from one read
(`test/reasoning-support.test.ts`, "resolves a whole roster from one read,
including a large provider", 600 models).

## Second review pass

A second independent review read the fixed tree. It found two more defects and two
minor points. One was a blocker:

1. **The screen's own payload was refused (blocker).** The provider row carries
   the engine's `model_provider_id`, and for a built-in provider that repeats the
   provider id — `exactId: "deepseek"`. `saveDefault` used the raw value for the
   catalogue read and for validation, while the route-scoping check required a
   null id, so the snapshot showed `low|high|max` and the save refused `high`.
   `routeExactId(provider, exactId)` now normalizes the built-in canonical id to
   the generic route once, and the read, cache key, validation, stored profile,
   `models()`, `switchEngineRoute`, and `supportMap` all use it. Covered by
   "saves from the screen's own payload, where a built-in row returns its
   canonical id", and the live check now saves with `exactId: "deepseek"` and
   asserts the stored profile is `exactId: null`.
2. **The TOML scanner missed dotted keys and inline tables (major).** Both are
   valid TOML for the same route — `providers.deepseek.base_url = "…"`, and
   `providers = { deepseek = { base_url = "…" } }`, the latter the shape the
   engine's own `config list` prints and the user's config already uses for
   `update`. A custom endpoint configured either way would have borrowed
   first-party metadata. The scanner now builds a key path from the table plus
   the assignment, splits quoted keys, and reads first-level names out of an
   inline `providers` table; an unreadable shape fails closed. Covered by
   "sees a dotted key and an inline providers table as the same endpoint".
3. **A toggle was attributed to the live catalogue (minor).** The live projection
   has no thinking field, so a published toggle always comes from the metadata.
   The note and `sourceDetail` now say so.
4. **An open Studio could show a stale transcript (minor).** The preference was
   stored but nothing told an already-open Studio. `RouteWorkbench` now takes an
   optional `onDisplayChanged`, called after the write and after the snapshot is
   taken; the shell turns it into a control push, which the existing handler uses
   to re-read the snapshot. Nothing is sent to the engine. Covered by "announces
   a display change only after the write", plus screen-level tests that prove
   only reasoning cards disappear.

It also noted that a transient catalogue read failure was cached as `null` until
the file's mtime changed. That cache entry is gone: a failed read returns null
without being remembered.

## The durable fix (2026-11-14, second owner request)

Asked for the most direct and reliable long-term fix, the answer is not another
Mona workaround: **no client-side change can produce a true effective value.** The
runtime must publish what it parsed. Three options were weighed:

- **Upgrade the engine.** Rejected as neither direct nor reliable. The compat gate
  pins version *and* commit; the installed binary is npm-managed and in-place
  self-update is disabled; the pin change would invalidate 28 prompts of evidence;
  and nothing proves a later build fixes either gap.
- **An upstream engine change.** This is the real fix, and it is not something this
  build can merge. It is written up as a ready-to-send request:
  `docs/evidence/macos/engine-change-request-reasoning.md`.
- **A forward-compatible consumer.** Executed, because it is what makes the
  upstream fix *reliable*: the moment any engine build reports the values, Mona
  shows them, with no further code change and no pin bump on the consumer side.

What was implemented:

- `WireTurn` accepts `effective_reasoning_effort` and `effective_reasoning_source`;
  `TurnRecord` and `EffectiveProfile.effective` carry them. Both are optional, so
  the pinned build's silence stays silence.
- `describeInheritance` returns an effective value **only** when the engine
  reported one, with source `engine_turn_receipt` and the turn it belongs to, and
  says it is a fact about that turn rather than a promise about the next.
- The observed route carries the engine's reasoning-token count, and the screen
  states what it proves: non-zero is positive evidence that thinking ran, zero is
  reported as inconclusive, unreported as no evidence either way. Neither is ever
  presented as an effective setting.
- Tests cover the whole path: the adapter reads the reported value and omits it
  when absent; `WorkStudio` carries it into the snapshot from a turn that reports
  it; the settings snapshot shows it as effective; the screen renders it with its
  source and evidence. The pinned engine's live behaviour is unchanged — the smoke
  still observes `effective: null`, so nothing was faked to make the path look
  exercised.

## Files

- `src/shared/contracts/settings.ts` — support view, requested/effective/
  display view, `ModelView.reasoningSupport`.
- `src/main/work/reasoning.ts` — cache reader, support derivation, inheritance
  prose.
- `src/main/work/settings.ts` — support attached to catalogs, metadata-aware
  validation, reasoning snapshot, display write.
- `src/main/work/profile.ts` — display preference scope and reader.
- `src/main/work/studio.ts`, `src/main/engine/types.ts`,
  `src/main/engine/adapter.ts` — thread-level reasoning default and display in
  the studio snapshot.
- `src/main/index.ts` — turns a display change into a studio control push so an
  open Studio re-reads its snapshot.
- `src/renderer/shell/RouteSettings.tsx` — the reasoning card.
- `src/renderer/shell/timeline.ts`, `src/renderer/shell/Studio.tsx` — display
  preference applied to the transcript.
- `src/main/ipc-contract.ts`, `src/main/ipc.ts`, `src/preload/index.ts`,
  `src/shared/contracts/bridge.ts` — `off` admitted, display channel added.
- `scripts/reasoning-smoke.mjs`, `package.json`, `scripts/ci.mjs` — live check,
  wired into `npm run ci`.
- `tools/p18-coverage/reconcile.mjs` — the generated capability rows now name
  this amendment; `docs/codewhale-capabilities-macos.json` was regenerated with
  `--write` rather than hand-edited.
- Tests listed above.
