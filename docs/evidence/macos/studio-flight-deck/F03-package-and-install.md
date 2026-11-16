# F03 — package, install, and verify the installed copy

Captured 2026-11-15 on macOS 26.5.1 (arm64). **The installed copy has been
verified from its own bytes.** One item remains the owner's: reinstalling so the
installed bundle matches the very latest commit, because `sudo` cannot prompt in
this session.

## What is installed

`/Applications/Mona.app`, read from its own `Info.plist` and install receipt:

- `MonaBuildVersion` **176**, `CFBundleVersion` 176, version 0.1.0, channel
  `local`, `com.mona.workbench`, arm64.
- Install receipt at `/Library/Application Support/Mona/install-receipt.json`:
  package `Mona-0.1.0-macOS-arm64-local.pkg`, channel `local`,
  `installed_at` 2026-11-15T21:52:15Z, `app_path` `/Applications/Mona.app`,
  manifest `9c907f2170006d62…`.
- Owning user `root:wheel`, mtime 2026-11-15 14:52.

Build 176 corresponds to commit `d0c5ac2`. HEAD is `4dc9928` (build 177), and
`git diff d0c5ac2..HEAD -- src/renderer/ test/` is **empty**: everything the owner
sees is byte-identical. The only delta between the installed build and HEAD is the
qualification harness (`src/main/index.ts` smoke mode, `scripts/deck-smoke.mjs`,
`scripts/ci.mjs`) plus evidence. That is stated rather than glossed: the installed
product *is* the flight deck.

## Verified against the installed copy

**Its own package smoke** — `/Applications/Mona.app/Contents/MacOS/Mona
--package-smoke` in a scrubbed `HOME` (`f03-installed-package-smoke.json`):
`ok: true`, packaged, arm64, version 0.1.0, channel `local`, install path
`/Applications/Mona.app`, `installed_at_standard_location: true`, **13 components
all hash-ok**, and the app's own report of `runtime_started: false`,
`inference_calls: 0`. Its eleven checks pass: packaged, arm64 executable, bundled
engine version, bundled engine location, native supervisor, native pty, capability
inventory, component manifest, component digests, install location, state
directory.

**The full deck layout suite, in one launch** (`f03-installed-deck-report.json`,
232 checks, all passing): the six window/zoom arrangements with 1,200 appended
frames and the 8,000-line stream, composer re-clamp, the keyboard contract, the
receipt and clipboard restoration, reduced motion, the on-demand actions panel,
Focus and Escape ordering, the command list at three sizes, both themes with
contrast, and the narrow window — all against `/Applications/Mona.app`.

**LaunchServices launch and quit**: `open -a /Applications/Mona.app` brought up
the real app with the owner's own projects (Kindle, Mona, café-decomposed, …),
engine disconnected, `Mona 0.1.0` in the rail; quitting by bundle id exited
cleanly with no process left. Capture: `f03-installed-launch.png`.

## Honest limit of that installed run

The installed binary predates the deck smoke's two-phase flag, so its second
invocation **repeated the whole suite** instead of verifying a relaunch. That
doubled count is not used: the single-launch results are in
`f03-installed-deck-report.json`, and that file's own `caveat` says so.

The restart, the Focus preference and the draft are proven elsewhere, against the
current source: `f02-report.json` (in-tree, two launches on one state directory)
and `f03-packaged-deck-report.json` (the packaged build-177 bundle, same two-phase
run, both green). Re-running those against `/Applications` needs the reinstall below,
because an app carries its own harness.

## Package built from HEAD (not yet installed)

`npm run mac:package:local` → build **177**, channel `local`, sha256 starts
`88b487158d65328e…`, all pre-install gates green (declared metadata, arm64 only, dependencies, secret scan, payload expand,
install rehearsal with an idempotent reinstall, uninstall rehearsal with eleven
checks including "unrelated content preserved"). Report:
`packaging/macos/out/package-report.json`. Its payload reads
`MonaBuildVersion` 177, and the two-phase deck run against that bundle passes
**268/268 including the relaunch** (`f03-packaged-deck-report.json`). Its only pending gates are "package
smoke against /Applications" and "LaunchServices GUI launch", which are exactly
the two things that need the newer build on disk.

Bundle identity was read from the payload each time — `com.mona.workbench`,
0.1.0, channel `local`, macOS 14.0+, arm64, ad-hoc signed, with
`codesign --verify --deep --strict` clean — and the engine pin is unchanged:
0.10.2 `ff466b2ed0bf`, sha256 `da0229610647f1cc2…`, verified against the installed
engine bytes by the packaging script. Transcripts: `mac-package.txt`.

## Needs the Human — reinstalling HEAD

```sh
cd ~/DS_Projects/Mona
npm run mac:install
```

It builds, packages, installs with `sudo` (your password is all it asks), and
re-runs the install-side gates against the installed copy. Then:

```sh
node scripts/deck-smoke.mjs --app /Applications/Mona.app
```

which will — on that build — prove the relaunch from `/Applications` itself.

This session cannot do it: `process.stdin.isTTY` is false, `sudo -n` reports a
password is required, and the earlier INSTALL-AUTH record established that a
prompted SecurityAgent sheet does not render here. Nothing was bypassed; recorded
as `F03-INSTALL-AUTH` in `.mona/build-macos/attempts.jsonl`.

## Rollback

Build 170 preceded the current install, and any build is reproducible from git
history with `npm run mac:package:local`. Installing replaces only
`/Applications/Mona.app` and `/Library/Services/Mona.service`; project folders,
`.mona/` state, `~/.codewhale` and credentials are untouched — which the uninstall
rehearsal demonstrates rather than asserts.
