# Mona macOS discovery report

Collected 2026-11-11 on Victor's Mac during P00. Raw command output lives in
`docs/evidence/macos/artifacts/`. No inference call was made; no credential
value was read, printed, or stored.

## Host

- **Model:** Mac15,12 (Apple M3, 8 cores, 16 GiB). `machdep.cpu.brand_string`
  = `Apple M3`.
- **OS:** macOS 26.5.1 (build 25F80), Darwin 25.5.0, native `arm64`.
  `sysctl.proc_translated` = `0`, so the inspector itself ran natively.
  Rosetta 2 exists at `/usr/libexec/rosetta` but is not needed and must not be
  required by the product.
- **Filesystem:** APFS, case-insensitive (probe: `AlphaCase` resolves as
  `alphacase`). Project path is a local Data-volume path, not iCloud Drive.
  Case-sensitive APFS and external volumes stay unqualified until tested.
- **Free space:** ~39 GiB at capture time — enough for Node modules, Electron,
  and an arm64 packaging run, but not generous; large binary caches should stay
  bounded.

## Developer toolchain (build prerequisites, not recipient requirements)

- `xcode-select -p` → `/Library/Developer/CommandLineTools`. **Full Xcode is not
  installed**; `xcodebuild` therefore fails. The CLT SDK reports 14.4 with
  Swift 5.10 and Apple clang 15.0.0, all arm64.
- Available: `codesign`, `pkgbuild`, `productbuild`, `stapler`, `notarytool`,
  `spctl`, `git` 2.39.3, `node` v26.13.0, `npm` 11.20.0, `python3` 3.9.6,
  `ruby` 2.6.10, Homebrew 7.0.12, GNU Make 3.81.
- Implication: Electron packaging, Swift compilation of the native Services
  helper (`swiftc` from CLT), signing, and `pkgbuild`/`productbuild` are
  possible now. If a later step needs a full Xcode project (for example
  `.xcodeproj`-based packaging or an app extension target), that becomes a
  named build prerequisite — not something to fake with ad-hoc scripts.
- The CLT SDK (14.4) is older than the running OS (26.5.1). Native helpers must
  set an explicit deployment target and be tested on this OS; the minimum macOS
  release for the product is still to be chosen at P02/P21 against the pinned
  Electron and engine, and must not be invented here.

## Engine: installed Codewhale

- **Command:** `/opt/homebrew/bin/codewhale` → npm wrapper
  `/opt/homebrew/lib/node_modules/codewhale/bin/codewhale.js`, version
  **0.10.2 (ff466b2ed0bf)**, installed via Homebrew's global npm prefix.
- **Native binary:** `bin/downloads/codewhale`, Mach-O thin **arm64**, 90,300,464
  bytes, SHA-256
  `da0229610647f1cc2dd14c4227b333a92ea276a49f5d4d79160fa19e515e590d`.
  It is only **ad-hoc/linker-signed** (`flags=adhoc,linker-signed`, no
  TeamIdentifier). Bundling it in a signed installer will require re-signing
  inside-out at P21/P22; original and packaged digests must both be recorded.
- The binary is self-contained (Rust). The `node` wrapper only resolves and
  spawns it, so a packaged Mona can launch the native binary directly without
  requiring Node on the recipient machine. This is a P01/P21 verification item,
  not yet a proven packaging path.
- Other PATH entries: none. No conflicting second installation was found.
- **Transports advertised by this build:** `app-server --http` (canonical
  Runtime API `/v1/*`, loopback 127.0.0.1:7878, bearer token via
  `CODEWHALE_RUNTIME_TOKEN`), `--stdio` and `--socket` compatibility JSON-RPC
  control transports, `serve`, `web` (loopback browser client with one-time
  bootstrap capability). `--http` is the primary candidate for the Mona adapter;
  its actual operation coverage must be qualified at P01, not assumed.
- **Observed CLI surface:** 33 top-level commands including `run`, `exec`,
  `sessions`, `resume`, `fork`, `receipts`, `thread`, `fleet`, `workflow`,
  `lane`, `mcp`, `features`, `providers`, `config`, `model`, `sandbox`,
  `app-server`, `serve`, `web`, `metrics`, `update`. Feature flags observed:
  `shell_tool`, `subagents`, `web_search`, `apply_patch`, `mcp`, `exec_policy`,
  `verify_tool`, `code_mode` enabled; `vision_model` and several `*_host`
  features disabled. P01 converts this into the capability ledger.

## Configured route (redacted inspection)

- `codewhale config doctor` → "credentials and endpoints clean".
- `codewhale config dump` (tool-redacted) → provider `deepseek`, model
  `deepseek-flash`, `auth_mode = "api_key"`, no custom `base_url` override,
  `reasoning_effort = "auto"`. The API key itself was never read.
- `codewhale model resolve deepseek-flash` → requested and resolved
  `deepseek-flash`, provider `deepseek`, `used_fallback: false`, context limit
  1,000,000 / output limit 384,000, with streaming, native tool calls, prompt
  caching, and reasoning reported as supported.
- **Endpoint:** the config sets no `base_url`, so the route catalog default
  applies: `https://api.deepseek.com/beta`, wire protocol `model-aware`, key
  variable `DEEPSEEK_API_KEY` (`artifacts/codewhale-route-catalog.json`). This is
  the catalog default, not an observed request; P01 must confirm the effective
  endpoint from redacted runtime evidence rather than assuming it.
- **P01 live-test prerequisite:** a real tool-enabled task must be run to prove
  G0. Credentials are present and reported clean, so the live test is eligible;
  it was deliberately not run during P00 (no inference in bootstrap, and P01
  owns the paired cost pilot).

## Signing and distribution posture

- `security find-identity -v -p codesigning` → **0 valid identities**. No
  Developer ID Application or Developer ID Installer identity is present.
- `notarytool` and `stapler` exist; `spctl` assessments are enabled; Gatekeeper
  is not disabled.
- Consequence: local unsigned/ad-hoc dev builds are possible now; the signed,
  notarized, stapled `.pkg` cannot be produced until Victor provides an Apple
  Developer Program membership and Developer ID identities plus notarization
  credentials. Logged for **P22**, explicitly not a P00 blocker.

## Upstream desktop overlap (honest note)

This engine release ships its own local browser client (`codewhale web`) and a
`rc` command that hands an interactive session to the Codewhale web app, both
over the same Runtime API Mona intends to use. The installed npm package does
not expose a desktop binary; the specification's claim of a desktop client in
development cannot be verified from the installed artifact. P01 must re-assess
this overlap before UI investment, per spec §2.3. Nothing here justifies forking
the engine.

## Build-machine prerequisites versus recipient prerequisites

- **Build machine needs:** CLT (present), Node/npm (present), Homebrew only if
  a build tool is genuinely missing, signing identities and notarization
  credentials (absent), and for any Xcode-project-based step, full Xcode
  (absent — flag early).
- **Recipient needs (target for MAC-004/MAC-007):** no Homebrew, Node, Rust,
  Python, Xcode, or separate Codewhale install; double-click `.pkg`, open
  `Mona.app`, use their own provider key. The bundled arm64 engine plus the
  packaged Electron runtime must make this true; P21/P24 prove it.

## Facts still unverified (owned by later prompts)

- Runtime API operation coverage, authentication flow, event/cursor semantics,
  interrupt and resume behavior — P01/P03.
- Safe multi-runtime coexistence against the shared store — P01/P04.
- Cost parity and zero-idle-inference proof — P01/P12.
- Minimum macOS version supported by the pinned Electron + engine + SDK —
  P02/P21.
- Finder Services discovery on macOS 26.5 with a signed standalone service —
  P09/P22.
- Clean-recipient behavior with quarantine and no developer tools — P24.
