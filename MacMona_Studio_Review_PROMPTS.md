# MacMona — Repository review and Studio evolution prompts

**Prepared for Victor by Astra · November 13, 2026 · Review 1.0**

Repository: <https://github.com/king-felix/Mona_MacOS-MacMona>

**Reviewed baseline:** `main` at `10d8375e9644c0563178a9d4b645d1a0ef8c999a` (“Studio: stop calling plumbing and known frames ‘unrecognized’”). The review used a local clone of this exact source. Reconcile newer source before applying recommendations. This file supplements the existing macOS specification and prompts; it does not restart Mona.

**Companion:** `MacMona_Review_Hotfix.patch`, a small, tested source patch against that baseline. It is not an installed app or a published GitHub change. The larger Studio, command and visual features below still require implementation on the Mac.

Patch SHA-256: `a253a05e5205438b01492d8ff7840291189605d8aee99f4f7516c4b4182aa4fb`. The patch applies cleanly to the reviewed commit (`git apply --check` verified). GitHub has not been changed by this review.

## 1. Start here

Put this file and the companion patch in the repository, then paste:

```text
Continue MacMona using MacMona_Studio_Review_PROMPTS.md. Start R00.
Read AGENTS.md and the current macOS handoff/state/blockers first. Preserve
all existing work, decisions, unresolved issues and attempt counts.

This is a review-and-enhancement pass on the existing app, not a rebuild.
Reconcile HEAD against the reviewed commit. Validate/apply the companion
hotfix only where it is still needed, and preserve newer changes.

My priorities are correct durable conversations, a beautiful splashier
interface, a fullscreen Studio showing the agent turn and prompt composer
with a slim factual dashboard, descriptive Codewhale command autocomplete,
Enter for newline and Command+Enter to submit, and better ways to watch and
communicate with agents. Keep Codewhale's provider route and API economics.

You may implement, run tests, install useful development tools/tool servers,
and make coherent local commits. Use existing authorized remote rules;
do not publish a release, purchase signing services or invent a remote.

After three attempts at one problem without material progress, stop that
problem, record evidence and exact help needed, then continue independent
eligible work. If the assignment is blocked, checkpoint and involve me.
Do not lower requirements, erase attempts or architect around the problem.

Complete R00 through validation, evidence and handoff, then report.
```

For subsequent sessions:

```text
Resume MacMona's Studio review sequence under
MacMona_Studio_Review_PROMPTS.md. Read the review handoff/state and relevant
original macOS blockers. Resume the unfinished review prompt, otherwise
the first eligible one. Preserve counts and verify actual evidence.
Finish that prompt end to end and checkpoint before reporting.
Keep Enter as newline, Command+Enter as submit, no background inference,
and the persistent three-attempt rule.
```

For a longer authorized run:

```text
Complete the next three eligible R prompts, beginning with any unfinished
one. Checkpoint after each and continue within this queue. Keep the
three-attempt rule, continue independent work around nonblocking issues,
and report when this queue is complete or genuinely blocked.
```

## 2. Review findings: evidence, impact and disposition

These are source findings and controlled local reproductions, not a claim to have exercised Victor’s installed Mac app. The review environment is Linux/Node 24; it cannot qualify Finder, native fullscreen/Spaces, VoiceOver, signing, notarization or the arm64 helpers.

| ID | Priority / finding | Evidence at reviewed baseline | Action |
|---|---|---|---|
| RV-01 | High: accepted send can erase newer draft text, including another project’s draft | `src/renderer/shell/Shell.tsx:796`: prompt captured before awaits; accepted branch clears current `draftRef`, uses its current thread ID, and lacks selection/draft-revision reconciliation | R01; source-level race, not reproduced on Victor’s machine |
| RV-02 | High: stale async project/runtime results can overwrite current UI | `Shell.tsx:273` selection has no request generation; `:325` guards detail but applies `studioResult` unconditionally; several action completion handlers also apply state after awaits | R01; inspect all callbacks, not just refresh |
| RV-03 | High: replacement imports retain old journal rows and cursors | `src/main/state/store.ts:5800`; `events` and `event_cursors` have no thread FK and were not explicitly removed before deleting threads | Reproduced; companion patch deletes both transactionally and tests unrelated-project preservation |
| RV-04 | High: timeline merges separate threads into one answer | `src/renderer/shell/timeline.ts:60` at baseline accumulates one `openDelta`, matching only kind; `ALPHA` from A + `BETA` from B becomes `ALPHABETA` | Reproduced; patch isolates projection per thread and keys; R02 extends to item/turn identity |
| RV-05 | Medium: heartbeat splits streaming text into duplicate-looking cards | Baseline `timeline.ts:110` flushes on plumbing frames; delta `ALPHA`, heartbeat, delta `BETA`, completion `ALPHABETA` yields `ALPHA` + `ALPHABETA` | Reproduced; patch keeps plumbing from ending a message |
| RV-06 | High usability: older conversation is not truly pageable | `src/main/projects/service.ts:220` asks for latest 200 raw events; Studio only reveals earlier entries inside that window; raw deltas/heartbeats can consume the window | R02; distinguish bounded rendering from complete accessible history |
| RV-07 | User request: no composer Command+Enter handler | `src/renderer/shell/Studio.tsx:567` at baseline has only onChange; Send also allows empty text until backend validation | Patch adds scoped shortcut, IME/repeat guards and shared empty/busy/canSubmit gate; R01 adds robust single-flight protection |
| RV-08 | User request: Focus Mode is not immersive fullscreen | Existing Focus hides inspector and some facts; `styles.css:3545` still uses a clamped 48vh timeline, surrounding shell remains | R05; evolve existing mode rather than another competing shell |
| RV-09 | User request: no descriptive slash-command autocomplete in Studio | Composer submits ordinary prompt text; capability inventory exists but is not a complete TUI slash-command catalog | R03–R04; discover exact pinned commands; never send `/new` to the model pretending it is a local action |
| RV-10 | High usability: in-app approval/clarification replies are missing | `src/main/work/studio.ts:169` returns text saying Mona cannot answer; recommends another client or switching permission mode | R07; qualify actual reply APIs; do not use broader permission as a workaround |
| RV-11 | Medium: source formatting blocks the full CI entrypoint | Four existing files fail formatting: `src/main/engine/adapter.ts`, `src/main/ipc.ts`, `src/renderer/shell/Settings.tsx`, `test/runtime-process.test.ts`; `scripts/ci.mjs` runs format first | R00 / R12; formatting-only changes separate from behavior |
| RV-12 | Release gap, already documented: local package is not friend-ready signed distribution | `packaging/macos/build.mjs:1546` release mode still refuses; original P22 signing prerequisite and P24/P26/P27 remain relevant | R14; finish existing release chain, do not rename ad-hoc build “signed release” |
| RV-13 | Visible function gap: attachments disabled | Studio’s Attach file button explicitly says pinned adapter does not support attachments | R10; qualify supported file context, never fabricate upload support |

Related risks for R01/R02: draft-save acknowledgements can label a newer unsaved draft as saved; duplicate submit events arrive before React busy state is updated; `showAll` and follow-scroll state survive project changes; completed-card keys differ from streamed-card keys; one thread can interleave multiple item IDs. These are targeted test obligations, not assertions that every scenario has already been reproduced.

### What the review actually tested

- Original focused tests: **24 passed** across state-portable, studio-screen and studio-render.
- New regression tests failed on the original implementation for replacement cleanup, shortcut/gating, cross-thread stream merging and heartbeat splitting.
- With the companion patch: **29 focused tests passed**; TypeScript typecheck passed.
- A broader run before the final timeline patch excluded native-dependent suites: **757 passed, 1 failed** across 76 files. Failure: APFS-style Unicode normalization expectation on Linux in `folder-request.test.ts`. Treat it as host-dependent evidence to recheck on macOS, not permission to weaken Mac behavior. This is not a full final-patch CI pass.
- Lint had no errors and three existing `no-explicit-any` warnings. Full formatting failed on the four existing files above; an ephemeral diagnostic file was also reported during review and was removed, not shipped.
- Original untouched build ledger validated at **revision 732**, 0 errors/warnings. Patching `store.ts` makes historical P10/P19 source-hash references stale. Do not “repair” that by blindly replacing hashes and claiming old native tests covered new bytes.
- The changed six files pass the repository secret scanner. A repository-wide scan flags key-shaped strings in `scripts/terminal-smoke.mjs:30` and `test/settings-workbench.test.ts:546`; the inspected lines are test/smoke fixture inputs. R12 must verify their provenance and resolve scanner noise narrowly without disabling secret detection. No claim is made that every credential-shaped string in the repository has been audited.

The patch changes six files: store, Studio, timeline and their three focused test files. It does not fix R01 races, introduce slash dispatch, redesign the visual system or implement native fullscreen. Review/application instructions deliberately preserve that distinction.

Permanent source entry points: [Shell](https://github.com/king-felix/Mona_MacOS-MacMona/blob/10d8375e9644c0563178a9d4b645d1a0ef8c999a/src/renderer/shell/Shell.tsx), [live Studio](https://github.com/king-felix/Mona_MacOS-MacMona/blob/10d8375e9644c0563178a9d4b645d1a0ef8c999a/src/renderer/shell/Studio.tsx), [timeline](https://github.com/king-felix/Mona_MacOS-MacMona/blob/10d8375e9644c0563178a9d4b645d1a0ef8c999a/src/renderer/shell/timeline.ts), [state store](https://github.com/king-felix/Mona_MacOS-MacMona/blob/10d8375e9644c0563178a9d4b645d1a0ef8c999a/src/main/state/store.ts), [runtime work service](https://github.com/king-felix/Mona_MacOS-MacMona/blob/10d8375e9644c0563178a9d4b645d1a0ef8c999a/src/main/work/studio.ts).

### What is already worth preserving

The app has a substantial working foundation: versioned engine adapter, owned-process supervisor, durable SQLite state, explicit unknown-cost handling, local prompt favorites, cost ledger, update/restore guards, bounded preview output, a real capability explorer and native packaging. The latest changes correctly distinguish per-thread `previous_seq` from globally allocated sequence numbers. Keep those invariants; do not regress into assuming every arithmetic gap is lost data.

## 3. The Studio experience to build

### Immersive Studio

One command turns the current Studio into a conversation-first workspace: **slim dashboard, agent timeline, prompt composer**. All three remain in one app/window and use the same underlying state. No duplicate runtime, new conversation, new polling loop or provider call on mode changes.

Provide two distinct controls: **Focus Studio** fills the content/window area and hides rail/inspector/nonessential chrome; **Enter Full Screen** uses native macOS fullscreen and the same focused layout. Reuse existing Focus Mode and ⌘⇧F for focus. Use the standard native fullscreen menu/shortcut through the existing window boundary, with actual enter/leave events as authority. Do not pretend a fixed-position div is native fullscreen. Store layout preference; never force a restored window into fullscreen without explicit user action.

Dashboard normally occupies about 44–56 logical pixels, wrapping gracefully at large text sizes. Show project, active thread/agent, honest activity/connection state, elapsed time, requested/effective model where available, session or turn cost with its scope, input/output/cache tokens with their scope, and always reachable Pause/Interrupt. Unknown price is “unpriced,” not `$0.00`; no fabricated live token counter. Put secondary diagnostics in a popover/drawer. Keep a clear exit control; normal macOS traffic-light/menu behavior still works.

Timeline consumes the remaining height. Composer starts at three lines, grows to a sensible cap, and can be resized with pointer and keyboard; it must never push the entire live turn off-screen. Draft focus/selection, scroll anchor, active turn and in-flight controls survive entering/leaving focus, fullscreen, resizing and project navigation. Escape dismisses autocomplete/dialogs before leaving focus; it never interrupts work or discards a draft. Native fullscreen exit remains consistent with macOS behavior.

### “Aurora Studio” visual direction

Victor’s explicit request: make it **splashier, cooler and more fun to use**, while preserving clarity. This is a product requirement, not optional end-of-project polish.

- **Daybreak:** porcelain/lilac canvas, saturated iris controls, deep ink text, sea-glass highlights and restrained hot-coral accents. A project header may use an iris-to-cyan wash behind an opaque readable content layer.
- **Afterglow:** midnight indigo canvas, amethyst-raised panels, electric orchid/violet focus accents, luminous mint active-state accents and warm coral attention. Avoid uniformly gray cards with one purple button.
- Candidate decorative accents: iris `#795CFF`, orchid `#C16CFF`, cyan `#38CFE8`, mint `#55E3B3`, coral `#FF7E96`. These are not preapproved text/background pairs. Existing measured foreground tokens remain until replacements pass contrast tests.
- Add a distinct project monogram/plaque, thin gradient separators, selective luminous edges, confident type hierarchy, visually differentiated user/agent/tool turns, and a richer active-project rail. Put color in headers, borders and identity—not behind every paragraph/code block.
- Use restrained depth and a few rich surfaces. Avoid continuous animated backgrounds, giant glass blurs, particle fields, fake terminals and saturated text walls. Content remains the star.
- Activity animation follows genuine state: a small running indicator, a brief completion transition, static attention marker when input is needed. A disconnected or stalled agent must not look busy because decoration keeps pulsing. Reduced motion removes pulses/transforms without removing meaning.
- Provide an **Appearance → Vivid / Quiet** preference, with Vivid the new expressive treatment and Quiet retaining calmer chrome. Both themes remain fully usable; this is decoration intensity, not a second app design or lower-contrast mode.
- Validate the real production shell and representative long sessions. The repository also has design/demo screens; changing only `src/renderer/design/screens/Studio.tsx` does not satisfy this request. The live entry is `src/renderer/shell/Studio.tsx`.

### Watching and talking to agents

Make work understandable from real events: a compact “Now working on…” strip derived from current tool/task; expandable tool cards with command/path, start/end/duration/exit status when actually available; error and pending-input badges; turn dividers; readable streamed Markdown; copy answer/code controls; jump to latest; unread count while scrolled back; search within the conversation; optional agent/thread filter. Do not generate fictional progress percentages or ask another model to narrate the work. Display only engine-exposed reasoning/status, never invent hidden reasoning.

Support three explicit message intentions where qualified: **reply to this pending question**, **send a follow-up after the current turn**, and **steer the current run**. They must not share one ambiguous Send button. A follow-up is bound to its project/thread and has edit/cancel visibility. “Delivered” requires a native acknowledgement; queued is not delivered. Steering is offered only if the pinned engine supports it. Typing, opening history, switching themes, autocomplete and dashboards make zero provider calls.

## 4. Execution and continuity rules

Use the existing macOS ledger tools for original requirements and native evidence. Store this review’s subordinate plan in `.mona/build-macos/reviews/studio-v2/` with `state.json`, `HANDOFF.md`, `DECISIONS.md`, `BLOCKERS.md` and evidence references. Do not replace original P00–P27 tasks, hand-edit the generated requirement structure or overwrite the Windows ledger. Track R00–R15 and RV-01–RV-13, plus user feature IDs UX-FULLSCREEN, UX-COMMANDS, UX-COMPOSER, UX-AURORA and UX-AGENT-COMMS.

Each task record includes status, prerequisites, source/spec hashes, affected requirements, completed and remaining acceptance, tests and exact artifact hashes, platform, unresolved attempts and next action. Use atomic writes/revision checks. Record which evidence is static review, fixture/DOM, native Mac, or human observation. Preserve the original three-attempt enforcement through `monabuild attempt/reopen` with stable issue IDs; a subordinate queue is not an excuse to reset counts. Generate concise handoffs rather than rereading every source file each session.

Read applicable AGENTS instructions first. User-authorized implementation and normal developer installations continue autonomously; no unnecessary confirmation for routine local work. Reuse the pinned engine `0.10.2`/recorded commit unless Victor explicitly accepts a qualified upgrade. Pin any additional dependency, inspect provenance and keep the payload economical. Prefer existing React/CSS components over bringing in another large UI framework.

Finish one assigned prompt through code, focused validation, docs and a coherent checkpoint; report and pause unless a queue is explicitly authorized. Three attempts without material progress stops that problem. Continue truly independent work when possible, otherwise involve Victor with the smallest concrete missing prerequisite. Never remove tests, broaden permissions, swap the engine or declare a feature unsupported solely to evade implementation.

Keep new UI deterministic and local. Use fixture streams for nearly all UI work. Any live test uses the existing authorized Flash route and remaining approved budget; no automatic model switch, paid reviewer, background summary or compulsory multi-agent swarm. No credentials/private chat in screenshots, reports, heap snapshots or Git. Before commits run the repository’s secret scan. Remote commits follow existing owner authorization; this guide does not authorize publication of a release.

### Dependency map

| Prompt | Deliverable | Depends on |
|---|---|---|
| R00 | Adopt review, hotfix and baseline evidence | None |
| R01 | Draft/submission/project race fixes | R00 |
| R02 | Complete identity-aware conversation history | R00 |
| R03 | Verified slash-command catalog and autocomplete | R00, R01 |
| R04 | Safe command execution and new-thread lifecycle | R02, R03 |
| R05 | Focus Studio and native fullscreen | R01, R02 |
| R06 | Aurora visual identity | R05 |
| R07 | In-app pending input and approvals | R01, R02 |
| R08 | Follow-ups, qualified steering and agent observatory | R04, R07 |
| R09 | Slim factual usage/dashboard | R05, R08 |
| R10 | Everyday composition/review conveniences | R03, R04, R05 |
| R11 | Responsiveness, accessibility and display QA | R06, R08, R09, R10 |
| R12 | Regression suite, ledger and evidence reconciliation | R11 |
| R13 | Native installed-artifact qualification | R12 |
| R14 | Shareable Mac release prerequisites and pipeline | R13 |
| R15 | Final review handoff and exact artifacts | R13; R14 outcome recorded |

R14 can remain externally blocked by missing signing credentials. R15 can deliver an honestly labeled local candidate plus the exact release blocker; it cannot claim friend-ready distribution. Parallelizable here means dependency independence, not a requirement to spawn agents.

## 5. Numbered implementation prompts

### R00 — Adopt the review and apply verified hotfixes

**Read:** this file, AGENTS, current macOS state/handoff/blockers, touched source and companion patch.

**Implement:** Record current HEAD, dirty files and newer fixes. Validate the original ledger before edits. Against the reviewed baseline, `git apply --check MacMona_Review_Hotfix.patch` should succeed. If HEAD changed, inspect the diff and adapt only missing fixes; no hard reset or blind three-way overwrite. If the patch is absent, reproduce its four behavior fixes from the finding descriptions and tests. Keep its regression tests.

Create the subordinate R registry and mapping. Separate formatting cleanup for the four pre-existing files from behavioral edits. Record native source-hash evidence invalidated by the patch without simply rehashing old reports. Do not restart P00 or reset prior blockers.

**Acceptance:** Replacement clears old events/cursors and leaves another project intact; same sequence can be recorded afresh; separate threads cannot merge streamed text; heartbeat does not create a duplicate answer; Enter remains newline; ⌘Enter submits only with valid gate/IME/repeat state. Run the three focused test files and typecheck; establish actual Mac baseline checks.

**Evidence/checkpoint:** `docs/evidence/macos/review-studio/R00-baseline.md`, patch application/adaptation list, original and current test results. Preserve original artifact reports as historical.

### R01 — Make drafts and asynchronous navigation lossless

**Read:** `Shell.tsx` persistDraft/selectProject/refreshSelected/submitTask/action handlers, project bridge, draft storage and IPC contracts.

**Implement:** Give each selection/load an epoch and discard out-of-date responses for both detail and studio. Prevent a slow A load from replacing a later B selection, including A→B→A. Scope async busy/error/notice updates too. A refresh must not apply stale data simply because the project ID happens to match again.

Capture immutable submission identity: project, thread, draft revision, text and mode. Claim a synchronous single-flight guard before the first await; repeated click/⌘Enter must not dispatch twice. On acceptance clear only the submitted draft revision, never current text typed since dispatch or another project’s draft. Serialize saves per draft key or enforce revision/CAS ordering in main/storage so an old save cannot overwrite newer text. Never mark newer text saved when an older write returns. Check save failures and try/finally cleanup. Preserve uncertain/rejected submissions and text. Audit favorite insertion, quit and project switch flushing under the same rules.

**Acceptance:** Deferred-promise tests exercise typing during send, switch during send, reversed project responses, delayed save acknowledgement, rejected IPC, duplicate submit, A→B→A and restart. Exact sent bytes/target stay correct; no text disappears; no busy latch remains stuck. Reuse one submission path for button and shortcut.

**Evidence/checkpoint:** R01 race matrix with relevant before-fix failures and after-fix results. This is the first prerequisite for more interactive agent communication.

### R02 — Build complete, identity-aware history and stable streaming

**Read:** `projects/service.ts`, `state/store.ts` event queries, `project-bridge.ts`, `timeline.ts`, live Studio, event ingestion and existing D-099/D-100 evidence.

**Implement:** Replace the inaccessible fixed raw-event tail with a paginated/cursor API and incremental thread/turn/item projection. Preserve available envelope identity through persistence and IPC; do not match deltas merely by kind. Add schema migration only where needed, with backups and explicit unknown identities for old rows. Preserve thread isolation from the hotfix; keep keys stable across streamed/completed cards. Never infer loss from arithmetic global-sequence holes.

Backfill sufficiently to reconstruct an item whose beginning predates the page, or show an honest partial-item affordance that loads it. Page historical conversations without fetching the entire DB. Unknown event types remain inspectable; heartbeat/accounting stays quiet. Reset project-specific follow/show-history state correctly. Anchor older-page insertion and “Jump to latest” without dragging a reader down on every event. Add thread/session selection; current-turn and archived history must be distinguishable.

**Acceptance:** Long turn with >2,000 raw frames, >10,000 stored events, interleaved thread/item IDs, duplicate replay, heartbeat between deltas, true replay gaps, interrupted items and completed cards. Earlier messages remain reachable; page load neither sends a model request nor duplicates visible text. Project/thread switch preserves correct drafts and scroll state.

**Evidence/checkpoint:** R02 projection/paging contract, fixtures and actual Mac long-session smoke. The hotfix alone is not full R02 completion.

### R03 — Descriptive Codewhale autocomplete

**Read:** Current capability inventory/explorer, pinned engine source/help, composer and key handlers. Inspect actual TUI slash-command registry for the recorded version; CLI subcommands and Runtime endpoints are not the same catalog.

**Implement:** A validated catalog with canonical slash name, aliases, short useful description, argument schema/hints, scope, side effects, cost class, native version/provenance, execution route and support state. Include `/new` only with its verified semantics. Enumerate every command in the pinned registry and reconcile differences; do not hard-code a handful from memory or use a model to generate descriptions at runtime.

At a command position, typing `/` opens an accessible suggestion list with filtering, description panel, arguments and clear unsupported/terminal-only explanation. Respect cursor/selection, composition, multiline text, literal slash paths, fenced pasted code and escaped slash text. Arrow keys choose; Tab accepts. Plain Enter still inserts a newline, per Victor’s explicit preference. Escape closes the list first. ⌘Enter on an incomplete/ambiguous command selects nothing silently: explain what remains. Explicitly typed complete commands use the same dispatch flow as the button.

**Acceptance:** Catalog provenance/coverage fixture; IME, selection replacement, pointer, keyboard, screen reader and 200% zoom tests. No provider request from lookup/filter/help. No ordinary text accidentally classified as a command. Missing execution routes stay visible rather than silently disappearing.

**Evidence/checkpoint:** R03 registry, command coverage table and native autocomplete captures using real supported commands/descriptions.

### R04 — Execute commands correctly; make /new real

**Read:** R03 catalog, engine adapter/contracts, thread persistence, studio session bindings, submission recovery and project drafts.

**Implement:** Dispatch typed command actions in the main process through validated operation-specific IPC and qualified native APIs. Never interpret arbitrary slash input as shell text or send a recognized local command to the model as a fallback. TUI-only commands get an honest route/help; require explicit terminal launch where that is the only supported semantics. Aliases share validation. Destructive or permission/model-changing commands use existing appropriate review boundaries and show effects.

Implement `/new` with fresh engine conversation identity while preserving old thread/history/draft/usage/attempt evidence. Handle active work explicitly: refuse or offer the proper wait/interrupt choice; never detach a running turn and claim it moved. Durable operation keys make retry/acknowledgement loss safe. Thread selection and new-thread creation must not reset project state or implicitly raise permission. Preserve literal-text escape for a user who actually wants to discuss a command.

**Acceptance:** Every executable catalog row has positive/negative routing tests and no shell injection. `/new` is tested idle, busy, disconnected, response-lost, restart and project-switch scenarios. Any native API limitation is recorded and escalated; no fake successful action.

**Evidence/checkpoint:** R04 command-to-native route matrix, targeted receipts and effects on old/new thread IDs and costs.

### R05 — Implement the immersive Studio

**Read:** §3 above, existing FocusMode paths, `menu-template.ts`, `window.ts`, IPC sender validation, shell layout and state.

**Implement:** Evolve the existing focus toggle to hide outer rail/inspector/excess banners while retaining essentials. Add native fullscreen control and observed-state reporting through narrow window-scoped IPC. Preserve macOS menu/Spaces behavior; native transitions are asynchronous and their events—not an optimistic boolean—drive UI. Keep view preference separate from OS fullscreen state.

Build the slim dashboard, viewport-filling timeline, bounded resizable composer and optional overlay drawers. No 48vh/clamped console in immersive mode. Keep interrupt/exit/context identity visible. Prevent double-toggle between menu accelerators and DOM shortcuts. Respect dialog/autocomplete Escape priority. Avoid remounting the Studio/runtime when changing layout.

**Acceptance:** Real Mac tests: enter/leave focus and native fullscreen while streaming, typing, scrolled back, awaiting input and with drawers open; restore window bounds; change monitor/scale; keyboard-only exit. Composer text/selection and stream remain intact, no new turn/connection starts, no UI feature becomes unreachable at 200%.

**Evidence/checkpoint:** R05 screenshots in normal/focus/native-fullscreen states, native event trace and layout/accessibility checks.

### R06 — Make Aurora Studio feel wonderful to use

**Read:** §3 visual direction, actual production `Studio.tsx`, `Shell.tsx`, `styles.css`, `design/tokens.ts`, icons/primitives and contrast tests.

**Implement:** Apply the richer Daybreak/Afterglow color, depth and identity across Studio, rail, Home and key controls—not just demo screens. Add the project plaque, vivid active selection, subtle gradient edges, turn hierarchy, clean tool cards and expressive but readable dashboard. Extend centralized tokens for decoration; avoid scattered inline magic colors. Introduce Vivid/Quiet appearance preference with local persistence.

Use animation sparingly for genuine transitions and live state; it stops/reduces when hidden, idle or reduced-motion is on. Do not use an animation to imply progress that the engine has not reported. Keep conversational text and code on stable high-contrast surfaces. Remove redundant banners/technical text from the main flow by moving details into inspectable drawers without hiding failures.

**Acceptance:** Production-shell captures for both themes and intensities, normal and immersive Studio, long answer/tool output, empty/error/pending-input states and narrow/200% layouts. Measured contrast, focus rings, reduced motion, no idle animation CPU regression. A reviewer can clearly see a richer visual identity than baseline without sacrificing information density.

**Evidence/checkpoint:** R06 before/after screenshot set, tokens/contrast report and concise rationale for visual choices. Do not call a CSS change visually verified without viewing the rendered result.

### R07 — Let Victor answer agents inside Mona

**Read:** `work/studio.ts` pendingInputFor/ingest/snapshot, event/adapter contracts and actual pinned request/reply endpoints.

**Implement:** Persist pending questions/approvals as structured requests with IDs, project/thread/turn, allowed answers/options, status and acknowledgement. Show the actual question/tool/action and permissions involved. Implement native answers through typed, authenticated IPC where supported. Handle expired, answered, cancelled and duplicate response cases; reconnect restores outstanding requests.

Remove guidance that suggests switching to Full Access to bypass an unanswered approval. Preserve the chosen mode. If a required reply API is absent, show exact unsupported scope and involve Victor after the bounded investigation; do not create a replacement engine or pretend an ordinary message answered the request. Do not promise another client can attach unless that path is verified under the current store-ownership rules.

**Acceptance:** Ask/Plan and Work fixtures; actual supported reply/approval round trip; lost acknowledgement; stale UI; multiple request IDs; project change. “Reply sent” requires acknowledgement. Cancelling UI does not silently approve. Request state survives restart and coexists with an unsent normal draft.

**Evidence/checkpoint:** R07 request/reply contract, native evidence and remaining engine limitations.

### R08 — Follow-ups, steering and an agent activity view

**Read:** R01/R02/R04/R07, work board/controller, agent observatory and native scheduling ownership.

**Implement:** Let Victor compose during work and explicitly queue a follow-up for after the current turn. Store immutable target identity and editable/cancellable queue items; never auto-send a half-written draft on completion. Dispatch only within the authorized queue and existing budget/attempt controls. Do not add a second scheduler that competes with native agents or board tasks.

Offer “Steer this run” only if verified native capability exists, with separate receipt/status. Otherwise explain the supported after-turn option without claiming equivalent semantics. Add an unobtrusive current-activity strip, expandable tool cards, duration/status, agent/thread filter and Needs-you indicator grounded in native events. Optional notifications use existing app controls and are quiet while the relevant work is already visible.

**Acceptance:** Turn completes while composing, queue cancelled before dispatch, switch/new thread while queued, pause/budget stop, uncertain send, restart and child-agent cases. Exactly one owner dispatches, target stays stable, queued and delivered remain distinct, no fabricated thoughts/progress and no background narration calls.

**Evidence/checkpoint:** R08 queue/state tests and native activity/communication walkthrough.

### R09 — Slim dashboard with trustworthy costs and tokens

**Read:** Existing cost ledger/contracts, Studio cost/usage fields, review §3 and R05/R08.

**Implement:** A compact always-readable HUD with scope labels for current turn, current thread and project totals. Reuse stored native usage and cost projections. Tokens may update only at receipt time—show that honestly. Input/output/cache figures must match native definitions and avoid double-counting cached input. “Waiting for usage,” “unpriced” and partial totals remain distinct from zero.

Show elapsed time from actual state; distinguish last event from last meaningful work and from disconnected. Do not let a heartbeat become “the agent is thinking.” Keep model/permission details available without filling the strip. Popovers expose provenance and budget state; controls stay reachable at enlarged text sizes.

**Acceptance:** Missing/partial/cache/replayed usage, imported old history, new-thread boundaries, reconnect, no active run and long sessions. HUD agrees with Cost screen and does not re-query provider on a timer. Animation/layout changes create zero inference calls.

**Evidence/checkpoint:** R09 accounting fixtures and production HUD captures with complete/unknown/partial costs.

### R10 — Composition, navigation and review conveniences

**Read:** Prompt favorites/shelf, file context capability, changes panel, Markdown/clipboard boundary and user preferences.

**Implement:** Add copy message/code, local conversation search with anchored results, clear Jump-to-latest/unread affordance, resizable composer, keyboard shortcut help, and prompt history/favorites insertion that preserves intentional unsent text. Copy exact text; show success only after clipboard acknowledgement. Preserve selection/focus.

Add safe project-file mentions/picker only through a verified context mechanism. If the engine accepts text context but not binary attachments, expose those as different operations with size/token implications and explicit submission. Do not bypass file containment or quietly send whole repositories. Unavailable binary upload stays honestly unavailable. Let tool/change cards open the existing scoped Changes view; model output paths are untrusted inputs, not generic filesystem access.

**Acceptance:** Escaped/Unicode paths, large snippets, unsupported attachments, clipboard failure, search after pagination, project/thread switch, restored drafts and keyboard-only use. No hidden inference for convenience features and no data loss from template insertion.

**Evidence/checkpoint:** R10 focused journeys and capability/status updates.

### R11 — Performance, accessibility and visual regression

**Read:** Original performance/accessibility requirements, production new surfaces, all affected tests and native smoke scripts.

**Implement:** Bound rendering with actual pagination/virtualization, incremental projection and memoization where measurements justify it. Do not retain whole raw histories in the renderer to make scrolling easy. Profile repeated thread/project switches, long streams, fullscreen transitions and expanded output. Do not game memory with forced GC/working-set trimming or remove features to pass.

Test native VoiceOver announcements and focus navigation, IME, reduced motion, 200% interface scale and real macOS display scaling, both themes/intensities, multiple monitors and long localization-sized labels. Streaming should not repeatedly announce the full conversation. Command suggestions should expose descriptions and selection state correctly. Avoid global key handlers submitting from dialogs/terminal or breaking normal textarea editing.

**Acceptance:** Required native/manual checks are either observed or explicitly pending. Report packaged cold/warm startup, idle CPU/memory, active stream responsiveness and layout results using defined comparable workloads. Preserve existing performance targets; get an explicit exception rather than silently raising them.

**Evidence/checkpoint:** R11 measured results, screenshots and smallest remaining human checklist. Xvfb/jsdom/Linux is not proof of macOS fullscreen, VoiceOver or physical scaling.

### R12 — Reconcile regression checks and build evidence

**Read:** Original CI script, ledger tooling, new review records, baseline failures and all changed modules.

**Implement:** Run required focused/native tests and `npm run ci` on the M3. Fix genuine failures; keep formatting-only edits separate. Address asynchronous React test warnings with correct awaiting/act boundaries rather than silencing them. Add regression coverage for new public contracts, not merely implementation-shaped assertions.

Update stale requirement evidence through supported ledger tools only after rerunning the affected validation. Preserve historical evidence with its original commit/artifact association. Keep P22/P24/P26/P27 external prerequisites explicit. Validate review graph, state schema and hashes, source changes, generated requirements and secret scan. Avoid mixing product task state with build task state.

**Acceptance:** Full required Mac checks pass or the report names the exact blocker; no forced-green hash refresh, removed assertion or hidden skip. New UI behaviors and data fixes have current tests tied to source. A Linux normalization failure alone has not rewritten Mac path requirements.

**Evidence/checkpoint:** R12 validation manifest and updated authoritative/subordinate handoffs.

### R13 — Qualify the installed Mac candidate

**Read:** Existing packaging/local install flow, component manifests, smoke tools and R12 results.

**Implement:** Build the native arm64 local candidate and verify the exact payload. Exercise the installed app through LaunchServices/Finder, not only `npm start`: new/resumed project, thread selection, actual command autocomplete/dispatch, newline/⌘Enter, focus/fullscreen, queued follow-up or pending response, costs, export/restore and graceful shutdown. Use the authorized live route only for the few necessary real interactions.

Run update/restore/uninstall rehearsals under the established isolated-root guards; never risk the owner’s production app or project data to test cleanup. Preserve provider configuration and do not kill independent Codewhale processes. Check payload contains required native binaries and new resources without developer paths or secrets. Reinstall/reverify after changes; old screenshots do not certify new artifacts.

**Acceptance:** Exact installed bytes show the new features and pass native smoke. Record build ID, hash, macOS version, architecture and signing tier. Verify clean-recipient prerequisites such as Git/CLT honestly; resolve original scope decisions instead of hiding dependencies.

**Evidence/checkpoint:** R13 installed-artifact report and current screenshots. Local/ad-hoc remains a local candidate.

### R14 — Finish the existing shareable Mac release path

**Read:** Original P22/P24/P26/P27, EXT-SIGNING/OPEN-LOCAL-TRUST/OS-floor/Git blockers, current packaging and update trust code.

**Implement:** With already available authorized credentials, implement the existing Developer ID signing/notarization/stapling/release verification path and test the exact distributable under genuine download/quarantine conditions on a clean target. Preserve the update trust model and native helper signing requirements. Do not publish, purchase enrollment, accept agreements or invent hosting.

If credentials are missing, finish scripts, preflight, CI/local dry validation and a precise prerequisite checklist; mark native public trust verification blocked. Code containing a “release” branch that still throws is not a working release pipeline. Do not remove the safeguard merely to obtain a file named release. Reconcile minimum tested OS and clean-host Git/tool prerequisites with original release scope.

**Acceptance:** Either an exact signed/notarized/stapled, clean-host-qualified candidate with provenance, or an explicit blocked shareable-release status plus completed independent work. No bypass-Gatekeeper recipe counts as recipient readiness.

**Evidence/checkpoint:** R14 release status and exact owner prerequisite. No public upload occurs under this prompt.

### R15 — Final handoff and honest completion

**Read:** All review tasks/findings/feature IDs, native evidence, original open blockers and artifact manifests.

**Implement:** Audit that each defect and requested feature has an outcome, tests and correct status. Refresh owner documentation and shortcuts; explain literal slash text, command descriptions, Enter/⌘Enter, focus versus fullscreen, steering versus follow-up and cost scope. Include before/after production UI captures and concise release notes.

Promote exact tested artifact bytes—no rebuild after qualification while retaining old hashes. Commit coherent source/docs/state locally after secret scan. Follow existing remote authorization; no release publication. Keep the reviewed patch/test history traceable but do not claim the initial patch alone implemented the larger sequence.

**Acceptance:** All required review work is complete, or remaining items are explicitly partial/blocked with exact help needed. Report working features, tests, source commit, actual installed build, artifact paths, signing tier and next action. Preserve the three-attempt ledger and do not reset original unfinished macOS prompts.

**Evidence/checkpoint:** R15 final review matrix, artifact manifest and owner handoff.

## 6. Finish report format

```text
Review prompt: R__ — completed / partial / blocked
Behavior: what changed for Victor
Validation: actual checks, platform, source/artifact identity
Open issues: stable IDs, attempts and exact prerequisite
API impact: expected/observed extra calls or none; usage uncertainty
Checkpoint: commit, evidence and handoff
Next: first eligible prompt and exact action
```

The desired outcome is an app Victor enjoys opening: a vivid, calm-to-read studio where the real work is visible, commands are discoverable, conversations remain intact and sending a message never puts project state at risk. The colors and animations should make that experience more expressive; correctness, cost visibility and continuity are what make it trustworthy.
