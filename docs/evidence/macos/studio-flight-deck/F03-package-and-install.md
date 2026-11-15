# F03 — package, install, and verify this exact source

Captured 2026-11-15 on macOS 26.5.1 (arm64). Source: branch `studio-flight-deck`
at `3af9b4b` plus the deck-smoke `--app` support. **The package is built and
verified; the installed copy is not yet this build, and that step needs the
owner's own terminal.**

## Built

`npm run mac:package:local` → build **172**, channel `local`, version 0.1.0.
Transcript: `mac-package.txt`; report: `packaging/macos/out/package-report.json`.

- Package: `packaging/macos/out/Mona-0.1.0-macOS-arm64-local.pkg`,
  sha256 starts `188622428ec59ff1…`, 163,834,498 bytes.
- Bundle identity read from the payload itself: `com.mona.workbench`,
  `CFBundleShortVersionString 0.1.0`, `MonaBuildVersion 172`, `CFBundleVersion 172`,
  `MonaBuildChannel local`, `LSMinimumSystemVersion 14.0`.
- `codesign --verify --deep --strict` on the payload app → clean (ad-hoc).
- Engine pin unchanged: 0.10.2 `ff466b2ed0bf`, sha256 `da0229610647f1cc2…` —
  the packaging script verified the installed engine bytes against that hash.

Package gates that passed **without** administrator authorization:

- declared metadata (package id, version, build, both bundle ids, arm64 only,
  macOS 14.0+) — `ok`;
- architecture (arm64 only) — `ok`;
- dependencies — `ok`;
- secret scan of payload text and names — `ok`;
- payload expand — `ok`, 674 files, 14 links;
- install rehearsal, including an idempotent reinstall — `ok`;
- uninstall rehearsal — `ok`, 11 checks including "unrelated content preserved",
  "projects preserved by user-data removal", "foreign bundle refused".

Gates still pending in that report, because they describe `/Applications`:
`package smoke against /Applications`, `LaunchServices GUI launch`. The script
says exactly that and exits 1 rather than certifying a copy it did not install.

## The packaged app itself, verified from its own bytes

The staged bundle was launched through LaunchServices and driven by the same F02
harness with `--app`:

```
node scripts/deck-smoke.mjs --app packaging/macos/out/stage/payload/Applications/Mona.app
```

Result: **200/200 checks pass, exit 0**, on macOS 26.5.1 / Electron 45.3.0
(`f03-packaged-deck-report.json`, `f03-packaged-deck-smoke.log`). That covers the
six window/zoom arrangements, 1,200 appended frames, the 8,000-line stream,
composer re-clamp, keyboard, receipts, reduced motion, both themes and the narrow
window — against the packaged binary, not `electron .`.

One harness defect was found and fixed on the way: a packaged copy that is not the
installed copy normally shows the "Mona is installed in two places" dialog, which
blocked the measurement. The deck smoke is now exempt from that dialog (it uses
its own state directory and starts nothing); real launches keep the guard.

## Not done: the install itself — Needs the Human

`/Applications/Mona.app` is still the **prior** build (168). The package cannot be
installed from this session:

- the install path refuses without a terminal because `sudo` would wait forever
  for input (`process.stdin.isTTY` is false here — `tty` reports "not a tty"), and
  `sudo -n` reports "a password is required";
- the earlier INSTALL-AUTH record already established that a prompted
  authorization sheet (SecurityAgent) does not render in this session, so an
  osascript route is not available either.

Nothing was bypassed: no credential was collected, cached, or replayed, and no
gate was recorded as passing. Attempt recorded as `F03-INSTALL-AUTH` in
`.mona/build-macos/attempts.jsonl`.

**The exact step, in the owner's own Terminal** (it will ask for the administrator
password, which is the only thing it needs):

```sh
cd ~/DS_Projects/Mona
npm run mac:install      # builds, packages, installs with sudo, then re-checks the installed copy
```

Or install the package that already exists and re-run the verification:

```sh
sudo installer -pkg packaging/macos/out/Mona-0.1.0-macOS-arm64-local.pkg -target /
npm run mac:package:local     # now the installed-copy digest gate can pass
node scripts/deck-smoke.mjs --app /Applications/Mona.app
node scripts/r11-smoke.mjs --app /Applications/Mona.app
```

After that, F03's remaining checks are: `/Applications/Mona.app` reports build 172
and matches the package payload by digest, LaunchServices launch/quit, Focus
preference persistence across a relaunch, and a draft surviving a layout change.

## Rollback

The previous build is the copy currently at `/Applications/Mona.app` (168). Its
payload is also reproducible from `git` history (commit `344d41c` and earlier
release records) with `npm run mac:package:local`, so nothing needs to be kept by
hand. Installing build 172 replaces only the app bundle and the Finder Service;
project folders, `.mona/` state, `~/.codewhale`, and credentials are untouched —
the package's own postinstall and the uninstall rehearsal state this, and the
rehearsal proves unrelated content survives.
