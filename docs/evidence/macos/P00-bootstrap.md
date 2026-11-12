# P00 — Bootstrap the project and establish ground truth

**Status:** completed
**Checkpoint commit:** `179254b` — bootstrap content; this evidence file and the completed ledger state are recorded in the follow-up ledger commit.
**Date:** 2026-11-11 (local) / 2026-11-12 UTC
**Machine:** Victor's MacBook Air, Mac15,12 (Apple M3), macOS 26.5.1 (25F80), arm64
**Specification:** `Mona_macOS_Project.md` SHA-256
`d1c02941151c71912bc3e9c8b2509612298d54e05e0bf16fe933b9bd93e3e028`;
`Mona_macOS_PROMPTS.md` SHA-256
`be447f8253fe9c58443c14da3d846ff4d56c2810eb405651b12f8b56cc3805f8`.

## What was delivered

1. **Host and toolchain inventory** — `docs/discovery-macos.md` and raw output
   in `artifacts/host-inventory.txt`. Apple M3 native (`proc_translated = 0`),
   no Rosetta dependency, APFS case-insensitive, ~39 GiB free, CLT-only
   developer tools (no full Xcode), Node 26.13.0, npm 11.20.0, Git 2.39.3.
2. **Engine identity** — `artifacts/engine-inventory.txt`. Codewhale 0.10.2
   (`ff466b2ed0bf`), npm wrapper plus a self-contained thin arm64 Rust binary,
   SHA-256 `da0229610647f1cc2dd14c4227b333a92ea276a49f5d4d79160fa19e515e590d`,
   ad-hoc signed, no TeamIdentifier. Help surfaces captured for the top-level
   CLI, `app-server`, and twelve subcommands; the full route catalog is saved as
   `artifacts/codewhale-route-catalog.json`.
3. **Configured route (redacted)** — provider `deepseek`, model
   `deepseek-flash`, `auth_mode = api_key`, no base-URL override;
   `codewhale config doctor` reports "credentials and endpoints clean"; model
   resolution returns the same model with `used_fallback: false` and 1M context /
   384k output limits. No credential value was read or printed.
4. **Operating contract** — `AGENTS.md`, preserving the specification's O1–O5
   obligations, the three-attempt rule, ledger separation, and command pointers.
   No prior agent instruction file existed, so nothing was overwritten.
5. **Durable ledger** — `.mona/build-macos/state.json` (atomic, revision 2,
   validated), `attempts.jsonl`, `HANDOFF.md`, `DECISIONS.md` (D-001…D-008),
   `BLOCKERS.md`.
6. **Traceability registry** — `docs/requirements-macos.json`, generated
   deterministically from the two documents: 28 prompts P00–P27, 30 MONA and 8
   MAC requirements, explicit prerequisite edges, topological order, P27 marked
   as final acceptance of all requirements. Every referenced ID exists; no
   cycles; no unassigned requirement.
7. **Checkpoint utility** — `tools/monabuild` (Node standard library only):
   JSON-Schema-subset validation, atomic replacement with backup, single-writer
   lock, revision-conflict refusal, interrupted-checkpoint recovery, attempt
   ledger with code-enforced three-attempt limit, hash index, secret scan.
   37 tests, all passing (`artifacts/p00-test-run.txt` records the run at 36;
   the git-recovery test was added after that capture).
8. **Discovery report and capability inventory structure** —
   `docs/discovery-macos.md`, `docs/codewhale-capabilities-macos.json`
   (structure plus 43 observed commands and 5 transports, all explicitly
   unqualified; P01 owns qualification). Upstream overlap noted: this release
   ships `codewhale web` and `rc` over the same Runtime API Mona plans to use.
9. **Signing inventory** — 0 codesigning identities; `notarytool`, `stapler`,
   `codesign`, `pkgbuild`, `productbuild`, `spctl` present; assessments enabled.
   Recorded as the P22 prerequisite in `BLOCKERS.md`.

## Acceptance checks

- **Both specs indexed and hashed** — `requirement-macos.json` `spec.files`
  hashes equal `shasum -a 256` of the documents; `monabuild validate` verifies
  them on every run. ✅
- **All prompt IDs and requirements present** — 28 prompts, 38 requirement IDs,
  generated from the documents (not transcribed); `monabuild requirements check`
  and the test suite assert the counts. ✅
- **Dependency graph valid** — topological sort succeeds; prerequisite order
  matches the prompt map; missing/unknown IDs, self-dependencies, cycles, and
  out-of-order edges are rejected by tests with negative fixtures. ✅
- **Simulated interrupted checkpoint preserves recoverable state** — see
  `artifacts/p00-recovery-simulation.txt`: after a truncated `state.json` and a
  leftover uncommitted temp file, `monabuild recover` restored the committed
  revision from `state.json.bak`, preserved the damaged copy, discarded the
  never-committed temp file, and `validate` then passed. A fresh clone has no
  local `.bak`, so `recover` also accepts the committed blob at `HEAD`; covered by
  a test that truncates the state in a fresh repository and restores revision 4.
  ✅
- **No secret committed** — `monabuild secrets` scans every tracked file for
  key/token/password patterns and for this machine's absolute home path; the
  redacted config dump is the only provider configuration stored. It also treats
  self-evident documentation placeholders (`YOUR_..._API_KEY`) as documentation,
  with positive and negative tests, and never prints a matched value. ✅
- **Actual engine/platform identity recorded or explicitly unavailable** — both
  recorded with digests and captured output. ✅

## Clean-room verification of the committed tree

`artifacts/p00-cleanroom-verification.txt` was captured from a fresh `git clone`
of the committed tree (no working-tree leftovers, no local `.bak`), and shows:
37/37 tests pass; `validate` reports `ok: true` with no errors, no warnings, and
a clean index; the registry has 28 prompts, 30 MONA + 8 MAC requirements, order
P00 → P27, zero validation errors, zero unassigned requirements; the ledger
reads revision 16 with P00 completed and P01 next; truncating the committed
state and running `recover` restored it from the committed blob while preserving
the damaged copy; the fourth no-progress attempt exits 3; only
`.mona/build-macos` exists; and the secret/machine-path scan is clean over 48
tracked files.

## Additional adversarial probes

`artifacts/p00-adversarial-probes.txt` runs five probes against a disposable
copy: specification hash drift is detected; the registry regenerates while
preserving requirement status; a concurrent writer is refused by the
single-writer lock; a stale lock from a dead pid is reclaimed; and a fourth
no-progress attempt is refused until `reopen` records a decision reference.

## Test evidence

```
$ node --test tools/monabuild/test/
ℹ tests 37
ℹ pass 37
ℹ fail 0
```

Captured verbatim in `artifacts/p00-test-run.txt` (36 at capture time; the
git-recovery regression test was added immediately after and is visible in the
suite, not in that older capture). The count grew during P00 as
review findings turned into regression tests (schema, store, attempts,
requirements, secrets, inventory); the artifact, not this prose, is the record.

`inventory.test.mjs` additionally pins the capability inventory to the captured
help artifact (same command count, 5 transports, nothing claimed supported), so
the discovery report cannot drift from its own evidence without a failing test.

Coverage of high-risk boundaries: schema rejection of unknown/missing fields,
revision conflicts, invalid patches, atomic replacement, stale-lock and temp-file
handling, backup restore, attempt blocking across a fresh read (session
boundary), material-progress reset, reopen requiring a human decision,
partial-line recovery, requirement parsing and DAG validation, stale-hash
detection.

## Validation output

Captured verbatim in `artifacts/p00-validation.txt`:
`node tools/monabuild/cli.mjs validate` → `"ok": true, "errors": []`,
`"warnings": []`, index clean; `requirements check` → 28 prompts, 38
requirements, no errors. The earlier drift-detection failure case is in
`artifacts/p00-adversarial-probes.txt`.

## Limitations recorded, not hidden

- Capability coverage is a structure with zero qualified capabilities; nothing
  is claimed supported until P01 tests it.
- Code signing is unavailable (0 identities). Local unsigned builds are
  possible; the signed/notarized installer is a P22 deliverable.
- No full Xcode. A later Xcode-only requirement must be recorded as a build
  prerequisite rather than worked around.
- The engine's `--http` transport is advertised, not qualified. P01 must prove
  auth, events, interrupt, resume, and cost behavior.
- Git repository is local only; no remote configured or invented. Repo-local
  commit identity `Mona Build <mona-build@localhost>` was set because this
  machine has no global Git identity.

## Next prompt

**P01 — Prove headless integration and preserve the economics.** First action:
read spec §2, §6, §7.1, §9, §10 and `.mona/build-macos/HANDOFF.md`, then start
the pinned engine's `app-server --http` on loopback with a token from the
environment and run the smallest real tool-enabled task to produce G0 evidence,
within the declared $2 pilot ceiling.
