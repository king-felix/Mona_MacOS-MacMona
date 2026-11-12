# P09 — Finder selected-folder launch and native open actions

**Date:** 2026-11-11 · **Status:** complete · **Host:** macOS 26.5.1 arm64
(M3) · **Engine:** not involved (no inference in this prompt) · **Runtime:**
Electron 45.3.0, Swift 5.10, CLT SDK 14.4

## Result

Mona is reachable from Finder. A signed standalone `Mona.service` advertises
**Start new DS project with Mona** for selected folders, validates the selection
itself, locates the installed app **by bundle identity**, and hands the folder
over with a standard `open documents` Apple event. The real application receives
that event, registers the project once, selects Studio, and puts the cursor in
the composer — without starting the engine, creating a task, or sending a
prompt.

Three paths now converge on one validated dispatcher: **Finder Services**,
**Dock/window folder drop**, and **File → Open Project… (⌘O)**. A second launch
hands its folder to the running owner instead of becoming a second owner.

Verification:

- **21/21** native Service checks (`p09-service-smoke.json`), including discovery
  by macOS, exact-folder delivery proven by device/inode, folder-only eligibility,
  and refusals for files, empty selections, text selections, and multi-selection.
- **17/17** application-handoff checks (`p09-app-handoff.json`) plus the
  application's own **17/17** report (`p09-app-run.json`): a real service handoff
  into the built app bundle, project registered once, Studio selected, composer
  focused, no runtime, no task, one window, second handoff reused, and the
  Settings → Finder panel showing the measured state.
- **274 tests in 33 files** (34 new P09 tests), local CI green
  (format, lint, typecheck, supervisor build, service build, tests, build,
  renderer secret scan). The Electron security smoke (20/20) and the shell smoke
  (32/32) also pass.

Evidence: `artifacts/p09-service-smoke.json`,
`artifacts/p09-app-handoff.json`, `artifacts/p09-app-run.json` (the app's own
report), `artifacts/p09-open-handoff.png` (real window after a Finder handoff).

## What the proofs actually did

### Native Service (`npm run smoke:service`)

The harness writes the same pasteboard types Finder writes and calls
`NSPerformService("Start new DS project with Mona", pasteboard)`. That exercises
registration, eligibility, launch, and delivery — not a binary started from a
terminal.

| Check | Observed |
|---|---|
| Registration | LaunchServices record `service id: Start new DS project with Mona`, port `MonaService`, message `startProject` |
| Advertised contract | installed `Info.plist`: `NSSendFileTypes = ["public.folder"]`, no broader `NSSendTypes` |
| Discovery + launch | macOS performed the Service; the helper process ran with `invocation: "service"` |
| App resolution | located by bundle identity `com.mona.workbench`, ad-hoc signature verified |
| Delivery | receiver app got the exact folder; matching `device`/`inode` with the selected folder |
| Awkward names | spaces, quotes, `$`, `;`, an embedded newline, and NFD Unicode all delivered intact |
| File selection | Service runs and refuses `NOT_A_DIRECTORY`; nothing forwarded |
| Empty selection | Service runs with 0 URLs and refuses `NO_FILE_URL`; nothing forwarded |
| Text-only selection | `NO_FILE_URL`; nothing forwarded |
| Multi-selection | `MULTI_SELECTION` refusal, or an explicit “open the first folder” choice |
| Clipboard/engine | no engine process appeared; no shell was invoked |

### Application handoff (`npm run smoke:open`)

A development bundle is cloned from the local Electron runtime, given Mona's
bundle identifier, ad-hoc signed, installed in `~/Applications`, and registered.
The Service then hands it two real folders.

| Check | Observed |
|---|---|
| App identity | `com.mona.workbench`, signature verified by the Service |
| Handoff | `open-file` received by the real app; project registered (`created: true`) |
| UI | Studio selected, composer focused, banner absent (live state, not fixtures) |
| Work safety | engine state not `running`; 0 tasks; one window |
| Idempotency | second handoff `created: false`, same project id, still 1 catalog entry |
| Shutdown | app exited on its own; no orphaned Service process |
| Finder panel | installed `/Users/.../Library/Services/Mona.service · user`, registration `registered`, enabled `unknown`, last handoff `forwarded`, development-build note |

The screenshot `p09-open-handoff.png` is that live window: “Opened … from
Finder. Runtime not started.” with a real **Start engine** action.
`p09-finder-panel.png` is Settings → Finder during the same run: the Service,
its path and scope, the registration source, the honest `enabled: unknown`
(macOS records no toggle for it), the last handoff, and the recovery guidance.

## Architecture

### Native (`native/macos-services/`)

- **`main.swift`** — one code path for both entry points. Service mode receives
  the pasteboard through `NSApplication.servicesProvider`; CLI mode (`--cli`)
  is used by tests and the doctor. Both validate, locate, and forward.
  - **Validation:** `file:` URL or absolute path only; remote `file://host`
    refused; aliases and symlinks resolved with `URL(resolvingAliasFileAt:)`;
    existence, directory-ness, readability; disk roots refused; online-only
    cloud items detected through `ubiquitousItemDownloadingStatus`.
  - **App trust:** `NSWorkspace.urlForApplication(withBundleIdentifier:)`,
    bundle-identifier match, and `SecStaticCodeCreateWithPath` +
    `SecStaticCodeCheckValidity`; the receipt records `adhoc:` or
    `developer-id:<team>:`.
  - **Forwarding:** `NSWorkspace.open([folder], withApplicationAt:)` — one
    `odoc` Apple Event that works whether Mona is running or not. No shell, no
    string interpolation, no clipboard rewriting.
  - **Never silent:** every invocation writes
    `~/Library/Application Support/Mona/services/last-handoff.json` and appends
    a bounded phase trace; a refusal explains itself in an alert that is bounded
    so the helper can never linger.
- **`Info.plist`** — `NSServices` entry with the menu title, `startProject`
  message, port `MonaService`, and `public.folder` eligibility only.
- **`test-support/`** — a receiver app that claims Mona's identity and a harness
  that performs the Service by menu title. Test fixtures; not shipped.

### Main process (`src/main/open/`)

- **`folder-request.ts`** — one validator for every entry point: scheme, host,
  percent-decoding, embedded NUL, relative paths, existence, directory,
  readability, symlink resolution, Unicode normalization, disk roots, and errno
  mapping (missing, permission, online-only/offline volume). Also parses launch
  arguments, ignoring the executable and app path.
- **`coordinator.ts`** — validates, registers through `ProjectService.open`
  (idempotent by `(dev, ino)` and path alias), journals the result, and notifies
  the renderer. It holds **no supervisor, adapter, or task API**, so the promise
  “opening cannot start work” is structural.
- **`service-status.ts`** — read-only facts for the UI: installed bundle and
  scope, LaunchServices/vended-services registration, macOS-recorded enabled
  state, the last handoff receipt, and the exact recovery steps. `refresh`
  re-registers only the installed `Mona.service` path.

### Renderer

- **Window drop** with a visible overlay, one-folder rule, honest errors, and
  the same dispatcher after the path is resolved in the preload with
  `webUtils.getPathForFile` (a dropped `File` never crosses the bridge).
- **Settings → Finder** shows measured state, the last handoff, and the guided
  recovery (`System Settings → General → Login Items & Extensions → Services`),
  plus **Refresh registration** and **Open Services settings**.
- Service handoffs announce themselves and select the project; the composer gets
  focus through the existing `projects:changed` path.

## Security properties

- No `shell -c`, no `exec` of any user-supplied string. Git branch reads use
  `execFile` with an argument array.
- The renderer never receives a token, port, or service path; the new IPC
  channels are strict objects with an enumerated source.
- Only `com.mona.workbench` is launched, and only after signature validation.
- An external launch cannot submit a prompt, resume a turn, or start a runtime.
- The Service reads no project contents before the folder is chosen and never
  reads repository instructions.

## Deliberate deviations, recorded

1. **No automatic runtime start on a Finder handoff.** Spec §5.1 step 3 describes
   the engine starting; the P09 prompt permits but does not require it, and P08
   made starting the engine an explicit user act. An external Apple Event can
   therefore never spawn a process tree. The composer is focused and **Start
   engine** is one keystroke away. Recorded as D-019.
2. **Development install scope.** The Service is installed to
   `~/Library/Services` for development and testing; the packaged installer
   places it in `/Library/Services` with the app. P21/P22 own that payload and
   the Developer ID signature (D-020).
3. **Interactive multi-selection choice** (the native alert) is exercised by CLI
   tests for the refusal path; clicking the alert is human QA (P24/P26).

## Bug found and fixed by this proof

The first version of the handoff smoke could not leave Studio after a Finder
handoff: **Command-1…5 screen switching was disabled whenever a text field had
focus** (`!typing` on the Meta-number branch). That is exactly the state a
handoff creates — the composer is focused — so the shortcut was dead in the one
moment a keyboard-first user needs it. A Command-modified digit is never text
input, so the guard was removed; the smoke now switches screens with the
composer focused, which is real keyboard-first evidence rather than a
body-focus shortcut.

## Operational facts worth keeping

- **LaunchServices ignores app bundles inside temporary directories.**
  `urlForApplication(withBundleIdentifier:)` returned `nil` for a signed bundle
  in `/tmp` and resolved immediately after the same bundle was installed in
  `~/Applications`. The app smoke installs there for that reason.
- **The Services daemon can serve a stale record after a bundle is replaced.**
  After a rebuild, `NSPerformService` may return success without launching the
  helper. Re-installing the bundle and re-running `lsregister -f` clears it. The
  smoke always installs fresh and retries once (bounded, recorded in `steps`).
- **`NSPerformService` does not re-apply menu eligibility.** It can hand a file
  or an empty pasteboard to a folder-only Service, which is exactly why the
  Service validates again rather than trusting the caller.

## Reproduce

```sh
npm run build:service          # compile, plutil -lint, ad-hoc sign, verify, receipt
npm run smoke:service          # native discovery + delivery (installs/removes ~/Library/Services)
npm run smoke:open             # real app handoff into a dev bundle
npm test                       # 274 tests
npm run ci                     # full local CI
```

Human step for the Finder menu itself (not automatable): select a folder in
Finder → **Services → Start new DS project with Mona**. The evidence above
proves the mechanism the menu triggers; P24 performs the menu walk as part of
clean-recipient acceptance.

## Not claimed here

- Developer ID signing, notarization, `/Library/Services` installation, and
  clean-recipient behavior — P21/P22/P24.
- VoiceOver reading of the Service menu — P24/P26.
- Finder Sync, global folder monitoring, and empty Finder-background invocation —
  intentionally out of scope (spec §14.1).
