# Engine change request — publish the reasoning facts the runtime already has

**Status:** ready to send · Raised by: Mona (macOS workbench) · Target: Codewhale
engine · Measured on: **0.10.2** (`ff466b2ed0bfb4ae5267d4d8d0ecb562cf46956e`)

This is the direct, long-term fix for effective reasoning controls. Everything in
it was reproduced against the pinned build; the probe matrix is
`docs/evidence/macos/artifacts/reasoning-engine-gap.json`.

Mona's side is already forward-compatible: it reads both fields described below
the moment an engine emits them, with no further change. When this lands, the
workaround described at the end retires itself.

## Why this matters

Two controls a user expects are unprovable from the Runtime API:

1. **Which effort tiers this exact model accepts.** The API answers `unknown` for
   a model whose own metadata publishes `low|high|max`.
2. **Which setting the turn actually used.** The API reports the request and the
   effective model, never the effective reasoning setting.

A client can only show what it *asked for*. It cannot show what happened, and it
cannot tell "no metadata" from "no reasoning support".

## Request 1 — join the canonical model id on live roster rows

**Observed.** With a live roster entry present for the provider,
`GET /v1/providers/deepseek/models` returns:

```json
{ "id": "deepseek-flash",
  "reasoning_effort": "unknown",
  "reasoning_effort_levels": [],
  "reasoning_effort_source": null,
  "facts": { "canonical_model_id": null, "reasoning": null, "reasoning_options": [],
             "source": { "kind": "live" } } }
```

With no roster cache present, the same binary and the same route return:

```json
{ "id": "deepseek-flash",
  "reasoning_effort": "supported",
  "reasoning_effort_levels": ["low", "high", "max"],
  "reasoning_effort_source": "catalog",
  "facts": { "canonical_model_id": "deepseek/deepseek-v4.1-flash-1017",
             "reasoning": true,
             "reasoning_options": [{ "type": "toggle" },
                                   { "type": "effort", "values": ["low","high","max"] }],
             "source": { "kind": "models_dev_live" } } }
```

`POST /v1/providers/deepseek/models/refresh` reports `outcome: "updated"`,
`status: "fresh"`, and the answer stays `unknown`.

**Cause.** A live roster row carries no canonical model id, so the Models.dev
join has nothing to join on and its fields are left empty. The metadata is on
disk and the engine reads it on the other path.

**Smallest change.** When building a catalog row from live roster facts, fill
`canonical_model_id` if it can be resolved for `(provider, wire model id)`, and
let the existing metadata lookup populate `reasoning`, `reasoning_options`,
`reasoning_effort*` and the other `facts` fields exactly as the non-live path
already does. Where it cannot be resolved, the row keeps today's `unknown`
behaviour — no inference, no provider-wide default.

**Acceptance.**

- `GET /v1/providers/deepseek/models` on a host with a fresh roster returns
  `deepseek-flash: reasoning_effort: "supported"`, levels `low, high, max`,
  source `catalog`, and a non-null `canonical_model_id`.
- A model whose metadata has no ladder still returns `unsupported` with empty
  levels, and one with no metadata still returns `unknown`.
- A custom or named route keeps returning `unknown` for its ladder: no levels
  may be inherited from the first-party metadata on another endpoint.

## Request 2 — report the effective reasoning setting on the turn

**Observed.** A tool-free turn submitted with `reasoning_effort: "low"`
completes; the thread record stores `low`. The turn record carries:

```json
{ "effective_provider": "deepseek", "effective_model": "deepseek-flash",
  "effective_billing_surface": "first-party-payg", "effective_endpoint_fingerprint": "…",
  "modelRequestDiagnostics": { "modelRequestsStarted": 1, "transportRetries": 0, … } }
```

There is no reasoning field. The same is true of `turn.completed`,
`turn.provider_request`, both receipt routes, `codewhale receipts --format json`,
thread usage, thread context, `/v1/sessions`, `codewhale metrics`, and
`GET /v1/settings/schema`. Internal structs already carry
`effective_reasoning_effort`, `reasoning_resolution`, `reasoning_wire_effort`,
`reasoning_wire_effort_source` and `reasoning_wire_control_keys`; none is
projected.

**Smallest change.** Project the already-computed values onto `TurnRecord`:

```json
{ "effective_reasoning_effort": "low",
  "effective_reasoning_source": "requested" }
```

`effective_reasoning_effort` is the canonical tier the engine resolved (for
`auto`, the concrete tier the selector chose; for `off`, `off`).
`effective_reasoning_source` names where it came from — `requested`,
`thread_default`, `config_default`, `auto_selector`, `provider_default` — so a
client can distinguish "the user asked for this" from "nothing was configured".

Projection only: the thread, turn, receipt and event routes already serialize
the turn record, so no new route is needed. Do not derive it from
`reasoning_tokens`; a provider may report none even while thinking runs.

**Acceptance.**

- A turn submitted with an explicit tier returns that tier as the effective
  value, with source `requested`.
- A turn submitted with no tier returns the concrete tier the auto selector
  dispatched, with source `auto_selector` (not `auto`).
- A turn on a route with no configured default returns the provider default in
  effect, or the field is absent — never a guess.

## Status of the two requests after D-110

Mona now **declares** `auto` and sends it explicitly (D-110), so request 1 is no
longer needed to make the setting unambiguous — the value is stated, not inferred.
It remains worth having: a user who later wants a concrete tier can only be
offered one when the catalog publishes it truthfully.

Request 2 (the effective value) is unchanged in importance. With `auto` declared,
the question "what did the engine actually dispatch?" is the only one Mona cannot
answer, and it is exactly what a user asking for reasoning controls wants to see.

## What Mona does until this lands

`src/main/work/reasoning.ts` reads the engine's own Models.dev cache for the exact
provider and model, and offers only the values it publishes. It labels that source
as metadata, applies it only to a first-party route, and shows the effective
setting as `unknown`. It also reports the engine's own reasoning-token count as
*evidence*: non-zero proves thinking ran, zero is reported as inconclusive, and
neither is presented as an effective setting.

Both behaviours retire automatically:

- when request 1 lands, the live catalog answers `supported` and the metadata
  fallback is not consulted (the live answer already outranks it);
- when request 2 lands, `effective_reasoning_effort` is read from the turn record
  and shown as an effective value with source `engine_turn_receipt` — a path that
  is already implemented and tested against a simulated engine.
