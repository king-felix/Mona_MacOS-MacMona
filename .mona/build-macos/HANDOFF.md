# Handoff — Mona macOS build

**Last checkpoint:** 2026-11-11 (P00, revision 7) — checkpoint commit `179254b`
**Current prompt:** P00 — completed
**Next eligible prompt:** P01 — Prove headless integration and preserve the economics

## Where the build stands

P00 created a trustworthy native Mac workspace and the durable continuation
system. No product UI or runtime code exists yet, by design.

Verified in this session:

- Host: Mac15,12 (Apple M3, 8 cores, 16 GiB), macOS 26.5.1 (25F80), native
  arm64, `sysctl.proc_translated = 0`, APFS case-insensitive, ~39 GiB free.
- CLT-only toolchain (Swift 5.10, clang 15, SDK 14.4); no full Xcode. Node
  26.13.0, npm 11.20.0, Git 2.39.3, Homebrew 7.0.12.
- Engine: Codewhale 0.10.2 (`ff466b2ed0bf`), native arm64 binary SHA-256
  `da0229610647f1cc2dd14c4227b333a92ea276a49f5d4d79160fa19e515e590d`,
  ad-hoc signed. Route: provider `deepseek`, model `deepseek-flash`, resolves
  without fallback; credentials clean per `codewhale config doctor`.
- Signing: 0 Developer ID identities. Logged for P22, not a P00 blocker.
- Requirements: `docs/requirements-macos.json` has P00–P27, MONA-001..030,
  MAC-001..008, valid dependency order, no cycles.
- Ledger: `tools/monabuild` (schema validation, atomic writes, revision
  conflicts, recovery, attempt enforcement, hash index, secret scan) with 27
  passing tests; interrupted-checkpoint recovery demonstrated in
  `docs/evidence/macos/artifacts/p00-recovery-simulation.txt`.

## Next exact action

Run P01: read spec §2, §6, §7.1, §9, §10 and this handoff; inspect
`docs/evidence/macos/artifacts/codewhale-app-server-help.txt`; start the
installed engine with `app-server --http` on a loopback port with a token from
the environment, discover the documented Runtime API contract from the pinned
sources, then run the smallest cheap tool-enabled task and record tokens/events.
P01 owns the G0/G1/G2 evidence and the $2 cost-pilot ceiling.

## Open blockers

None. External prerequisites: Developer ID signing credentials (P22) and, only
if a later step requires it, full Xcode. See `BLOCKERS.md`.

## Key files

- `.mona/build-macos/state.json` — prompt status (revision-checked).
- `.mona/build-macos/attempts.jsonl` — attempt ledger.
- `.mona/build-macos/DECISIONS.md` — D-001…D-008.
- `docs/discovery-macos.md` — measured host/engine facts.
- `docs/codewhale-capabilities-macos.json` — inventory structure (P01 fills it).
- `docs/evidence/macos/P00-bootstrap.md` — P00 evidence.
- `AGENTS.md` — operating contract and commands.
