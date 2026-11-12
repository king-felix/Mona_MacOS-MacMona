# Handoff — Mona macOS build

**Last checkpoint:** 2026-11-11 (P00, revision 14) — `state.last_verified_commit`
= `179254b` (the commit whose content was verified; later ledger commits add
evidence and precision fixes).
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
  conflicts, interrupted-checkpoint recovery, attempt enforcement, hash index,
  evidence-hash verification, secret/machine-path scan) with **37 passing
  tests**; recovery demonstrated in
  `docs/evidence/macos/artifacts/p00-recovery-simulation.txt` and additional
  ledger probes in `docs/evidence/macos/artifacts/p00-adversarial-probes.txt`.

## Next exact action

Run P01. First action: read spec §2, §6, §7.1, §9, §10, this handoff, and the
endpoint section of `docs/evidence/macos/artifacts/upstream-RUNTIME_API.md`
(pinned at tag v0.10.2, `/v1/*` HTTP/SSE, bearer token, loopback only). Then start
`codewhale app-server --http` on a loopback port with the token supplied through
the environment (never argv), and run the smallest real tool-enabled task in a
throwaway APFS workspace to produce G0 evidence. P01 owns G0/G1/G2, the $2
pilot ceiling, and `docs/codewhale-capabilities-macos.json` qualification.
Do not upgrade the engine and do not change the configured route.

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
