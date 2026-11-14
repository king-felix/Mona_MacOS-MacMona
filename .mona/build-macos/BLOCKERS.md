# Blockers and external prerequisites — Mona macOS build

Open problems that stop a requirement, with the three-attempt count preserved.
Attempt records live in `attempts.jsonl`; this file is the human-readable view
and the place that says exactly what help is needed.

Status: **no blocked problems, and no open external prerequisites** as of
2026-11-14. `attempts.jsonl` is empty: nothing reached three attempts, and no
problem was ever reset. The four external prerequisites this build carried
(signing, a recipient host, the OS floor, and Git on a clean Mac) were closed by
an owner decision recorded in `DECISIONS.md` — D-103 (distribution is local),
D-104 (14.0 declared, 26.x tested), D-105 (Git is a documented dependency).
Each closure says what is *not* proven; none of them raised a requirement.

## External prerequisites — all closed by owner decision (2026-11-14)

There is **no open blocker**. Four prerequisites were closed by decision rather
than by work, and one by the work itself. Nothing was closed by lowering a
requirement: each entry says what is not proven and where that is stated.

### ~~EXT-SIGNING~~ — CLOSED: there is no Apple Developer account (D-103)

- **What was needed:** a Developer ID Application and Installer identity from one
  team, plus a notary credential. Measured repeatedly: `security find-identity -v
  -p codesigning` → **0 valid identities**.
- **How it closed:** the owner decided there is no Apple Developer account and
  none will be obtained. Mona is not distributed; it is built and used on the
  machine that builds it, and anyone else builds from source.
- **What is still true:** `mac:release:preflight` exits 3 naming all three gaps,
  `mac:release` exits 3 without producing an artifact, `mac:verify-release` exits
  2 rather than accepting the ad-hoc build, and 17 release-trust tests pass. The
  pipeline stays implemented and fail-closed. It was not renamed, repurposed or
  weakened to yield a file called "release".
- **What replaces it:** `npm run mac:package:dmg` — a local, ad-hoc-signed disk
  image, verified from its own bytes, whose README says in plain text that macOS
  refuses it on any other Mac.

### ~~EXT-RECIPIENT-HOST~~ — CLOSED: no recipient matrix to run (D-103)

- **What was needed:** a second Apple silicon Mac or a clean VM to run the
  installer through quarantine.
- **Why it closed:** with no shareable artifact there is nothing to hand to a
  recipient. P24 delivered the repeatable harness anyway (`npm run
  mac:recipient`); it settled 9 rows on this host and names the 11 only a real
  recipient could settle, and it stays re-runnable for anyone who does hand a
  build to another machine.

### ~~OPEN-GIT~~ — CLOSED: documented dependency, not a bundled payload (D-105)

- **Measured:** `/usr/bin/git` on a machine without Command Line Tools is Apple's
  118,928-byte stub. Packaged Mona refuses that stub rather than executing it, so
  it never triggers the developer-tools installer.
- **Decision:** Git is not bundled. Core features (launch, edit, terminal, engine
  turns, acceptance sample) need no developer tools; Git **features** require CLT
  or another Git and report themselves unavailable with that reason.
- **Why:** bundling a relocatable Git carries a GPL source-offer obligation the
  owner declined. MAC-004 stays `partial` and the owner guide says which half is
  which.

### ~~OPEN-OSFLOOR~~ — CLOSED: declared at 14.0, tested on 26.5.1 (D-104)

- **Measured:** the payload, the `Distribution` and the preinstall script declare
  and enforce macOS 14.0; the only host that has executed it is 26.5.1.
- **Decision:** the claim is "requires macOS 14.0 or later; tested on macOS
  26.5.1". No 14.x host has run it and nothing claims otherwise.
- **Why this is honest:** asserting a tested 14.0 would be inventing a fact. A
  later 14.x run would upgrade the claim; nothing forbids adding one.

### ~~OPEN-LOCAL-TRUST~~ — CLOSED: the local package is *meant* to be ad-hoc (D-103)

- **Measured:** `security find-identity` → 0 identities; the app and package are
  ad-hoc; Gatekeeper rejects them on another Mac (`spctl`: "rejected, source=no
  usable signature").
- **Decision:** that is the intended tier, not a defect pending signature. It is
  labelled local in the bundle (`MonaBuildChannel`), in the package name, in the
  DMG volume name, in the DMG's README and in the owner guide.

### EXT-DISK — remains operational, not a blocker

- The volume needs roughly 2 GiB free for a package + DMG build; both write to
  `packaging/macos/out/` (gitignored). Last measured: 23 GiB free.

## Needs the Human

One item needs an engine decision. Mona's own side is complete: the route shows
and saves every control the pinned engine can prove, and the residual gap is an
engine API gap recorded below (D-108,
`docs/evidence/macos/artifacts/reasoning-engine-gap.json`).

### ENGINE-REASONING-FACTS — the live catalog drops the ladder it holds, and no surface reports the effective value

**Status: measured on every documented surface; Mona's mitigation shipped.** Two
separate engine gaps were reproduced with the pinned 0.10.2 build. Both were
probed exhaustively; neither can be closed inside Mona without inventing facts.

1. **The live catalog projection drops the reasoning metadata.**
   `GET /v1/providers/{id}/models` answers `reasoning_effort: "unknown"`,
   `reasoning_effort_levels: []`, `reasoning_effort_source: null`,
   `facts.reasoning: null`, `facts.reasoning_options: []`, and
   `facts.canonical_model_id: null` for `deepseek/deepseek-flash` whenever a live
   roster entry exists — even though the engine's own Models.dev cache publishes
   `{"type":"toggle"}` and `low|high|max` for that exact model, and the same
   binary publishes the ladder through the same route when the roster cache is
   absent. A successful `POST /v1/providers/deepseek/models/refresh` narrows the
   roster and still reports no ladder.
   **Exact cause:** the live roster row carries no canonical model id, so the
   Models.dev join cannot run. The metadata is present; the projection skips it.
   **Smallest engine change that closes it:** join the canonical id (or the
   Models.dev entry) when live roster rows are used, so
   `reasoning_effort`/`_levels`/`_source` describe the model rather than the
   transport.
2. **No surface reports the effective reasoning setting.**
   One tool-free turn with an explicit `low` completed; the thread record stored
   `reasoning_effort: "low"`, and every documented read surface was inspected:
   thread record and turns, `turn.completed`, `turn.provider_request`, the turn
   receipt (API and `codewhale receipts --format json`), thread usage, thread
   context, `/v1/sessions`, `codewhale metrics` (text and `--json`), the settings
   schema, and the model catalog. None reports an effective reasoning value.
   `TurnRecord` reports effective provider, model, and billing surface only; its
   `modelRequestDiagnostics` carries retry counts. The identifier
   `effective_reasoning_effort` exists in the binary and in a static field-name
   descriptor, but no live value is produced or exposed.
   **Smallest engine change that closes it:** add `effective_reasoning_effort`
   (and, where known, the wire control it mapped to) to `TurnRecord`, which the
   thread, turn, and receipt routes already project.

**What Mona does instead:** recovers the ladder from the engine's own non-secret
metadata for the exact model, labels it as metadata (never as a live catalog
answer), uses it only for a first-party route, offers only the values it
publishes, keeps validation fail-closed, and shows the effective value as
unknown. Recorded as D-108 with the full probe matrix in
`docs/evidence/macos/artifacts/reasoning-engine-gap.json`.

**The change request is written and ready to send:**
`docs/evidence/macos/engine-change-request-reasoning.md` — both defects, the
reproduction, the smallest change for each, and the acceptance tests.

**Mona's side is already done (D-109, D-110).** The reasoning setting is now
declared `auto`, stored and sent explicitly, and shown read-only, so the request
is unambiguous without any engine change. The worked-around path retires itself:
the moment an engine reports `effective_reasoning_effort`, Mona displays it as an
effective value with its source and turn, and a live `supported` catalog answer
already outranks the metadata fallback. Both are implemented and tested against a
simulated engine; on 0.10.2 the live smoke asserts the value stays `unknown`, so
nothing is claimed early.

**What is needed from Victor:** send the change request upstream, or accept the
workaround as the permanent shape. An engine upgrade was weighed and **not**
taken: the pin is version *and* commit, re-pinning invalidates 28 prompts of
evidence, the installed engine cannot self-update in place, and nothing proves a
later build fixes either gap. Provider, endpoint, model, and engine build are
unchanged.

## Closed problems

### ~~CI-LIFECYCLE-LOCK~~ — CLOSED: quit the app; the step passed unchanged

- **Measured twice:** with `/Applications/Mona.app` running, `smoke:lifecycle`
  failed because the app holds Electron's single-instance lock, so the smoke's
  instance called `app.exit(0)` before writing `ready`/`crash.json`.
- **Fixed by the owner, not the code:** Mona was quit, and the step then passed
  **27/27** with no change to it. `npm run ci` is **25 of 25** green
  (`docs/evidence/macos/artifacts/p23-lifecycle-smoke.json`, `ok: true`).
- **What stays true:** the smoke still requires the app to be quit; its own
  failure message says so, and CI runs it last. No assertion was modified,
  reordered, or skipped to reach the green run.
