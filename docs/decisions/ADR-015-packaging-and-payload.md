# ADR-015 — The packaged payload, its ownership, and its trust boundary

**Status:** accepted at P21 · **Date:** 2026-11-12

## Context

P21 turns the assembled application into a real Apple Silicon artifact. The
package must install complete, runnable code on a Mac with no developer setup,
must not smuggle the builder's state, and must not claim more trust than an
ad-hoc local build has. The package is also the first thing P22, P23, and P26
consume, so the layout and ownership need to be stated once.

## Decisions

### 1. Two install roots, one receipt

The flat package owns exactly:

- `/Applications/Mona.app`
- `/Library/Services/Mona.service`
- `/Library/Application Support/Mona/install-receipt.json`
- `/Library/Application Support/Mona/owned-paths.json`

No user state is part of the payload. `~/Library/Application Support/Mona`,
`~/.codewhale`, credentials, projects, and any external Codewhale installation
are preserved. The receipt records version, channel, package name, component
manifest digest, and install time; `owned-paths.json` is the machine-readable
ownership list P23's uninstall utility will consume.

### 2. The installed copy wins, and only one copy is installed

The app component is non-relocatable (`BundleIsRelocatable=false`), so Installer
always writes `/Applications/Mona.app` instead of silently following a copy
elsewhere. A packaged copy that finds an installed copy at the standard path
shows a native notice and offers to quit. The Finder Service also prefers
`/Applications/Mona.app` when it is the expected bundle, executable, and validly
signed, instead of accepting whichever same-identifier copy LaunchServices
happens to return. This was found in practice: a second registered copy could
otherwise intercept Finder handoffs.

### 3. The bundled engine is authoritative; the host is a development fallback

`resolveEngineBinary` order is: explicit `CODEWHALE_BIN`, then
`Contents/Resources/engine/codewhale`, then the pinned host installation. A
recipient therefore never runs a different engine merely because Homebrew is
present. The packaging gate refuses an engine whose version or commit is not
the pinned `0.10.2` / `ff466b2ed0bf…`, and refuses the default artifact when its
SHA-256 differs from the qualified bytes. The engine is re-signed inside the
app, so the original upstream digest and the final packaged digest are recorded
separately; they are not the same bytes.

### 4. No ASAR

`asar` is disabled. There are no native Node modules in the payload (the app's
only runtime dependency is pure-JavaScript zod), and every executable — engine,
supervisor, PTY helper, app main — remains a real file in the signed payload.
Keeping the code visible also keeps the secret/path scan meaningful.

### 5. Minimum macOS is 14.0

The native supervisor and PTY helper are compiled with
`arm64-apple-macos14.0`. Electron 45's own floor is 13.0 and the engine reports
11.0, so the product floor is the native helpers' 14.0. The installer declares
`hostArchitectures=arm64` and `allowed-os-versions min=14.0`, and the preinstall
script repeats the check with a clear message. The 14.0 floor has not yet been
run on a 14.x host; P26 owns that matrix.

### 6. Local and release are different products

`--mode local` is the default: ad-hoc signatures, package filename
`Mona-<version>-macOS-arm64-local.pkg`, installer title “Mona — Local development
build”, and `MonaBuildChannel=local` in the app. It is explicitly not a
shareable release. `--mode release` fails closed before building unless both a
Developer ID Application and a Developer ID Installer identity exist, and then
still refuses until P22 adds signing, notarization, stapling, and release
verification. An unsigned package can never be emitted under the release name.

### 7. Installer scripts are boring on purpose

`preinstall` does only the arm64/OS gate and removes the previous
package-owned bundles after checking their bundle identifiers. `postinstall`
verifies the installed bundles, registers the Service with LaunchServices, and
writes the receipt. Neither script launches Mona, contacts a network, fetches a
dependency, accepts an agreement, modifies TCC, executes project code, reads a
credential, or touches user state. `MONA_INSTALL_ROOT` exists solely so the
build rehearses both scripts against a temporary root; a real install uses `/`.
The rehearsal runs twice, proves the previous bundles are replaced, and proves
an unrelated app and config file survive.

The actual system install requires standard Installer administrator
authorization. That is the user's OS decision, not a package decision; the build
records the exact command and verifies the result afterwards.

### 8. Git is probed, never triggered

`/usr/bin/git` is Apple's Command Line Tools stub on a clean Mac. A packaged
Mona does not execute it when no real toolchain is present: `resolveGit` returns
unavailable with an explanation instead of causing an OS developer-tools
install. Git features therefore work when the user has a toolchain or a
separately installed Git, and degrade honestly otherwise. Bundling a GPL Git
would create source-distribution obligations and a large, fragile payload; that
is a release decision (P26/P27), recorded as an open limitation rather than
improvised here.

### 9. Determinism is of inputs and hashes, not of every byte

The build rebuilds main, renderer, and all native helpers, stages a fixed file
set in sorted order, normalizes modification times, and records content
digests. The app's content digest is stable across repeated builds on this host.
The flat package's xar/BOM container can still differ in archive metadata, and
a native rebuild can change a Mach-O's compiler UUID, so the manifest records
the exact hashes rather than promising byte-identical `.pkg` files. The release
pipeline (P22) must treat the frozen bytes and their receipt as the identity.

### 10. Notices are part of the payload

Electron (MIT) with the Chromium third-party notices, Codewhale 0.10.2 (MIT,
vendored license text), React, React DOM, and zod (MIT) are included in
`Contents/Resources/notices`, and the component manifest records each notice's
digest. `@electron/packager` is a build tool and is not shipped.

## Consequences

- P22 can sign and notarize the same component layout rather than redesigning
  it; it must sign inside-out and preserve the notice/manifest resources.
- P23 can uninstall from `owned-paths.json` and must not treat deleting the
  receipt as deleting files.
- P26 must test the 14.0 floor, the clean-recipient Git behavior, and the
  duplicate-copy notice on a machine without this checkout.
- A user who installs the local package gets an ad-hoc app with a visible local
  channel; they must not mistake it for a notarized release.
