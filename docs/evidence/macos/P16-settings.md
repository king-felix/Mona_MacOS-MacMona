# P16 — Providers, models, permissions, and effective settings

Status: **completed** · Date: 2026-11-12 · Requirements: MONA-020,
MONA-008 (contribution), MAC-003 (contribution)

## What was built

- `src/shared/contracts/settings.ts` — provider/model catalog views, credential
  classes, saved-route record, requested-versus-effective observation, routing
  policy, engine selection, diagnostics, and change receipts.
- `src/main/engine/wire.ts` + `adapter.ts` — typed reads and writes over the
  pinned runtime: `GET /v1/providers`, `GET /v1/providers/{id}/models`,
  `POST /v1/providers/{id}/models/refresh`, `GET /v1/config`,
  `POST /v1/config`, `POST /v1/config/reload`,
  `POST /v1/providers/{id}/switch`, and `PUT`/`DELETE
  /v1/providers/{id}/key` (session and durable scopes).
- `src/main/work/settings.ts` — `RouteWorkbench`:
  - saved new-thread default with compare-and-swap revisions;
  - route validation against the live provider and model catalogs, including
    model-published reasoning levels only;
  - separate engine-default switch with config backup, sha256 revision,
    stale-read refusal, post-write observation, and a written receipt;
  - credential pass-through that refuses an engine-owned route;
  - redacted diagnostics from `codewhale doctor --json` and
    `codewhale config doctor`;
  - engine-selection display (bundled versus explicit `CODEWHALE_BIN`).
- `src/main/engine/runtime-process.ts` — an external engine path must be
  absolute; a bare PATH name is refused with guidance.
- `src/renderer/shell/RouteSettings.tsx` — Settings → **Providers & route**:
  saved default, engine route, observed turn route, credential state and
  entry, locked routing policy, diagnostics with export, engine selection.
- IPC: `settings:snapshot`, `settings:models`, `settings:save-default`,
  `settings:reset-default`, `settings:switch-engine`,
  `settings:set-credential`, `settings:clear-credential`,
  `settings:diagnostics`, `settings:export-diagnostics`. All strict objects.

## Acceptance evidence

| Acceptance | Evidence |
|---|---|
| Changing a new-thread default leaves an active turn alone | `test/settings-workbench.test.ts` "saves a validated default and leaves the active session's observed route alone"; the observed receipt model stays `deepseek-flash` while the saved default changes, and the engine switch mock is never called |
| Missing key and invalid endpoint are distinct | provider `credentialState`/`credentialSource` remain separate from `endpointStatus` (`configured`/`default`/`malformed`/`unknown`); `endpointAuthority` drops userinfo, path, query, and fragment |
| Effective model matches the receipt | `SettingsSnapshot.observed` reads only `StudioSnapshot.profile.effective`; a `usedFallback` receipt renders a danger callout rather than a success |
| Unsupported reasoning is not sent | `validateRoute` refuses a level not in `reasoning_effort_levels` and refuses any level on a model whose state is `unsupported`/`unknown`; the live smoke asserts a refused level leaves the stored route unchanged |
| Route failure stays on the configured route | `test/engine-adapter.test.ts` "makes one submission attempt and never switches provider or model": one `/turns` POST, no `/switch` call |
| Mona stores no credential | the cached engine route holds only scheme + host (regression test "never caches a credential-bearing base URL"); catalog caches hold classes; the only credential-bearing copy is the 0600 config backup described below |
| Exported diagnostics contain no secrets | redaction test covers home path, `sk-` keys, bearer tokens, env values, URL userinfo, and idempotence; the live smoke scans the whole report |
| Configuration changes have backup/revision evidence | live smoke: stale hash refused with the document byte-identical; accepted switch writes a backup whose sha256 equals the pre-write document and reports `revisionBefore`/`revisionAfter` |

## Verification

- Full suite: **495 tests in 52 files** (`p16`/`p17` added 25); local CI green
  including `smoke:settings`: `docs/evidence/macos/artifacts/p16-p17-ci.txt`.
- Live smoke `npm run smoke:settings`: **22/22 checks**, isolated
  `HOME`/`CODEWHALE_HOME`, no turn started:
  `docs/evidence/macos/artifacts/p16-settings-smoke.json`.
  - live provider/model catalogs read;
  - `deepseek-flash` publishes `low|high|max`;
  - saved default persisted at revision 1;
  - `medium` reasoning refused and the stored route unchanged;
  - stale saved-default revision and stale config hash refused;
  - backup sha256 equals the pre-write document; unknown TOML table preserved;
  - fake session key accepted without appearing in the receipt, then cleared;
  - diagnostics redacted 53 occurrences, no home path or fixture secret
    survives.
- Shell smoke: **101/101 checks** including `settings_route_offline`; captures
  `docs/evidence/macos/artifacts/p16-settings-route.png` in the disconnected
  state, showing the offline explanation, the locked routing policy, and no
  invented route.

## Credential-adjacent storage (explicit)

Two local files can contain credential-shaped material, both intentionally and
both outside the renderer:

1. **The engine config backup.** A route switch copies the engine's own
   `config.toml` (which may contain a literal `api_key`) plus a manifest into
   the user's product backup directory with mode `0600`. It exists so a change
   is recoverable. It is never served to the renderer and never exported as
   diagnostics.
2. **The engine's own store.** Durable keys live where the engine put them.

Mona's caches do **not** duplicate a URL or a key: the engine-route cache keeps
only `scheme://host` plus the endpoint classification, and the provider cache
keeps credential *classes*. A reviewer found the earlier cache wrote the raw
`base_url`; it now stores the authority only, with a regression test.

## Known limits

- A saved default needs a live engine to validate; offline saves are refused
  rather than persisted unverified.
- The engine switch route accepts a provider kind + model, not a named custom
  `model_provider_id`; a named custom route can be saved as the new-thread
  default but not selected as the engine default here.
- The engine's config document may be normalized on first route resolution.
  Revisions are therefore read after catalog reads in a snapshot and rechecked
  before a write.
- Provider quota/billing balances are still unknown; no balance is derived.
- Engine-internal route fallback is visible only through a turn receipt; Mona's
  own code path has no fallback.
- Signed-recipient Keychain/upgrade behavior remains P22/P24.
