# Handoff — Mona macOS build

**Last checkpoint:** 2026-11-11 (P00, revision 18) · verified content commit
`179254b` · later commits add evidence, tests, and precision fixes
**Current prompt:** P00 — **completed**
**Next eligible prompt:** P01 — Prove headless integration and preserve the economics

## Where the build stands

P00 is complete: a trustworthy native Mac workspace and a durable continuation
system exist. No product UI or runtime integration exists yet, by design.

Verified (all re-checked from a fresh `git clone` —
`docs/evidence/macos/artifacts/p00-cleanroom-verification.txt`):

- **Host:** Mac15,12 (Apple M3, 8 cores, 16 GiB), macOS 26.5.1 (25F80), native
  arm64, `sysctl.proc_translated = 0`, APFS case-insensitive, ~39 GiB free.
- **Toolchain:** CLT only (Swift 5.10, clang 15, SDK 14.4) — **no full Xcode**;
  Node 26.13.0, npm 11.20.0, Git 2.39.3, Homebrew 7.0.12.
- **Engine:** Codewhale 0.10.2 (`ff466b2ed0bf`), npm wrapper plus a
  self-contained thin arm64 Rust binary, SHA-256
  `da0229610647f1cc2dd14c4227b333a92ea276a49f5d4d79160fa19e515e590d`,
  **ad-hoc signed, no TeamIdentifier**. GitHub tag `v0.10.2` resolves to the same
  commit, and pinned RUNTIME_API/ARCHITECTURE/PROVIDERS docs are captured.
- **Route (redacted):** provider `deepseek`, model `deepseek-flash`, no base-URL
  override, `used_fallback: false`; catalog endpoint
  `https://api.deepseek.com/beta`, wire `model-aware`, key var
  `DEEPSEEK_API_KEY`. `codewhale config doctor` reports credentials clean. No
  credential value was read or printed.
- **Signing:** 0 Developer ID identities → P22 prerequisite, not a P00 blocker.
- **Registry:** 28 prompts P00–P27, 30 MONA + 8 MAC requirements, validated
  acyclic order P00 → P27, no unassigned requirement, P27 marked final
  acceptance.
- **Ledger:** `tools/monabuild` — 37 passing tests; schema validation, atomic
  replacement, single-writer lock, revision-conflict refusal, recovery from
  `.bak` or the committed blob, evidence-hash verification, code-enforced
  three-attempt rule, hash index, secret and machine-path scan.

## Next exact action (P01)

Read spec §2, §6, §7.1, §9, §10; this handoff; and the endpoint/auth sections of
`docs/evidence/macos/artifacts/upstream-RUNTIME_API.md` (pinned at v0.10.2).
Then:

1. Start `codewhale app-server --http` on loopback with the bearer token supplied
   through the environment (`CODEWHALE_RUNTIME_TOKEN`), never argv.
2. Probe the documented `/v1/*` routes; verify the port belongs to *our* child
   (process identity), not merely that a port answers.
3. Run one small real tool-enabled task in a throwaway APFS workspace: create a
   file, run its test, observe events, effective model/provider, Full Access,
   history, and resume. Interrupt a harmless long-running command and verify
   cancellation.
4. Begin the paired cost pilot under the **$2 ceiling** declared in the spec.
5. Populate `docs/codewhale-capabilities-macos.json` with qualified rows and
   write `docs/evidence/macos/P01-feasibility.md` with the G0/G1/G2 verdicts.

Do not upgrade the engine, do not change the configured route or endpoint, and
do not start UI work — P02 depends on the P01 decision.

## Open blockers

None. External prerequisites: Developer ID signing credentials (P22); full Xcode
only if a later step genuinely needs `.xcodeproj`/`xcodebuild`. See
`BLOCKERS.md`. `attempts.jsonl` is intentionally empty: nothing failed three
times.

## Key files

- `.mona/build-macos/state.json` — prompt status (revision-checked, rev 18).
- `.mona/build-macos/attempts.jsonl` — attempt ledger (empty; enforced in code).
- `.mona/build-macos/DECISIONS.md` — D-001…D-009.
- `.mona/build-macos/BLOCKERS.md` — external prerequisites and help needed.
- `docs/discovery-macos.md` — measured host/engine facts.
- `docs/requirements-macos.json` — generated traceability (never hand-edit).
- `docs/codewhale-capabilities-macos.json` — inventory structure, 0 qualified.
- `docs/evidence/macos/P00-bootstrap.md` — P00 evidence index.
- `AGENTS.md` — operating contract and commands.
