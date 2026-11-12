# P02 — Desktop foundation and strict contracts

**Date:** 2026-11-11 · **Host:** Mac15,12, macOS 26.5.1, native arm64 ·
**Node/npm:** 26.13.0 / 11.20.0 · **Electron:** 45.3.0 (arm64, embedded Node
24.22.2) · **Status:** complete

## Result

A small Electron/React/TypeScript project exists with a real security boundary,
a strict typed IPC bridge, shared Mona contracts, labeled fixtures, a native
menu with Services, per-user paths, and GUI-launch tool discovery. The window
loads a local renderer, shows the actual app version and placeholder navigation,
and makes **zero inference calls**. No runtime process is owned or spawned.

Stack decisions: `docs/decisions/ADR-001-desktop-stack.md`. IPC boundary:
`docs/decisions/ADR-002-ipc-boundary.md`. Durable ledger entry: D-011.

## Structure

```
src/main/        main process: window, security, IPC, menu, paths, discovery
src/preload/     one narrow contextBridge (3 methods)
src/renderer/    React shell (static build; no Node, no network)
src/shared/contracts/    Mona types: branded IDs, project/task, engine profile,
                         events, submission state, usage, errors, bridge
src/shared/engine-wire/  upstream Codewhale shapes (adapter-only)
src/shared/fixtures/     labeled test data, never a production fallback
native/macos-services/   Finder Service location (P09)
native/macos-supervisor/ process ownership location (P04)
packaging/macos/         installer assets location (P21/P22)
scripts/ci.mjs           local CI-equivalent
scripts/smoke.mjs        real Electron launch + observed security checks
```

## Acceptance evidence

Commands: `npm ci`, `npm run ci`, `npm run smoke`. Raw output:
`artifacts/p02-clean-install.txt`, `artifacts/p02-ci.txt`,
`artifacts/p02-smoke.json`, `artifacts/p02-bundle.txt`.

- **Clean install/build/test from documented commands:** PASS. `npm ci` from an
  empty `node_modules` and `dist` fetched the pinned arm64 Electron binary and
  installed 147 packages. `npm run ci` then passed format check, lint,
  typecheck, 44 tests, and build.
- **No secrets in built renderer:** PASS. CI scanned all 3 renderer files
  (226,270 bytes) for provider-key patterns, token env names, private keys,
  `node_modules/` paths, source maps, and a live env secret if present — 0
  findings. Renderer source also cannot reference `process.env` (boundary test).
- **Unrecognized/malformed IPC rejected:** PASS. 5 tests cover unknown channel,
  unknown fields, non-object payload, path-like tool names, oversized lists, and
  the strict empty payload. The smoke run initially caught a real defect: the
  no-argument preload calls sent `undefined`; they now send `{}`, and the
  contract rejects both shapes if wrong.
- **Remote navigation and privileged popups refused:** PASS. Navigation tests
  reject `https://`, `http://`, `javascript:`, `/etc/passwd`, a sibling
  root-prefix path, and `../` traversal. In the real window,
  `window.open('https://example.com')` returned `null`.
- **Schema validation covers wrong IDs and unknown fields:** PASS. Branded IDs
  reject another entity's prefix and bare strings; Mona-owned inputs are strict;
  event envelopes keep unknown event kinds and extra upstream fields for
  diagnostics. 44 tests total.
- **Baseline bundle and process footprint:** 226,270 bytes renderer
  (222,601 JS + 2,989 CSS + 680 HTML), 84 KB compiled main/preload. One smoke
  sample: Browser 166,928 KB + GPU 84,864 KB + Utility 48,352 KB + Tab
  108,048 KB = **408,192 KB** working set across 4 Electron processes.
- **Window loads locally with version and placeholder navigation:** PASS.
  Smoke observed `document.title = "Mona"`, ready state, app version
  `0.1.0-p02` rendered, and nav items Projects/Work/Cost/Settings.
- **Zero inference:** PASS by construction and observation. CSP `connect-src
  'none'`; the renderer calls only three local IPC channels; no Codewhale process
  is started; the status card shows 0 calls and cost Unknown.
- **Native menu/Services, traffic lights, close-versus-quit:** PASS. The menu
  contains the `services` and `quit` roles; `titleBarStyle: "hiddenInset"` with
  explicit traffic-light position; a unit test pins "last window closed does not
  quit on darwin", and `activate` recreates the window.
- **GUI-launch tool discovery and per-user paths:** PASS. Smoke launched with
  `PATH=/usr/bin:/bin` and still found `/opt/homebrew/bin/codewhale` via the
  well-known fallback. Paths resolved to `~/Library/Application Support/Mona`,
  `~/Library/Caches/Mona`, and `~/Library/Logs/Mona`; state and projects
  subdirectories are created.
- **Fixtures:** 8 labeled fixtures — connecting, running, completed,
  interrupted, unknown-cost, blocked, unsupported, malformed. Seven parse; the
  malformed one is asserted to fail.

## Security posture (observed, not merely configured)

`p02-smoke.json` records:

- `require`, `process`, and `module` are `undefined` inside the page.
- The bridge exposes exactly `["getAppInfo", "getPaths", "discoverTools"]`.
- `window.open` is denied (`null`).
- CSP includes `connect-src 'none'`, `default-src 'self'`, and no
  `unsafe-inline`/`unsafe-eval`.
- Permission requests are denied by the session handler.

`contextIsolation`, `sandbox`, `nodeIntegration`, and `webSecurity` are recorded
as configured values and corroborated by the observed globals and bridge shape.

## Deliberately not built

No plugin framework, no additional server, no cloud service, no broad Electron
API export, no design-system dependency, no engine adapter, and no runtime
process. P03 owns the adapter; P04 owns process supervision; P06 owns the visual
system; P09 owns the Finder helper; P21/P22 own packaging and signing.

## Carried forward

1. **P02-01** — `tools/monabuild` and `tools/p01-spike` are excluded from the
   product ESLint scope; they predate the product stack and have their own
   tests. P03 should not extend them as product code.
2. **P02-02** — The renderer has no automated visual/accessibility test yet;
   P06 and P26 own that. The shell uses semantic landmarks and visible focus
   states, but this is not an accessibility certification.
3. **P02-03** — Electron's embedded Node is 24.22.2, not the host's 26.13.0.
   Build tooling uses the host Node; runtime code must not assume host APIs.
4. **P02-04** — `fsevents` reports an unapproved install script. It is optional
   file-watching support and is not required for build, test, or smoke.
5. **P02-05** — Developer ID signing remains the P22 prerequisite; the app is
   unsigned locally.
