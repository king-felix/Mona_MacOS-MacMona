# F03 — package, install, and verify the installed copy

Captured 2026-11-15 on macOS 26.5.1 (arm64). **The installed copy has been
verified from its own bytes.** One item remains the owner's: reinstalling so the
installed bundle matches the very latest commit, because `sudo` cannot prompt in
this session.

## What is installed

`/Applications/Mona.app` is build **178** — the current HEAD — read from its own
`Info.plist` and from the installer's receipt:

- `MonaBuildVersion` **178**, version 0.1.0, channel `local`,
  `com.mona.workbench`, arm64, `root:wheel`.
- Receipt at `/Library/Application Support/Mona/install-receipt.json`:
  package `Mona-0.1.0-macOS-arm64-local.pkg`, channel `local`,
  `installed_at` 2026-11-16T02:33:39Z, `app_path` `/Applications/Mona.app`,
  `service_path` `/Library/Services/Mona.service`.
- `git rev-list --count HEAD` is 178, so the installed build number is this
  commit's (`c66cd31`), and the install postdates it.

## Verified against the installed copy

**Its own package smoke** — `/Applications/Mona.app/Contents/MacOS/Mona
--package-smoke` in a scrubbed `HOME` (`f03-installed-package-smoke.json`):
`ok: true`, packaged, arm64, channel `local`, install path `/Applications/Mona.app`,
`installed_at_standard_location: true`, **13 components all hash-ok**, and the
app's own report of `runtime_started: false`, `inference_calls: 0`. All eleven
checks pass: packaged, arm64 executable, bundled engine version, bundled engine
location, native supervisor, native pty, capability inventory, component manifest,
component digests, install location, state directory.

**The full two-phase deck suite against `/Applications/Mona.app`** —
`f03-installed-deck-report.json`, **268/268 checks, no failures**:

- six window/zoom arrangements (1440×900; 1280×800 at 100/125/150/200 %;
  1100×700) with 1,200 appended frames and the 8,000-line stream, the prompt not
  moving, the console scrolling internally, Submit/Interrupt hit-testable;
- composer re-clamp at 900×620 then 200 % zoom, and recovery with the prompt at
  its minimum;
- keyboard: Enter reaches the composer un-intercepted, Command-Enter runs the
  submit path; the receipt and its clipboard restoration; reduced motion; the
  on-demand actions panel; Focus and Escape ordering; the command list at three
  sizes; both themes with measured contrast; the narrow window;
- **native full screen** entered and left through the deck's own control
  (`enter-full-screen` / `leave-full-screen` both observed, draft intact);
- **a real second launch** on the same state directory: the Focus preference and
  the composer draft came back (`relaunch_restores_focus_mode: true`,
  `relaunch_restores_the_draft: true`) and no runtime was started.

**LaunchServices launch and quit**: `open -a /Applications/Mona.app` brought up
the app with the owner's own projects listed and the engine reported disconnected;
quitting by bundle id exited cleanly with no process left.
Capture: `f03-installed-launch.png`.

**Identity against the source.** The packaging script's own installed-copy gate is
a byte-for-byte comparison of every file, so it cannot match a *separate* build
invocation even from identical source (the ad-hoc signature and the bundled docs
list differ). The meaningful comparison was made directly:

- `Contents/Resources/app/dist` — the main bundle, renderer bundle and preload,
  **131 files — byte-identical** between `/Applications` and a fresh build of HEAD;
- `Contents/Resources/app/package.json` — identical;
- `Contents/Resources/component-manifest.json` — differs only in its list of
  bundled evidence documents, by the three files created after the install
  (`f03-installed-deck-report.json`, `f03-installed-launch.png`,
  `f03-installed-package-smoke.json`).

So the application code the owner is running is exactly this tree's.

## The package

`npm run mac:package:local` → build **178**, channel `local`, all pre-install gates green (declared metadata, arm64 only, dependencies, secret scan, payload expand,
install rehearsal with an idempotent reinstall, uninstall rehearsal with eleven
checks including "unrelated content preserved"). Report:
`packaging/macos/out/package-report.json`; payload reads `MonaBuildVersion` 178.
Its two pending gates — "package smoke against /Applications" and "LaunchServices
GUI launch" — are satisfied by the installed-copy verification above.

The build-177 package built earlier in this pass was also run through the
two-phase deck suite (268/268 including the relaunch,
`f03-packaged-deck-report.json`), so both builds qualify; only 178 is installed.

Bundle identity was read from the payload each time — `com.mona.workbench`,
0.1.0, channel `local`, macOS 14.0+, arm64, ad-hoc signed, with
`codesign --verify --deep --strict` clean — and the engine pin is unchanged:
0.10.2 `ff466b2ed0bf`, sha256 `da0229610647f1cc2…`, verified against the installed
engine bytes by the packaging script. Transcripts: `mac-package.txt`.

## The install step, and how it closed

Installing needs an administrator credential, which this session cannot supply:
`process.stdin.isTTY` is false, `sudo -n` reports that a password is required, and
the earlier INSTALL-AUTH record established that a prompted SecurityAgent sheet
does not render here. That was recorded as `F03-INSTALL-AUTH` rather than worked
around.

The owner installed it, and the blocker is now resolved: the installed copy is
build 178, verified from its own bytes, and passes both the package smoke and the
full two-phase deck suite. `monabuild resolve` records the closure with this
evidence.

## Rollback

Build 170 preceded the current install, and any build is reproducible from git
history with `npm run mac:package:local`. Installing replaces only
`/Applications/Mona.app` and `/Library/Services/Mona.service`; project folders,
`.mona/` state, `~/.codewhale` and credentials are untouched — which the uninstall
rehearsal demonstrates rather than asserts.
