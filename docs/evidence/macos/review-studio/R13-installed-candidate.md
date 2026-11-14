# R13 — Native installed-artifact qualification

**Prompt:** R13 · **Status:** blocked at the install gate · **Platform:** darwin-arm64
**Host:** macOS 26.5.1, Apple silicon, node 26.13.0, Electron 45.3.0
**Candidate:** `Mona-0.1.0-macOS-arm64-local.pkg`, build **147**,
sha256 `e54b2cffd62e6697b74ad65efad19d4b613df88965d6da7169fafd7947d435f9`,
163,804,045 bytes, ad-hoc (no installer signature), assembled from commit
`cf433aa` with a clean tree
**Installed copy at the time of this task:** build **104** (installed
2026-11-13T15:33:41Z, ad-hoc), receipt manifest `8fb892db…`
**Engine:** none started — no project was opened, so no runtime exists and no
model request was made.

Everything that can be qualified without administrator authorization is
qualified below. The one thing that cannot — exercising **the installed app** —
needs the installer, and `sudo` refuses in this session (`sudo -n` →
"a password is required"). That is EXT-INSTALL, recorded with the exact command
in §7.

---

## 1. What was built

`npm run mac:package:local` assembled the payload, ad-hoc signed 25 nested
components inside-out (17 Mach-O files, 8 nested bundles), built the component
package and the flat installer, and verified the declared metadata:

- package id `com.mona.workbench.pkg`, version `0.1.0`, build `147`
- bundles `com.mona.workbench` + `com.mona.workbench.service`, arm64 only,
  macOS 14.0+
- payload 673 files + 14 links, expanded from the package and compared against
  the staged payload with no mismatches and no extras
- package signature: **none** (`pkgutil --check-signature` → "no signature");
  this is a local candidate, not a distributable

It then stopped at `installed_copy`, by design:

> Two builds were made. The first (146) was assembled from an R12 working tree
> that had not been committed yet, and the build numbers itself by commit count —
> so the commits that describe the artifact moved the count past it, and the
> verifier could no longer tie the artifact to a commit. Build **147** is the
> one recorded here: built from `cf433aa` with a clean tree, so its number, its
> bytes and `git rev-list --count HEAD` agree. The verifier now refuses the tie
> when the checkout is dirty, which is what makes that agreement a check rather
> than a hope.


> the installed copy at /Applications/Mona.app is not this build; install
> Mona-0.1.0-macOS-arm64-local.pkg with administrator authorization, then re-run

The package's own gate report (`packaging/macos/out/package-report.json`) lists
`declared_metadata`, `architecture`, `dependencies`, `secrets`,
`payload_expand`, `install_rehearsal` and `uninstall_rehearsal` as passed, with
`package smoke against /Applications` and `LaunchServices GUI launch` pending.

## 2. The payload, verified from its own bytes

`scripts/r13-candidate-verify.mjs` answers a different question from the build:
not "did we assemble what we meant to" but "what is on disk, and is it this
checkout's build with the review's features in it". It reads the bundle's own
`Contents/Resources/component-manifest.json`, hashes every component it lists,
decodes every Mach-O header, and searches the shipped bundles for the review's
own channel names. Report: `artifacts/r13-candidate-verify.json`.

Every check passes:

- **bundle identity** — `com.mona.workbench`, 0.1.0, build 147, channel local,
  minimum macOS 14.0.
- **build number matches the source** — 147 = `git rev-list --count HEAD` at
  `cf433aa` **and** the checkout is clean, so the artifact is tied to this
  commit, not to a stale build and not to uncommitted work.
- **component digests** — all 13 components the manifest lists (the bundled
  engine, both native helpers, two icons, the capability inventory and seven
  licence/notice files) exist with their recorded size and sha256. The rest of
  the 673-file payload is covered by the package's own expansion comparison and
  the app seal.
- **arm64 only** — every Mach-O file in the bundle is arm64; no x86_64 slice.
- **minimum OS** — every app-owned Mach-O declares 14.0. The bundled engine
  declares 11.0: it is the pinned upstream 0.10.2 binary
  (`da022961…`, commit `ff466b2ed0bf`) and is not rewritten, which is the
  no-silent-engine-change rule working.
- **native components present** — `native/mona-supervisor`, `native/mona-pty`,
  `engine/codewhale`, `app/dist/main/main/index.js`, `app/dist/main/preload/index.js`.
- **the review's features shipped** — the packaged main bundle registers
  `projects:history-item` (R02), `commands:execute` (R04),
  `window:fullscreen:set` (R05), `studio:answer-pending` (R07) and
  `studio:follow-up-add` (R08); the minified renderer bundle carries
  "Load earlier events" (R02), "Jump to latest" (R10) and "Vivid" (R06).
- **no developer paths, no secrets** — 422 text files scanned for the build
  host's home, the checkout path, Command Line Tools and Xcode paths, and the
  credential shapes the packaging gate uses. Clean, with the one documented
  allowance: `main/work/git.js` *names* the toolchain paths so it can refuse
  Apple's Git stub (the same allowance `build.mjs` carries).

## 3. The in-app acceptance sample

Copied to `/Applications/Mona-r13-candidate.app` (a `ditto` copy, not an
install), the app ran its own `--package-smoke` sample: **every check passed**,
including "packaged", "arm64 executable", "bundled engine version 0.10.2 via
bundled", "native supervisor", "state directory" and "install location".

## 4. LaunchServices launch, and the notice that stops it

Launching that copy through LaunchServices (`open -na`, fresh
`HOME`/`CFFIXED_USER_HOME`/`TMPDIR`, its own `--user-data-dir`) starts a real
main process, a renderer process and a per-user state directory — the launch
path works.

It does not quit, and the reason is the product's own rule, not a shutdown
defect: `src/main/install-location.ts` refuses to run a packaged copy outside
`/Applications/Mona.app` while the installed copy exists, and raises a modal
notice ("This Mona copy is not the installed application" — Continue / Quit).
Sampling the process while it held the quit request shows the main thread in
`-[NSAlert runModal]`. The installed copy (build 104, at the standard path) quits
on `SIGTERM` in **1 s** on the same host, which is what proves the difference is
the duplicate-copy notice and not the shutdown path.

So the verifier records `launchservices_launch` and
`duplicate_copy_notice`, and marks `graceful_shutdown` **not testable at this
location** rather than passing a check it did not run. Graceful shutdown and the
interactive checks belong to the installed copy.

## 5. Rehearsals

All of these ran through the isolated-root guards; the owner's installed app and
project data were never involved.

- **Install rehearsal** — the package's scripts ran against a temporary root,
  twice: `idempotent_reinstall: true`, receipt written.
- **Uninstall rehearsal** — 11 sub-checks, all true: dry run changed nothing and
  listed owned paths; a missing manifest and a foreign bundle were refused; user
  data was removed only for the named home; projects survived
  `--remove-user-data`; a home outside the rehearsal root was refused; the real
  removal touched only owned paths and preserved unrelated content.
- **Update, rollback and migration** — `smoke:p23` ran in this queue's CI
  (58 checks, 0 skipped) on the same source; it covers the update trust tiers,
  deferral, the intent ledger, snapshot restore and the rollback refusals.

## 6. Prerequisites, measured

- **`npm run mac:doctor`** — every check green (macOS, arm64, not translated,
  tools, Swift, engine, artifacts, ≥5 GiB free: 29.8 GiB).
- **Git / Command Line Tools** — `/usr/bin/git` is Apple Git 2.39.3 with
  `xcode-select -p` = `/Library/Developer/CommandLineTools`, so Git is real on
  this host (not the install-me stub). A clean recipient without CLT still has
  the documented MAC-004 dependency; P26/P27 own the bundle-or-document
  decision.
- **OS floor** — the payload declares 14.0 and this host is 26.5.1. No 14.x host
  has been tested (OPEN-OSFLOOR).
- **Signing tier** — ad-hoc, `TeamIdentifier=not set`, Gatekeeper rejects it:
  a local candidate, exactly as labelled (OPEN-LOCAL-TRUST, which is EXT-SIGNING).

## 7. Blocked: the install, and what follows it

The candidate cannot replace `/Applications/Mona.app` without administrator
authorization. That single command is the whole prerequisite:

```sh
sudo installer -pkg packaging/macos/out/Mona-0.1.0-macOS-arm64-local.pkg -target /
```

The package in `packaging/macos/out/` is the exact build 147 this document
describes (`e54b2cff…`); it is gitignored, so if the tree is rebuilt, write the
new digest down here before installing.

After it, in this order:

1. `node scripts/r13-candidate-verify.mjs --smoke --launch` against
   `/Applications/Mona.app` — the same report with `graceful_shutdown` now
   measured.
2. The interactive pass the prompt names: open an existing project, select an
   archived thread, type `/` and dispatch a view command, press Enter (newline)
   and Command-Enter (submit), enter and leave Focus Studio and native
   fullscreen, queue a follow-up and answer a pending request if one appears,
   read the usage HUD against the Cost screen, export and restore a handoff, and
   quit from the menu.
3. `npm run mac:package:local` again — the `installed_copy` gate then passes and
   the install gates (package smoke against `/Applications`, LaunchServices GUI
   launch) run for the new build.
4. New captures from the installed build; the pre-review captures do not certify
   it.

## 8. Evidence

| Artifact | What it is |
|---|---|
| `artifacts/r13-candidate-verify.json` | The verifier's report: 16 checks, all true, against the `/Applications` copy of build 147 at `cf433aa`, with the package smoke and the LaunchServices launch; `shutdown: not tested — duplicate_copy_notice`. |
| `artifacts/r13-package-report.json` | The build's own gate report for build 147 (copied out of the gitignored `packaging/macos/out/`): metadata, architecture, dependencies, secrets, payload expansion and both rehearsals. |
| `artifacts/r13-uninstall-rehearsal.json` | The 11 uninstall sub-checks with the commands' own output (same copy). |
| `scripts/r13-candidate-verify.mjs` | The verifier itself, re-runnable against the installed app after the install. |

Reproduce: `npm run mac:package:local` (stops at `installed_copy`), then the
verifier above. It starts no engine and makes no model request.

## 9. What is not proven

1. **The installed candidate.** Build 147 has not been installed; `/Applications`
   still holds build 104. Every interactive acceptance item is therefore unproven
   for this build.
2. **Graceful shutdown of this build** from a real window. It is proven for the
   installed build 104 and structurally for the source (the lifecycle smoke's
   quit phase), but not for 147 as a packaged app.
3. **Finder Service handoff from the packaged Service**, and the installed
   Service's enabled state (`enabled: null` at P21), remain human checks.
4. **The 14.x OS floor** and a clean recipient without CLT are unexecuted
   (OPEN-OSFLOOR, OPEN-GIT).
5. **Clean-host Gatekeeper acceptance** is impossible for an ad-hoc build by
   definition; R14 and EXT-SIGNING own it.
