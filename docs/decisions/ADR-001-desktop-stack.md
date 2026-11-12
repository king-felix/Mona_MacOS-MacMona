# ADR-001 — Desktop stack and dependency selection (P02)

**Status:** accepted · **Date:** 2026-11-11

## Context

Mona needs a native Apple Silicon desktop shell that can host a React workbench
and talk to a local Codewhale Runtime API through a trusted main process. The
window itself must make zero inference calls. P02 must pin a stack, produce a
lockfile, and keep the surface small.

The host has Command Line Tools only (no full Xcode), Node 26.13.0, npm 11.20.0,
and 39 GiB free. Electron 45.3.0 ships an arm64 binary and embedded Node 24.x.

## Decision

- **Shell:** Electron `45.3.0` (arm64). One process model for main, preload, and
  renderer; native menu/Services and traffic-light titlebar are first-class.
- **UI:** React `19.3.1` + `react-dom`, TypeScript `5.9.3`, built with Vite
  `8.3.8` in a static, `file://` renderer. No React Fast Refresh plugin at P02;
  esbuild's automatic JSX transform is sufficient and removes a dependency.
- **Validation:** Zod `4.6.7`, used for IPC inputs, Mona contracts, and fixtures.
- **Tests:** Vitest `5.1.0`; Node's standard test runner remains for the
  dependency-free build ledger.
- **Tooling:** ESLint `10.14.0` + typescript-eslint `8.72.2`, Prettier `3.10.0`.
- **Package manager:** npm with `package-lock.json`, pinned exact versions.
- **Native modules:** none at P02. If a later prompt adds one, it must be rebuilt
  against Electron's ABI for arm64 before packaging; that is a named P09/P21
  step, not an assumption.

## Alternatives rejected

- **SwiftUI-only shell:** fastest native feel but would require re-implementing
  the whole workbench surface and the engine adapter in Swift; the spec's
  portable-core and Windows-coordination requirements favor a web renderer.
- **Tauri:** smaller bundles, but its process/IPC and macOS Services story would
  add a second runtime and toolchain before P03 has proven the adapter.
- **Vite dev server in the shipped app:** remote-origin surface and a second
  network listener; the production renderer is loaded from a local file only.
- **Electron Forge/electron-builder now:** packaging is P21. P02 needs a
  reproducible local build, not an installer pipeline.

## Consequences

- `npm ci` downloads the arm64 Electron binary via a root `postinstall` hook
  (Electron 45 no longer ships a package-level postinstall). Clean install was
  verified from the lockfile.
- Renderer bundle is ~226 KB uncompressed (69 KB gzip); four Electron processes
  used ~408 MB working set in the smoke sample. This is the P02 baseline, not a
  performance target.
- The renderer cannot use Node APIs; every privileged operation goes through the
  narrow preload bridge (ADR-002).
- Updating Electron or Vite is a pinned-dependency change and must re-run the
  security smoke and bundle baseline.
