# Mona — owner guide (macOS)

Mona is a native Apple Silicon workbench around the Codewhale engine: find a
folder, open it as a project, and see the real work, its cost and its state.
This guide describes the build in your hands. It states what is local and what
is not, so nothing here has to be taken on trust.

## Install and launch

- **There is no shareable release, by decision.** Mona is built and used on the
  machine that builds it. There is no Developer ID signature and no notarization
  ticket (`mac:release` refuses without them, and stays that way), so macOS
  refuses this build on any other Mac. Anyone else who wants Mona builds it from
  source: `npm install && npm run mac:package:local` for the installer, or
  `npm run mac:package:dmg` for a disk image you can drag to Applications.
- **The disk image** is `packaging/macos/out/Mona-0.1.0-macOS-arm64-local.dmg`.
  It contains the app, a pointer to Applications, this guide, and a README that
  states the local-only signing tier. Mount it, drag Mona to Applications, open
  it. The image is verified from its own bytes after it is written (`npm run
mac:package:dmg` prints `ok: true` only when the app inside is byte-identical
  to the app that went in).
- **The installer package** is `packaging/macos/out/Mona-0.1.0-macOS-arm64-local.pkg`.
  It does more than the image — it also installs the Finder Service to
  `/Library/Services/Mona.service` — so it needs administrator authorization:
  `sudo installer -pkg packaging/macos/out/Mona-0.1.0-macOS-arm64-local.pkg -target /`.
- **Requires macOS 14.0 or later; tested on macOS 26.5.1.** The floor is declared
  and enforced by the installer. It has not been executed on a 14.x host, and
  this guide does not claim it has.
- **Location.** The app lives at `/Applications/Mona.app`. A copy anywhere else
  runs, but the packaged build shows a notice and will not pretend to be the
  installed application while the installed one exists.
- **From Finder.** Double-click a project folder's Service **Start new DS
  project with Mona**, or open the app and use `⌘O`. A Finder handoff opens the
  folder; it does **not** start the engine by itself (deliberate — nothing spends
  money before you ask for a turn).
- **Build identity.** Settings shows the version, build number and channel. The
  installed local builds are ad-hoc signed: macOS accepts them on this Mac, and
  Gatekeeper will refuse them on another one. That is the local tier, not a
  release.

## Screens — `⌘1` … `⌘9`

Home, Studio, Work board, Changes, Cost lens, Settings, Agents, Capabilities,
Memory. `⌘J` toggles the terminal; `⌘K` opens the palette; `⌘/` lists every
shortcut. Navigation never calls a model.

## Studio: writing and sending

- **Enter adds a newline. `⌘Enter` sends.** IME composition is untouched, so a
  composing `⌘Enter` does nothing. Empty or whitespace-only text cannot be sent.
- **`/` opens the command list.** The list is the engine's own `GET /v1/commands`
  catalog (109 commands, pinned and annotated with scope, effect, cost class,
  support level and route). `↑`/`↓` move, `Tab` accepts, `Escape` closes the list
  first and leaves your draft, a click accepts a row.
- **Literal slash text stays text.** A command position is the start of a line,
  outside a fenced code block, not indented, and without a second slash. So a
  path like `/Users/me/notes.md`, a message that begins `//`, fenced pasted code,
  or a line starting `\/help` are prompt text, not commands.
- **Some commands are explained, not executed.** `⌘Enter` on an exact command
  tells you its route; a command that needs an argument says what remains; an
  ambiguous prefix (`/he`) names its matches and selects nothing. View commands
  (`/cost`, `/help`, …) act on Mona locally. Commands that would spend money or
  change engine state are run by the engine only after you send them.
- **The interrupted state is real.** `⌘.` interrupts; a turn that may still be
  running is never labelled stopped.

## Speaking to an agent while it works

- **Follow-up queue.** The engine on 0.10.2 exposes no steering route, so Mona
  does not offer a "steer" control it could not honour. Instead you queue a
  sentence; it is dispatched at the end of the current turn, through the same
  path as the composer. Every row keeps one of: `queued`, `accepted`, `unknown`,
  `rejected`, `canceled`, `stale`. An `unknown` write is never resent.
- **Pending replies and approvals** arrive as in-app cards. Answering them uses
  the engine's own reply routes; what is shown is what the engine reported.
- **Activity strip.** Frames, last-event age, tool rows with measured durations
  and "Needs you" are derived from stored events only — no inference, no invented
  percentage.

## Focus Mode vs fullscreen

These are different things and the app says so:

- **Focus Mode (`⌘⇧F`)** is Mona's own layout: it hides the inspector and keeps
  the composer and controls. `Escape` leaves it.
- **Full screen (`⌃⌘F`, the green button, or the Studio's Full Screen button)** is
  the operating system's window state. Mona reads it back from the OS, so a
  request that is still animating shows as pending, not as done.

## Cost, honestly

The usage HUD carries three labelled scopes — **turn**, **thread**, **project** —
read from stored receipts. Five states, only one of them `$0.00`-shaped:
`waiting`, `empty`, `unpriced`, `partial`, `complete`. Known unknowns:

- a provider without a recorded rate stays **unpriced**; no local estimate is
  invented;
- a cumulative thread total that could not be split per turn appears as an
  `unallocated` residual (project scope only), counted once;
- quota-billed providers stay unknown even with a rate card;
- a local budget is a guard, not an invoice cap: a request already in flight may
  finish after a stop.

## Memory, handoff and diagnostics

Search the project's stored text, keep a prompt shelf (`{{variable}}`
substitution in one pass), read a Resume Brief, and export a project handoff
bundle (`manifest.json`, `project.json`, `pointers.json`, `decisions.md`,
`README.md`, optional `prompts.json`). The manifest digest covers every entry;
importing validates it. A redacted diagnostics preview exports exactly the bytes
it showed.

## Terminal (`⌘J`)

Mona owns a native PTY helper; it is not the engine's shell and not a VT100
emulator. The environment is allowlisted, startup files are not sourced
(`/bin/zsh -f`), output is inert and bounded, and full-screen programs are
unsupported — the pane says so. Capped at three sessions and a 64 MiB budget per
session; a session ends at quit.

## Updates and removal

Settings → Updates reads a configured feed only (HTTPS, same host, digest while
writing). An update is handed to Installer; Mona records the intent and confirms
it on the next launch by comparing the running version — a cancelled install is
never reported as done. Uninstall shows the owned paths and the exact commands;
executing them is yours.

## Shortcuts

`⌘1`–`⌘9` screens · `⌘J` terminal · `⌘K` palette · `⌘O` open folder · `⌘F`
search this conversation's stored text (local) · `⌘C` native copy · `⌘+` / `⌘−`
scale, `⌘0` 100% · `⌘⇧F` Focus Mode · `⌘⇧B` blockers · `⌘.` interrupt · `⌘/`
shortcut list · `⌘W` close the window (work continues) · `⌘Q` quit (interrupts
and stops the runtime).

## Known limits (each with its reason)

- **Notifications** need macOS permission for Mona; if it is refused, Settings
  says so and the receipt records the refusal. Nothing is queued for later.
- **Attachments** are disabled in the composer with the reason shown.
- **Workflows and lanes** are unavailable: the pinned engine exposes no `/v1`
  route for them.
- **Git is local only** — no remote operations, history rewriting or conflict
  automation. Git is **not bundled**: on a Mac without Xcode Command Line Tools
  or another Git, Git features report themselves unavailable with that reason,
  and nothing triggers Apple's developer-tools installer. Everything else —
  launch, edit, terminal, engine turns, the acceptance sample — needs no
  developer tools. This is a documented dependency, not a defect.
- **A package capability change is drift**, not silent support: the explorer
  re-qualifies against the pinned version.
- **Sub-agent/fleet spend** is unknown when the engine does not report it.
- **This build is not a shareable release, and will not become one.** The
  release pipeline exists, is tested (17 checks), and fails closed without
  Developer ID and notarization credentials. Distribution here is
  build-it-yourself (D-103).
