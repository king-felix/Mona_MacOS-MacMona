# A saved model the engine dropped is refused before dispatch

Status: **implemented and verified** · Date: 2026-11-15 · Owner report · Engine:
Codewhale **0.10.2** (`ff466b2ed0bf`), unchanged · Route: `deepseek`

This is a repair outside the prompt sequence. It changes no requirement, no
platform, and no engine pin. It closes the *reporting* gap that let a provider
400 stand in for an actionable refusal.

## The reported problem

> Attempted to use Mona, and ran into this error … `Invalid request (400): The
> supported API model names are deepseek-flash, deepseek-v4-pro, but you passed
> deepseek-v4-flash-0731. (request_id: f7417afb-4df1-40f2-a18f-1c6e8165fb74)`

## What was traced

1. **The saved route.** `engine:profile` v3 (written 2026-11-14 20:17:16Z) held
   `provider: deepseek`, `exactId: null`, `model: deepseek-v4-flash-0731`,
   written by `RouteWorkbench.saveDefault` — which is a *validated* write. It was
   accepted because the engine's roster at that moment listed that id: the cached
   read from 20:17 (`engine:model-cache:deepseek:deepseek`) contains 23 models,
   this one among them, and Mona's validation is against that roster.
2. **The engine's roster today.** `codewhale models --provider deepseek --json`
   returns exactly two models:

   ```json
   [ { "id": "deepseek-flash", "owned_by": null, "created": null },
     { "id": "deepseek-v4-pro", "owned_by": null, "created": null } ]
   ```

   The engine's own configured route is `default_text_model = "deepseek-flash"`.
   The roster is the engine's and it is allowed to change (item 82 in
   `HANDOFF.md`: a version/commit change shows as drift here).
3. **Where the failure surfaced.** Two accepted turns in project Kindle,
   thread `thr_8429aae2bc5546fcb7a0e57a54a26e6d`:

   ```
   turn_f4019a071c7a465b918af8ecac0b5b95  failed  deepseek-v4-flash-0731  03:23:24Z
   turn_82171793e3ea4a93960a2085762f6ec5  failed  deepseek-v4-flash-0731  03:24:32Z
   ```

   Both arrived through `POST /v1/threads/{id}/turns` (`accepted`), started
   (`turn.started`), and then closed with `item.failed` carrying the provider's
   400 text. So the turn cost a submission, a started turn, and a cryptic error
   in place of a refusal.
4. **The same model worked before.** Four turns on `deepseek-flash` completed on
   2026-11-14 in this same install (`turn_8a2e67cc…`, `turn_489e2ee1…`,
   `turn_1f6a3f41…`, `turn_e89f7753…`), so the repaired route is one that this
   endpoint accepts.

## Root cause

Route validation was a **save-time** predicate only. `saveDefault` refuses to
persist an unlisted model and `validateRoute` is the single gate it uses — but
`WorkStudio.transmit` sent `model: session.profile.model` on every turn without
asking whether the engine still offers it. A roster that changes under a saved
profile therefore turned into a provider 400 after the turn had started.

## What changed

- **`unsupportedSavedModel` (`src/main/work/settings.ts`)** — the save gate's
  question, asked at dispatch. A **non-empty** live catalog that does not contain
  the saved model is a refusal; the message names the saved model, the models
  the engine offers (bounded to 8 with an honest `+N more`), and the exact screen
  to fix it. `null`/empty/unreadable catalogs are **no objection**: the engine
  stays the authority there, so this cannot block a route the engine accepts.
- **`WorkStudio.savedRouteRefusal` + `transmit` (`src/main/work/studio.ts`)** —
  the check runs once, immediately before `submitTurn`, and throws
  `StudioError("ROUTE_UNSUPPORTED")`. Nothing is sent, no submission is
  recorded, and the composer is immediately reusable. Because the check lives in
  `transmit`, it also covers a queued follow-up and board dispatch.
- **Adopting a route the user already saved** — a session pins the profile it
  started with (`start()` returns early for a live session), so the refusal's
  advice ("choose a supported model in Settings") originally changed nothing and
  the same error repeated forever. That was found by an independent review and
  fixed: when the pinned route is unsupported, dispatch re-reads the stored
  profile and, if it now names a different supported route, adopts **only the
  route fields** for this session. Permission posture, auto-approve, trust mode,
  and shell access are untouched, so a route change cannot widen authority.
- **A refused follow-up is not an unknown send** — it stays `queued` with the
  reason. Nothing was sent, so no row claims a turn may be in flight, and the
  prompt is not lost. A refused submission pushes a terminal state, so the
  console cannot sit on "sending".
- **`EngineAdapter.listModels?` (`src/main/engine/types.ts`)** — optional, the
  same way `scopeToWorkspace` is; the shipped `CodewhaleAdapter` implements it.
- **`StudioErrorCode`** gained `ROUTE_UNSUPPORTED`, which reaches the renderer
  through the existing `envelope` and is rendered as
  `ROUTE_UNSUPPORTED: <message>` by `reportError`.

## Operational repair of the owner's own data

`engine:profile` was corrected **v3 → v4**: model `deepseek-v4-flash-0731` →
`deepseek-flash`, the engine's own configured default, with a `note` naming the
reason. The `settings_versions` rows v1–v4 are all kept, so the change is
auditable and reversible. A pre-repair copy of the database was written to
`~/Library/Application Support/Mona/state/backups/mona.sqlite.pre-route-repair-20261114T202927`.

Deliberately **not** rewritten:

- the two failed turns and their events (they are the evidence for this note);
- the older 23-model catalog cache (a read record, not a claim about today).

The repaired value passes the profile parser's own rule
(`/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/`), and `deepseek-flash` is what the
engine reports as its default and what recent turns completed with.

## Verification

- `test/work-studio.test.ts` — a submit on the saved stale model fails with
  `ROUTE_UNSUPPORTED`, the message names both the saved model and the offered
  ones, **`POST /turns` is never called**, and the snapshot shows no active turn
  with `canSubmit: true`. A second case proves fail-open: with the catalog route
  answering 404 the same profile's turn is **accepted** and posted once. A third
  saves `deepseek-flash` in Settings after the refusal and proves the next submit
  is accepted with `model: "deepseek-flash"` — the remedy works — while the
  session's permission posture is unchanged.
- `test/studio-follow-up.test.ts` — a session whose route was valid when it
  started and whose model the engine then dropped from the roster: the queued
  follow-up stays `queued` with a `not sent` note naming the model, keeps its
  prompt, has no turn id, and only the original turn was ever posted.
- `test/settings-workbench.test.ts` — the pure predicate: listed ⇒ `null`;
  unlisted ⇒ refusal naming model, provider, and the offered roster; `null` and
  empty catalogs ⇒ `null`; a 12-model roster is bounded to 8 with `+4 more`.
- Both new studio tests were mutation-checked: with the guard call replaced by
  `null`, "refuses … and sends no turn" and "applies a model saved in Settings"
  both fail.
- **Against the real engine** — `node scripts/model-route-guard-smoke.mjs`
  (report: `docs/evidence/macos/artifacts/model-route-guard.json`). It starts the
  installed 0.10.2 runtime in a temp workspace and temp state dir, reads the
  roster through the same adapter call the studio makes, applies the same
  predicate, and then runs one short real turn on the repaired route. Result:
  roster `["deepseek-flash", "deepseek-v4-pro"]`; the stale id is refused with
  that message; `deepseek-flash` is not refused; the turn was **accepted and
  completed** with `effective_model: "deepseek-flash"` (12,051 in / 3 out
  tokens). The owner's state store is never opened.
- `npm run ci` 26/26 steps green: format, lint, typecheck, catalog check, native
  builds, 1,169 tests in 104 files, build, and every smoke including
  `smoke:settings`, `smoke:reasoning`, and `smoke:p23`.

## What is not fixed, and why

The engine's roster can list ids the provider rejects — that is exactly what
happened when the owner selected this model. Mona validates against the roster
because it is the engine's only live statement of what it will send; it cannot
know which entries the API accepts, and it will not invent a second allowlist.
The engine has since pruned its roster to the two supported names, so the state
is consistent now. Recorded as an engine observation in `HANDOFF.md` item 130.

## Install status

The installed app is build **168**, which predates this guard. The **data repair
alone restores the owner's turns** — build 168 sends whatever the profile says,
and the profile now names a model the provider accepts. The guard ships on the
next `npm run mac:install`, which needs the owner's terminal for `sudo`.
