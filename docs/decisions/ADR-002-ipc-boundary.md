# ADR-002 — IPC boundary and renderer trust (P02)

**Status:** accepted · **Date:** 2026-11-11

## Context

The renderer displays project state, prompts, events, and cost. It must never
receive provider credentials, a raw runtime token, arbitrary shell access, or a
general-purpose Electron API. Upstream Codewhale response shapes drift; they
must not leak into UI components.

## Decision

1. **One narrow preload bridge.** `src/preload/index.ts` exposes exactly
   `getAppInfo`, `getPaths`, and `discoverTools` via `contextBridge`. No raw
   `ipcRenderer`, no Node built-ins, no dynamic channel names.
2. **Strict IPC contracts.** Every channel is a `zod.strictObject` in
   `src/main/ipc-contract.ts`. Unknown channels and unknown fields are
   rejection. The preload sends `{}` for no-argument channels so "no payload" is
   itself a validated shape.
3. **Trusted sender only.** `ipcMain.handle` checks the invoking frame URL
   against the built renderer root before validating input. A navigated or
   remote frame cannot call the bridge.
4. **Renderer isolation.** `contextIsolation: true`, `sandbox: true`,
   `nodeIntegration: false`, `webSecurity: true`, `webviewTag: false`,
   `allowRunningInsecureContent: false`. The smoke test observes `require`,
   `process`, and `module` as `undefined` inside the page.
5. **No network surface.** A strict CSP (`default-src 'self'`, `connect-src
'none'`, no `unsafe-inline`/`unsafe-eval`) is in the document and in response
   headers. Navigation is allowed only to files inside `dist/renderer`;
   `window.open` and webview attachment are denied. Permission requests are
   denied.
6. **Type boundary.** Mona contracts live in `src/shared/contracts`; upstream
   wire shapes live in `src/shared/engine-wire` and may be imported only by the
   adapter. A test scans the renderer and fails if it references wire types,
   `ipcRenderer`, Node built-ins, or `process.env`.
7. **No secrets.** The renderer never receives keys or runtime tokens. CI scans
   the built renderer for key patterns, token env names, private keys, source
   maps, and (when present) the live environment secret value.

## Consequences

- Adding a capability requires a deliberate schema, handler, and bridge change;
  there is no generic "invoke anything" escape hatch.
- The renderer can be tested without Electron; contract, IPC, navigation, and
  discovery policies are pure functions with unit tests.
- The smoke test is the end-to-end proof that the configured posture is the
  observed posture: no Node globals, exact bridge keys, denied popup, strict CSP.
- Runtime keys and provider credentials will be handled in the main process
  only, and never logged, when P03/P04 need them.
