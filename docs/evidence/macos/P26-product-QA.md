# P26 — Whole-product QA and economics recheck

Status: **automated QA complete; human checklist outstanding** · Date: 2026-11-14 ·
Requirements: MONA-028 (with MONA-003, MONA-006, MONA-030, MAC-001, MAC-002,
MAC-006) · Build: **165**, `local`, arm64 · Engine: Codewhale 0.10.2
`ff466b2ed0bfb4ae5267d4d8d0ecb562cf46956e` (unchanged) · Source: `1a51903`

This prompt asks for the product a person would launch, not the source tree. Every
number below was measured on the **installed** bundle at `/Applications/Mona.app`
unless it says otherwise, and every claim names the file that contains the raw
measurement.

## Host and method

| Fact | Value |
|---|---|
| Machine | Apple **M3**, arm64 (the documented reference machine) |
| macOS | 26.5.1 (build 25F80) |
| CPUs / memory | 8 cores / 16 GiB |
| Display | scale factor 2, single 1280 × 800 window |
| Framework | Electron 45.3.0, Chrome 156.0.8078.96, Node 24.22.2 |
| App under test | `/Applications/Mona.app`, 0.1.0 build **165**, channel `local`, ad-hoc signed (the installed build at the time; the promoted artifact is 168, see `P27-release.md`) |

**Why the installed bundle.** The repository's smokes normally spawn `electron .`,
which proves the source tree. For P26 the harness was given `--app
/Applications/Mona.app` (`scripts/r11-smoke.mjs`), which spawns the binary
LaunchServices runs. The raw report is
`docs/evidence/macos/artifacts/p26-r11-installed.json`; the same run with axe
unavailable (the defect described below) is preserved as
`p26-r11-installed-axe-absent.json`.

Startup is measured inside the app from process start to the composer being
interactive (`facts.startup.process_start_to_interactive_ms`). Idle is 60 seconds
of sampling after warm-up. Typing and scrolling are measured in the renderer
against a **10,203-event** stored fixture.

## Budgets

| Budget | Target | Measured (installed) | Result |
|---|---|---|---|
| Warm startup to interactive | ≤ 2 000 ms | **1 347 ms** | pass |
| Cold startup to interactive | ≤ 5 000 ms | **1 316 ms** | pass |
| Idle CPU, 60 s average | < 1 % | **0.05 %** avg, 0.67 % max | pass |
| Typing, 10k events | smooth | p50 16.7 ms, **p95 16.8 ms**, max 17 ms (20 iterations) | pass — one frame at 60 Hz |
| Scroll, 10k events | smooth | p50 16.7 ms, **p95 17.1 ms**, max 18.5 ms (59 frames) | pass |
| Rendered cards at 10k events | bounded | **601 projected, 10 mounted**, 10,203 stored | pass |
| 200 % scale | fits, composer reachable | no overflow; composer visible and reachable; console keeps its height | pass |
| Reduced motion | animations stop | media query matches; **0 running animations** | pass |
| Accessibility (axe, live Studio) | no serious/critical | **0 blocking violations** | pass |
| Idle memory, total Mona processes | under 350 MiB | **551.7 MiB avg / 572.2 MiB max**, 4 processes | **exception** — see below |
| Engine memory, reported separately | — | **142.5 MiB** RSS + **7.7 MiB** supervisor, 0 model requests | measured |

### The memory budget exception, investigated rather than adjusted

The 350 MiB target is unmeetable by any application code on this host: Electron
with a window whose only content is an `<h1>` measured **364 MiB** in the same
harness (`scripts/r11-runtime-baseline.mjs`, same Electron 45.3.0, same host).
Mona's own share is therefore **≈ 188–208 MiB** — the difference between the
measured total and that floor. The target was not changed to the observed number;
the exception is derived from a measurement taken on the same machine and names
the one check it covers. With an owned runtime the total is 572.2 + 142.5 + 7.7 ≈
**722 MiB**, of which the engine is accountable for 150 MiB.

## The installed app, exercised

`node scripts/r13-installed-pass.mjs` drives the installed binary with each
mode's own fixture and asserts that no helper process survives. Mode `studio` was
added for P26 because it is the only mode that starts a runtime and spends
anything.

| Mode | Checks | Failures | What it proves |
|---|---|---|---|
| shell | **137** | 0 | catalog, studio, drafts, activity strip, follow-up queue, usage HUD, board, changes, cost, settings, palette, layout, zoom, both themes |
| command | **28** | 0 | slash-command autocomplete, keyboard selection, dispatch interception, 200 % scale |
| immersive | **60** | 0 | Focus Studio, native fullscreen transitions, composer and draft survival |
| history | **21** | 0 | keyset paging, item identity, archived/current selection, anchoring |
| studio | **22** | 0 | bundled engine start, **one real tool-enabled Full Access turn**, interrupt, offline history |
| **total** | **268** | **0** | every mode left **0** helper processes |

The studio run is the prompt's "real engine execution at least once through the
installed app": the installed bundle started its own runtime on its bundled
engine, wrote a file, ran a test that passed, rendered the tool card, reported
the effective route and Full Access posture, then interrupted a second turn and
retained history offline. Receipt: `p26-installed-studio.json`. Captures from the
installed build: `p26-p07-shell-home.png`, `p26-p07-shell-studio.png`,
`p26-p08-studio-run.png`, `p26-p08-studio-live.png`,
`p26-p08-studio-offline.png`.

## Zero inference

| Surface | Evidence |
|---|---|
| UI-only idle (60 s) | `facts.idle.inference_calls = 0` |
| Shell/command/immersive/history modes | no runtime started (`no_runtime_started`) |
| Settings workbench | `smoke:settings`: "no model turn was started", 22/22 |
| Reasoning workbench | `smoke:reasoning`: `store.summarizeUsage(...).turns === 0`, 11/11 |
| Board, memory, handoff, costs, digest | their smokes assert no turn; the only dispatch channel is `board:dispatch-next` |

Chrome, navigation, resume briefs, cost math and every settings read make no
model request. The only paths that do are an explicit composer submission and
`board:dispatch-next`, and both were exercised deliberately above.

## Economics

One installed-build turn, tool-enabled, Full Access, one file written and one
passing test: **$0.000440202**, `costComplete: true`, 1 turn
(`p26-installed-studio.json`). The ledger reports the cost as observed-and-complete
rather than estimated, and unknown stays unknown elsewhere.

Comparison with P01's economics baseline (`artifacts/p01-economics.json`): that
run recorded token counts but cost state `unknown` because pricing was not yet
resolved; P26's turn is priced end to end. The reasoning change shipped in this
build adds an explicit `reasoning_effort: "auto"` to the request, which the
engine resolved the same way before (its configured default was already `auto`),
so no token or cost increase is expected or observed. Confidence: one measured
turn, not a distribution — this is a bounded check, not a benchmark. No further
spend was incurred to manufacture statistical certainty.

## The twelve mandatory end-to-end scenarios

| # | Scenario | Status | Where it is proven |
|---|---|---|---|
| 1 | Folder → Finder Service → real edit and passing test → evidence card | machine-proven; the physical Service click is human | P09 driver (`P09-finder.md`), P21 Service smoke 21/21, studio 22/22 in the installed build |
| 2 | Existing dirty repository opens without losing or committing work | proven with fixture repositories | `p13-changes.json`, `changes-smoke`, `test/changes-screen.test.tsx` |
| 3 | Close/reopen UI mid-work keeps the task and costs no extra inference | proven on the installed build | `p23-lifecycle-smoke.json` (window-closed keeps work; Dock reopen same work) |
| 4 | Kill renderer, then app, then interruption; reconcile accurately | proven | `test/p20-failure-matrix.test.ts`, `smoke:lifecycle` crash rows, `p04-lifecycle-smoke.json` |
| 5 | Lose a submission response; no duplicate task, no false completion | proven | `test/engine-adapter.test.ts` outcome-unknown + reconcile; `p20-failure-smoke.json` |
| 6 | Three failed attempts block; unrelated work stays eligible; restart preserves the count | proven | `p11-attempts.txt`, `p11-board-sample.json` 37/37, `test/board-plan-status.test.ts` |
| 7 | Provider failure never changes model/route or launches paid fallback | proven | "makes one submission attempt and never switches provider or model"; locked routing policy in the settings snapshot |
| 8 | Child agents/workflows show truthful lifecycle, ownership, changes and usage | proven | `smoke:agents`, `p15-agents.md`; one real fleet run recorded in the handoff |
| 9 | Restore refuses conflicting or unsupported scope without destroying later work | proven | `restore` refusals in `p23-lifecycle-smoke.json`, `test/settings-restore.test.ts`, `safe-archive.test.ts` |
| 10 | Malicious output, paths, terminal links and imported prompt packs stay inside the boundary | proven | `no_link_navigation`, `no_injected_nodes` in the installed studio run; shelf secret scan; `safe-archive.test.ts` |
| 11 | Unknown runtime version disables unsafe operations but keeps offline project access | proven | `test/engine-compat.test.ts`, `engine-adapter.test.ts` incompatibility case, offline screens in the shell smoke |
| 12 | Quarantined signed installer on a clean Apple Silicon recipient | **blocked by decision, not by work** | D-103: no Apple Developer account, so no signed artifact exists to hand over. P24's harness reads the package and reports the 11 rows only a recipient can settle |

Eleven of twelve are machine-proven on this host. Number 12 cannot be proven here
and is not claimed; it is the same limitation `BLOCKERS.md` recorded for P22/P24.

## Defects found by this QA, and fixed

1. **The accessibility gate silently could not run in the installed build.** axe
   is a development dependency read from `node_modules`; the packaged app has no
   `node_modules`, so the check reported `axe_ran: false`. The gate was *failing
   the product* for a harness reason. Fixed by letting the harness hand the app
   the axe path (`MONA_R11_AXE_PATH`) instead of shipping a test-only dependency
   in the payload. Preserved evidence of the defect:
   `p26-r11-installed-axe-absent.json`.
2. **The performance harness could only measure the source tree.** `scripts/r11-smoke.mjs`
   now takes `--app <path>`; without it, P26's numbers would have described
   `electron .` and been labelled as the product.
3. **`scripts/r13-installed-pass.mjs` asserted "no engine is started" for every
   mode**, which stopped being true when the `studio` mode was added. The note is
   now mode-aware; a stale claim in the harness is the same class of error as a
   stale claim in the product.

## Requirement matrix (38 rows)

**26 satisfied · 10 partial · 0 pending · 2 blocked.** Full detail, per-row
evidence and notes: `docs/requirements-macos.json`. The ten partial rows each
name exactly what is missing:

| Requirement | Missing |
|---|---|
| MONA-006 | spoken VoiceOver walkthrough (human) |
| MONA-007 | transcript export to a file — copy, search and @file mentions exist |
| MONA-019 | one real managed fleet run at the owner's scale (P15 proved the routes; the workflow family is not on 0.10.2) |
| MONA-027 | the signed/notarized half, closed by D-103 |
| MONA-028 | the human half of QA (this checklist) |
| MAC-001 | the 14.0 OS floor is declared, only 26.5.1 has executed it |
| MAC-002 | spoken VoiceOver walkthrough (human) |
| MAC-003 | signed-recipient Keychain/upgrade behaviour, which D-103 removed from scope |
| MAC-004 | Git features need CLT or another Git (D-105) |
| MAC-008 | Windows coordination: no Windows source is available to compare |

Two rows are `blocked` by owner decision (MAC-005 signing/notarization, MAC-007
clean recipient). Nothing is `pending`: every row has either evidence or a named
reason.

## Capability matrix (75 rows, computed — not asserted)

| State | Count | Meaning |
|---|---|---|
| verified | 43 | an entry point exists and a named test exercised it |
| unqualified | 28 | an entry point exists and is named; no test exercised it (12 terminal-only routes, 15 advanced actions, 1 unavailable) |
| unavailable | 2 | no route on the pinned engine, stated with the reason |
| blocked gap | 2 | mandatory and unresolved, named |

72 of 75 rows carry an entry point; 51 have a tested one. The coverage report is
computed from the rows by `tools/p18-coverage/reconcile.mjs`, so a hidden or
awkward feature still counts, and `smoke:capability` fails if the file drifts from
the overlay. Full parity is **not** claimed while 28 rows are unqualified; none of
them is concealed or relabelled as an enhancement.

## What this QA cannot settle, and who must

These are the only items left for P26, and each needs a person at the machine.
They are collected here rather than spread through the document.

1. **VoiceOver walkthrough** (MONA-006, MAC-002). With Mona open on a project:
   enable VoiceOver (⌘F5), then Tab through the shell, the studio timeline, the
   composer, the board and Settings. Expect every control to announce a name and
   state, the timeline to be reachable by heading navigation, and no focus trap.
   Record pass/fail per screen. Automated axe and focus checks already pass; this
   is the spoken half.
2. **Aesthetic review of the captures** (`p26-*.png`). Look at
   `p26-p07-shell-home.png`, `p26-p07-shell-studio.png` and
   `p26-p08-studio-run.png`: spacing, contrast, and whether the live turn reads
   clearly. Automated contrast and fit checks pass; taste is yours.
3. **One real two-folder workflow at your pace.** Open a real project from the
   Finder Service, let one turn run against your own provider, close and reopen
   the window, quit, relaunch, and confirm the same task and cost are shown. The
   installed build already does this under fixtures; doing it on your work is the
   difference between qualified and proven-for-you.
4. **Scenario 12** stays blocked until a signed artifact exists (D-103). No
   amount of local work changes that.
