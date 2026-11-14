# R15 — Final review handoff and exact artifacts

**Prompt:** R15 · **Status:** completed for the review sequence; two upstream
tasks stay blocked on prerequisites, not on work
**Platform:** darwin-arm64 · macOS 26.5.1 · Electron 45.3.0 · engine 0.10.2
**Source:** `a2bd168` on `main` (plus this handoff commit)
**Installed build:** **151** at `/Applications/Mona.app` (source `26c38c5`)
**Candidate in hand:** build **152** (`c9745dc`), package
`e4ffe0e0308866e2bf7185e24701b82a599dc49591f99aba83ef2592308c777d`
**Signing tier:** ad-hoc local. **Not a shareable release** — and it does not
claim to be.

## 1. The review matrix

Thirteen of sixteen review tasks are complete. The two that are not are blocked
on a privilege and on credentials; neither is blocked on code, and neither
consumed an attempt.

| Task | Status | Outcome |
|---|---|---|
| R00 Adopt the review, apply hotfixes | completed | 4 behavioural hotfixes reproduced and tested; formatting split out |
| R01 Lossless drafts and async navigation | completed | per-key serialized draft journal; stale outcomes labelled, never dropped |
| R02 Identity-aware history, stable streaming | completed | keyset paging by identity, archived/current threads, repaint-free streaming |
| R03 Verified command catalog and autocomplete | completed | 109 commands pinned from `GET /v1/commands`, annotated, `catalog:check` in CI |
| R04 Safe command execution, real `/new` | completed | route-qualified dispatch, `/new` lifecycle, refusal over invention |
| R05 Focus Studio and native fullscreen | completed | Focus layout vs OS fullscreen, read back from the window |
| R06 Aurora visual identity | completed | Daybreak and Afterglow, Vivid/Quiet, contrast pairs measured |
| R07 Pending input and approvals | completed | in-app cards over the engine's own reply routes |
| R08 Follow-ups, steering, activity | completed | durable queue with 7 statuses, steering named as unavailable, derived strip |
| R09 Slim usage HUD | completed | three labelled scopes, five honest states, residual counted once |
| R10 Composition and review conveniences | completed | slash handling, copy, jump-to-latest, search |
| R11 Responsiveness and accessibility QA | completed | windowed console, 200 % scale, keyboard-only traversal |
| R12 Regression, ledger, evidence | completed | 22 → 24 CI steps, act warnings 20 → 0, everything reconciled |
| R13 Installed-artifact qualification | **blocked** | installed build 151 qualified end to end; found and fixed one real defect; the fixed candidate needs one admin install |
| R14 Shareable release pipeline | **blocked** | pipeline finished and fails closed; two Developer ID identities and a notary credential are missing |
| R15 Final handoff | completed | this document, the owner guide, and the artifact manifest |

Findings: **17 of 18 verified**, one open (RV-12, the local package is not a
friend-ready signed distribution — that is R14/EXT-SIGNING by design). All five
user feature IDs (UX-FULLSCREEN, UX-COMMANDS, UX-COMPOSER, UX-AURORA,
UX-AGENT-COMMS) are verified.

## 2. What Victor gets

- **Enter is a newline, `⌘Enter` sends.** IME and plain Enter untouched; empty
  text cannot be sent. Proven by R00's tests and four shell-smoke checks.
- **Descriptive command autocomplete** from the engine's own catalog, with
  scope, effect, cost class and route on every row; literal slash text stays
  text; `Tab` accepts, `Escape` closes, `⌘Enter` explains an exact command.
- **Immersion:** Focus Mode (`⌘⇧F`) is Mona's layout; full screen (`⌃⌘F`) is the
  OS's, and the app reports the OS's answer rather than its own request.
- **Aurora identity:** Daybreak and Afterglow, each with Vivid and Quiet, at
  100 % and 200 %.
- **Conversations that survive:** drafts never lose newer text to an older
  acknowledgement; paged history holds the reader's card in place (that is the
  defect R13 found and fixed); replay cannot duplicate rows.
- **Talking to agents:** queued follow-ups with honest per-row status, pending
  replies and approvals in-app, an activity strip from stored events, and no
  "steer" button where the engine has no steering route.
- **Cost you can audit:** three scopes, five states, unknowns stated.

## 3. Validation — the actual checks

`npm run ci` — **24 of 24 steps, exit 0**
(`artifacts/r15-ci.txt`): format, lint, typecheck, `catalog:check`,
`build:supervisor`, `build:pty`, `build:service`, test, build, and twelve smokes
including the newly-gated `smoke:history`. **1,121 tests in 101 files.**
Renderer scan: 4 files, 0 secret patterns, 896,890 bytes.

Installed artifact, from its own bytes (`artifacts/r13-candidate-verify.json`,
`artifacts/r13-installed-pass.json`):

- verifier **16/16** — identity, build vs `HEAD`, 13 component digests, arm64
  only, minimum OS, native components, review channels, no developer paths,
  package acceptance sample, LaunchServices launch, measured shutdown;
- shell **137/137** (also driven through `open -na`), command **26/26**,
  immersive **60/60**, one live pinned-engine turn plus an interrupt **22/22**
  with cost observed and no provider switch.

Candidate build 152, same modes from its own bytes:
**137 + 26 + 60 + 19 = 242 checks, none failed**
(`artifacts/r13-candidate-pass-152.json`).

Release path (`artifacts/r14-*.txt`, `artifacts/r14-preflight.json`):
preflight exit 3, release exit 3, verify exit 2, 17/17 trust tests. No artifact.

Secret scan: 745 files, **0 findings**.

## 4. The defect this pass found, and the gate that now catches it

The history smoke, which was never in the CI list, had been failing since R11
windowed the agent console: R02's scroll anchor compared the list's height
growth with the viewport's movement, which is exact only while every card is
mounted. On a 10,054-event project every older page dropped the reader
**115.5 px** — one card. Fixed by anchoring on the card's identity and its pane
offset across the frames the new slice needs to measure itself; the smoke now
asserts the reader-visible contract (`anchor_offset` ≤ 2 px), proves the second
page by the projected list, and proves the third page is reachable by painting
it. `smoke:history` joined `scripts/ci.mjs` (RD-028). Nineteen checks, three
consecutive green runs, delta 0.

The general lesson is recorded rather than absorbed: a check that nothing runs is
not evidence. That is why R12's and R13's smoke-list additions are both in the
gate now.

## 5. Before / after

The review's own "before" state is the reviewed baseline
`10d8375e9644c0563178a9d4b645d1a0ef8c999a`, whose captures and findings are in
`R00-baseline.md` and `artifacts/r00-*`. "After" is captured from the running
product:

- **Studio, normal and 200 %:** `artifacts/r11-studio-200.png`,
  `artifacts/r11-studio-long-100.png`, `artifacts/r13-installed-studio-run.png`
- **Live turn, interrupt, offline history (installed build):**
  `artifacts/r13-installed-studio-live.png`,
  `artifacts/r13-installed-studio-offline.png`
- **Focus and native fullscreen:** `artifacts/r05-focus-windowed.png`,
  `artifacts/r05-native-fullscreen.png`, `artifacts/r13-r05-focus-200.png`
- **Commands:** `artifacts/r13-r03-command-menu.png`,
  `artifacts/r13-r03-command-menu-200.png`
- **Aurora:** `artifacts/r06-{daybreak,afterglow}-{vivid,quiet}-{home,studio}.png`
- **Long history:** `artifacts/r13-r02-history-long-session.png`
- **Activity strip and usage HUD, installed:** `artifacts/r13-p-r08-activity.png`,
  `artifacts/r13-p-r09-usage.png`

Captures are Electron page captures of the real windows. This host has no Screen
Recording permission, so there is no desktop recording; that limitation is stated
rather than papered over.

## 6. Release notes (this pass)

- Conversations: loading older history no longer moves what you are reading.
- History: the smoke that proves it now runs in CI on every change.
- Installability: the installed build was verified from its own bytes end to
  end, including a real turn and a real interrupt.
- Release: the pipeline refuses to produce anything without Developer ID and
  notary credentials, and verification refuses the local build.
- Documentation: `docs/owner-guide-macos.md` states every shortcut, the
  Enter/`⌘Enter` rule, literal slash text, Focus versus fullscreen, follow-up
  versus steering, cost scope, and each known limit with its reason.

## 7. The artifact manifest (exact bytes)

| Artifact | Identity |
|---|---|
| `packaging/macos/out/Mona-0.1.0-macOS-arm64-local.pkg` | build 152, sha256 `e4ffe0e0308866e2…`, 163,802,705 bytes, ad-hoc. **Gitignored** — the digest is the identity; a rebuild changes it. |
| `/Applications/Mona.app` | build 151, source `26c38c5`, manifest `31eaa3a3…`, ad-hoc |
| Source | `a2bd168` on `main` |
| Commits this pass | `4595829`, `daad4a6`, `9e2fc27`, `26c38c5`, `fdd300b`, `c9745dc`, `3d1cf29`, `a2bd168` (+ this handoff commit) |
| Review ledger | `.mona/build-macos/reviews/studio-v2/state.json`, revision 105, validate clean |
| Product ledger | `.mona/build-macos/state.json`, validate clean |

Installed build 151 and candidate build 152 are **different artifacts**, and this
handoff names both. The candidate is not promoted by being described.

## 8. What remains, exactly

1. **Install the fixed candidate** (R13 closes):
   ```sh
   sudo installer -pkg packaging/macos/out/Mona-0.1.0-macOS-arm64-local.pkg -target /
   node scripts/r13-candidate-verify.mjs --smoke --launch
   node scripts/r13-installed-pass.mjs
   npm run mac:package:local
   ```
2. **Signing credentials** (R14 closes): Developer ID Application + Installer
   from one team, plus `xcrun notarytool store-credentials mona-release`. Then
   `npm run mac:release:preflight`, `npm run mac:release -- --keychain-profile
   mona-release`, `npm run mac:verify-release`.
3. **Two scope decisions** (P26/P27): execute a 14.x matrix, and choose between
   bundling a relocatable Git (GPL source offer) and documenting the CLT
   dependency (RD-029).
4. **Original ledger:** P24 needs P22's signed artifact; P26 needs P24+P25; P27
   needs P26. None of these is reset or claimed by this review.

## 9. Attempt ledger and provenance

`.mona/build-macos/attempts.jsonl` is **empty**. No problem reached three
attempts, and none was reset. R13's and R14's blockers are recorded with exact
help needed and are explicitly not attempt-counted: a privilege and a credential
are missing, no hypothesis failed.

The companion hotfix (`MacMona_Review_Hotfix.patch`, sha256 `a253a05e…`) was
applied unmodified at R00 and its six files have not been reverted. It is
**not** claimed as the implementation of this sequence: the Studio features,
the command catalog, the history paging, the usage HUD, approvals, the visual
identity and R13's anchor fix are separate work, each with its own commit and
evidence.

## 10. Honest limits carried forward

Windows without CLT cannot use Git features; 14.x is untested; notifications
depend on a macOS permission this headless host refuses; the terminal is not a
VT100; fleets report no spend; workflows and lanes have no `/v1` route on 0.10.2;
sub-agent parentage is upstream-only; no screen recording exists on this host.
Each is named where it appears and in the owner guide.
