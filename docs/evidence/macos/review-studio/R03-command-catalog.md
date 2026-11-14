# R03 — Verified Codewhale command catalog and descriptive autocomplete

**Completed:** 2026-11-14 · **Platform:** darwin-arm64 · **Engine:** codewhale
0.10.2 (`ff466b2ed0bf`) · **Task:** R03 (depends on R00, R01) · **Feature:**
RV-09 / UX-COMMANDS

## Result

The Studio composer now opens a descriptive, keyboard- and pointer-operable
Codewhale command list at a command position. The list is built from the pinned
engine's own `GET /v1/commands` response — 109 commands captured from the
installed 0.10.2 binary, not written from memory and not described by a model.
Every row carries its canonical name, aliases, usage, engine summary, scope,
side effects, cost class, and a route claim: a documented Runtime API operation,
a TUI-only implementation, or an explicit unavailability on this engine version.
R03 catalogues and validates; R04 wires execution. A recognised command is
intercepted before submission and explained — it is never sent to the model as
a prompt.

## Provenance and capture

- Endpoint: `GET /v1/commands` on the runtime API of the installed engine.
- Engine: `codewhale 0.10.2 (ff466b2ed0bf)`, binary sha256
  `da0229610647f1cc2dd14c4227b333a92ea276a49f5d4d79160fa19e515e590d`,
  npm global install.
- Capture method: `node scripts/command-catalog.mjs --capture` starts an
  isolated `app-server --http` (temporary `CODEWHALE_HOME` and workspace, bearer
  token), reads the endpoint once, and stops it. It makes no turn and no model
  request. The captured runtime info reports `codewhale_version` 0.10.2 and the
  pinned commit; the script refuses a different version, commit, or binary hash.
- Raw capture: `docs/evidence/macos/review-studio/artifacts/r03-commands-capture.json`
  (sha256 in the generated catalog's `provenance.captureSha256`).
- Generated catalog: `src/shared/commands/pinned-commands.json` (never
  hand-edited). Curated annotations: `src/shared/commands/annotations.json`.
- Offline gate: `node scripts/command-catalog.mjs --check` validates the pin,
  the capture digest, unique names and spellings, nonempty descriptions,
  `usage` prefixes, and that every captured command has exactly one annotation
  with a valid scope/effect/cost/support/route. CI runs it through
  `test/command-catalog.test.ts`.

The TUI slash registry is not the CLI subcommand list. The CLI's `--help`
enumerates subcommands such as `serve` and `review`; only `/v1/commands`
enumerates `/goal`, `/new`, `/mcp`, and the rest of the composer's commands.
This is why the catalog was captured rather than inferred.

## Coverage

- 109 commands: **35** with a documented Runtime API route (R04 candidates),
  **69** TUI-only (Mona names the terminal route), **5** unavailable on 0.10.2.
- One hidden command, `/lane`; it is absent from the unfiltered list and appears
  when its name or alias is typed, so it neither disappears nor pollutes the
  default list.
- `/new` is catalogued with the semantics verified in
  `crates/tui/src/commands/groups/session/new.rs`: `/new [--force]` starts a
  fresh saved session, refuses while runtime work is active, and `--force`
  discards draft or queued input only. It is not treated as a model prompt.
- `/workflow`, `/workflows`, `/lane`, `/remote-env`, and `/attach` are
  unavailable for different reasons (no Runtime API route on 0.10.2; hosted
  environments report `environments=false`; Mona does not attach media before
  R10). They stay visible with their reason.

## Composer behaviour

- A command position is the start of a line, outside a fenced code block, not
  indented, and without a second slash. `/Users/me/notes.md`,
  `\/help`, fenced pasted code, and ordinary prose remain prompt text.
- Typing `/` opens a labelled listbox (`aria-label="Codewhale commands"`) with
  the selected option described by `aria-activedescendant`. Filtering is
  deterministic: exact name, exact alias, name prefix, alias prefix, name
  substring, summary substring; ties break by discovery class, name length, and
  name.
- ↑/↓ move the selection; **Tab accepts** (replacing exactly the token and
  restoring the caret); plain **Enter remains a newline**; **Escape closes the
  list first** and leaves the draft; a pointer click accepts a row. A text
  selection closes the list so accepting cannot discard it.
- IME composition suppresses the list and the keyboard handlers; a composing
  ⌘Enter does nothing.
- ⌘Enter on an exact command explains its route. An exact command with a
  required argument (`/anchor`, `/agent`, `/review`, …) explains what remains.
  An ambiguous prefix (`/he`) names its matches and selects nothing. Paths and
  unknown slash text are submitted as ordinary prompts. The Send button and
  ⌘Enter share the same classification path.
- No lookup, filter, selection, or help action starts a runtime, opens a socket,
  or asks a model. The command smoke asserts the Studio connection remains
  **Not started** throughout.
- The list floats above the composer on the side with room, measured from the
  composer input and clamped to the viewport. At 200% page zoom it switches to a
  compact list (no detail/footer) with its own scrolling; the page does not
  overflow horizontally and the list stays inside the window.
- A *bare* command prefix (`/hel`) is reported as ambiguous and selects nothing.
  A prefix followed by words (`/the release is broken`) is prose and is sent:
  a description match is a suggestion, never a classification. Exact name or
  alias is the only thing that becomes a command.
- `aria-expanded`/`aria-controls`/`aria-activedescendant` are set only while a
  listbox with rows is rendered, so the combobox never points at a missing
  element; the zero-match header is a polite live region, and arrow keys keep
  their normal caret behaviour when there is nothing to choose.
- A restored or replaced draft clamps the tracked caret to the new text, so a
  probe is never taken at a position the user cannot see.
- When the catalog cannot be read at all, single-line slash text is refused with
  an explanation rather than sent as a prompt; a leading space still sends it as
  literal text.

## Tests and gates

- Focused: **102 tests in 5 files** — catalog provenance/coverage, pure parser
  and ranking, submission intents, Studio listbox interaction and axe audit,
  IPC validation, and real-Shell interception.
- Full: **891 tests in 85 files** (was 852 in 83 at R02).
- Typecheck clean; lint 0 errors (3 pre-existing `no-explicit-any` warnings);
  `prettier --check .` clean.
- `scripts/command-catalog.mjs --check`: ok, 109 commands, 69 TUI-only, 5
  unavailable. The gate also runs in `npm run ci` (`catalog:check`) right after
  typecheck; it starts no process and touches no network.
- Real Electron command smoke: **25/25** checks
  (`docs/evidence/macos/review-studio/artifacts/r03-command-smoke.json`),
  including real key events, a real Tab acceptance, the ambiguous and TUI-only
  notices, no runtime start, and the 200% zoom geometry. Captures:
  `r03-command-menu.png`, `r03-command-menu-200.png`.
- Existing shell smoke: **127/127** with Electron exit 0 on the new composer.

Command:

```sh
node scripts/command-catalog.mjs --check
npx vitest run test/command-catalog.test.ts test/composer-commands.test.ts \
  test/studio-screen.test.tsx test/shell-races.test.tsx test/ipc-contract.test.ts
npx vitest run
npm run typecheck && npm run lint && npx prettier --check .
npm run smoke:commands
npm run smoke:shell
```

## Limitations carried forward

- **Nothing executes yet.** R04 owns operation-specific IPC and the native
  route for each `runtime-api` row. Until then a recognised command is explained
  and left in the composer; it is never sent to the model.
- **`support` is a route qualification, not a promise.** `runtime-api` means a
  documented `/v1` operation exists to wire; it does not claim Mona has tested
  that operation for this command. `tui-local` means only the TUI implements it.
- **The catalog is pinned.** The menu compares the live studio's engine
  version/commit with the capture and states a drift; it never re-qualifies the
  catalog or silently upgrades the engine.
- **Annotations are curated.** Scope, side effects, and cost are conservative
  reading of the engine's usage and implementation at the pinned commit. R04
  must revise a row that real execution contradicts, rather than preserving a
  wrong label.
- **Descriptions are the engine's English strings.** There is no runtime
  generation and no translation layer in R03.
- **The 200% compact list drops the detail/footer.** The list remains scrollable
  and every row still carries its summary and support badge; the full route
  explanation is available at normal zoom and in the submission notice.
- **Capture and screenshot bytes are run records.** A re-run of the command
  smoke rewrites its report and captures; re-record their hashes before the next
  checkpoint. The catalog capture is deterministic apart from `capturedAt` and
  the isolated port.
- **A composed draft is not the provider request.** The list explains what a
  command is; it does not claim to preview the model request (0.10.2 exposes no
  such inspection).
- **The shell smoke remains visually nondeterministic in a few captures**
  (terminal output and notification timing); the committed bytes are the ones
  this checkpoint recorded, and a later run may rewrite them.

## Review pass

An independent review ran against the R03 tree and returned **FAIL on evidence,
not on behaviour**: the recorded shell-smoke report predated the final composer
bytes. It also found five real defects, all fixed with tests:

1. **Over-blocking prose** — any nonempty `rankCommands` result made a line
   "ambiguous", so `/the release is broken` was refused because `the` prefixes
   `/theme`. Ambiguity now requires a bare name/alias prefix; a description or
   substring match is only a suggestion.
2. **Dangling ARIA references** — `aria-controls`/`aria-expanded` were set when
   the token existed, but the listbox renders only with rows. They now follow
   the rendered listbox, and the zero-match header is a live region.
3. **Swallowed arrow keys** — `preventDefault()` ran before the emptiness check,
   stranding the caret when nothing matched. It now runs only when a row exists.
4. **Stale caret after a draft replacement** — a project switch could probe a
   position from the previous draft. The tracked caret is clamped to the text.
5. **An over-tall floor** — the measured panel could exceed the room available
   on a very short viewport. It is now capped to that room.

The reviewer's evidence finding was closed by re-running the shell smoke
(127/127) and the command smoke (25/25) on the final bytes and re-recording
every affected hash before the checkpoint.

## Command coverage table

| Command | Aliases | Discovery | Scope | Cost | Support | Route | Summary |
|---|---|---|---|---|---|---|---|
| `/advisor` | watchers, watch | primary | thread | may-spend | terminal-only | tui-local: Toggles the session advisor in TUI state; no Runtime API operation documented. | Toggle the background advisor for this session |
| `/agent` | daili | primary | thread | may-spend | terminal-only | tui-local: Creates a persistent sub-agent session through a TUI turn; /v1/agent-runs only inspects and cancels existing runs. | Open a persistent agent session |
| `/anchor` | maodian | advanced | thread | none | terminal-only | tui-local: Session-scoped context anchors live in the TUI; no Runtime API operation documented. | Pin a fact that stays when Codewhale makes room |
| `/attach` | image, media, fujian | primary | thread | none | unavailable | unavailable: Mona's composer does not attach media (RV-13); typed turns accept image input but this command is TUI-only. | Attach media (@path for text files or folders) |
| `/auth` | — | primary | account | none | terminal-only | tui-local: Browser OAuth flows belong to the TUI; provider API keys are the only credential route Mona exposes, through P16 settings. | Manage provider sign-in |
| `/auto` | — | primary | thread | unknown | terminal-only | tui-local: Auto-Review is a TUI workflow surface; the engine exposes no Runtime API operation for it on 0.10.2. | Work with Auto-Review — skip a goal or workflow |
| `/automation` | automations, scheduled | primary | engine | may-spend | runtime-api | /v1/automations/{id}/pause, /v1/automations/{id}/resume, /v1/automations/{id}/run, /v1/automations/{id}/runs | Manage scheduled automations; list opens the manager |
| `/balance` | — | advanced | account | none | terminal-only | tui-local: Provider balance is read by the TUI; no Runtime API operation documented. | Check your provider account balance |
| `/branch` | — | primary | session | none | terminal-only | tui-local: Moves the session's active branch pointer; /v1/threads/{id}/fork creates a sibling but does not select a branch entry. | Point the branch at an entry without rewriting history |
| `/cache` | — | advanced | thread | none | terminal-only | tui-local: Cache statistics are rendered by the TUI diagnostics commands. | Show cache hit/miss stats for recent turns |
| `/change` | — | advanced | engine | none | terminal-only | tui-local: Reads the bundled release notes; no Runtime API operation documented. | Show what's new |
| `/clear` | qingping | primary | thread | none | terminal-only | tui-local: Clears the live TUI conversation; no Runtime API operation documented. Mona must not substitute a new thread silently. | Clear conversation history |
| `/color` | colour | primary | ui | none | terminal-only | tui-local: Composer color is terminal presentation. | Set this chat's composer box color |
| `/compact` | yasuo | primary | thread | may-spend | runtime-api | /v1/threads/{id}/compact | Shrink the context to free space |
| `/config` | — | primary | engine | none | runtime-api | /v1/config, /v1/config/reload | Inspect and change settings — raw keys under advanced detail |
| `/connect` | — | primary | account | none | terminal-only | tui-local: Plugin-provider browser sign-in is a TUI flow. | Connect a plugin provider with browser sign-in |
| `/constitution` | law | primary | engine | none | runtime-api | /v1/constitution, /v1/constitution/preview | See and amend your constitution |
| `/context` | ctx | advanced | thread | none | runtime-api | /v1/threads/{id}/context | Open the context inspector |
| `/copy` | — | primary | ui | none | terminal-only | tui-local: Copies to the terminal clipboard. | Copy the last completed assistant response to the clipboard |
| `/cost` | — | primary | thread | none | runtime-api | /v1/usage, /v1/threads/{id}/usage | Show session cost breakdown |
| `/diff` | — | advanced | workspace | none | runtime-api | /v1/diff, /v1/workspace/diff | Show changes since this session started |
| `/disconnect` | — | primary | account | none | terminal-only | tui-local: Removes a provider sign-in from the engine's own credential store; no Runtime API operation documented. | Remove a plugin provider's local sign-in |
| `/edit` | — | advanced | thread | may-spend | terminal-only | tui-local: Rewinds and resubmits the last message in the TUI; no single Runtime API operation documented. | Edit and resend your last message |
| `/effort` | thinking, reasoning, reason | primary | thread | none | terminal-only | tui-local: Sets the session's reasoning effort for later turns; the Runtime API has no per-thread effort write. | Set reasoning effort (also /thinking) |
| `/exit` | quit, q, tuichu | primary | ui | none | terminal-only | tui-local: Quits the TUI; Mona's own lifecycle controls the app. | Quit |
| `/export` | daochu | primary | session | none | terminal-only | tui-local: Writes a sanitized export from the TUI; no Runtime API export operation documented. | Copy a safe export, or write it to a file |
| `/feedback` | — | primary | workspace | none | terminal-only | tui-local: Drafts a local issue report file; no Runtime API operation documented. | Draft and review local issue reports |
| `/fleet` | — | primary | engine | may-spend | runtime-api | /v1/fleet/runs, /v1/fleet/runs/{run_id}/start, /v1/fleet/runs/{run_id}/stop | Inspect and set up your Fleet and its agents |
| `/fork` | f | primary | session | none | runtime-api | /v1/threads/{id}/fork, /v1/threads/{id}/fork-at-turn | Fork the active conversation into a sibling session |
| `/fullscreen` | — | primary | ui | none | terminal-only | tui-local: Terminal alternate screen; R05 owns Mona's native fullscreen. | Fill the whole terminal (alternate screen) |
| `/goal` | — | primary | thread | may-spend | runtime-api | /v1/goals, /v1/threads/{id}/goal, /v1/threads/{id}/goal/complete, /v1/threads/{id}/goal/block | Work toward one objective across turns |
| `/help` | ?, bangzhu, 帮助 | primary | ui | none | terminal-only | tui-local: Renders the TUI help surface. Mona browses this catalog locally instead; R04 owns the local help action. | Commands, skills, and keys |
| `/hf` | huggingface | advanced | engine | none | terminal-only | tui-local: Hugging Face MCP setup and concepts are TUI help. | Inspect Hugging Face MCP setup and concepts |
| `/home` | zhuye, shouye | primary | ui | none | terminal-only | tui-local: TUI home screen. | Open home without leaving the current conversation |
| `/hooks` | hook, gouzi | primary | engine | none | runtime-api | /v1/hooks | Manage lifecycle hooks in Extensions |
| `/hotbar` | hotkeys | primary | ui | none | terminal-only | tui-local: Terminal hotbar setup. | Set up the Hotbar |
| `/import-claude` | import_claude | primary | engine | none | terminal-only | tui-local: Plans and applies a settings import in the TUI; no Runtime API operation documented. | Plan a reviewable import of Claude Code settings and servers |
| `/init` | — | primary | workspace | may-spend | terminal-only | tui-local: Generates AGENTS.md through an LLM turn (init.rs delegates to AppAction::SendMessage). | Generate AGENTS.md for this project |
| `/inline` | — | primary | ui | none | terminal-only | tui-local: Terminal scrollback presentation. | Stay inline, keeping the terminal's scrollback |
| `/jobs` | job, zuoye | primary | workspace | none | runtime-api | /v1/jobs, /v1/threads/{id}/jobs/{job_id} | Manage background shell jobs |
| `/lane` | lanes | hidden | engine | may-spend | unavailable | unavailable: Checked-in workflows and Lanes expose no Runtime API route on 0.10.2 (P18 covered this; MONA-CAP-018/019). | Watch and control durable Lanes |
| `/links` | dashboard, api, lianjie | primary | ui | none | terminal-only | tui-local: Prints documentation and community links. | Show Codewhale, community, and provider links |
| `/load` | jiazai | primary | session | none | terminal-only | tui-local: Imports a session file into the TUI; the Runtime API lists and resumes sessions, it does not import files. | Load a session from file |
| `/login` | — | primary | account | none | terminal-only | tui-local: Account sign-in and key storage are TUI flows; P16 owns Mona's provider-key route. | Sign in to Codewhale or store provider keys |
| `/logout` | — | primary | account | none | terminal-only | tui-local: Deletes saved provider keys and account state after confirmation; never offered as a casual desktop action. | Sign out and return to setup |
| `/lsp` | — | advanced | workspace | none | runtime-api | /v1/lsp | Toggle LSP diagnostics |
| `/mcp` | mcps | primary | engine | none | runtime-api | /v1/apps/mcp/servers, /v1/apps/mcp/tools | Open or manage MCP servers; init adds one, doctor checks it |
| `/memory` | — | primary | engine | none | terminal-only | tui-local: Engine structured memory is managed in the TUI; P19's Memory screen reads Mona's own records, not this store. | Inspect or manage persistent structured user memory |
| `/mode` | jihua, zidong | primary | thread | none | terminal-only | tui-local: Changes the session permission mode. No Runtime API write is documented; Mona must never widen permission implicitly. | Switch permissions or open the mode picker |
| `/model` | moxing, route | primary | engine | none | runtime-api | /v1/providers, /v1/providers/{id}/switch, /v1/config | Switch or show the current model |
| `/modeldb` | model-reference, modelref | advanced | engine | none | terminal-only | tui-local: Browsed from the bundled database in the TUI. | Browse the bundled model database |
| `/models` | moxingliebiao | advanced | engine | none | runtime-api | /v1/providers, /v1/providers/{id}/models | List live model IDs from the active API |
| `/network` | — | advanced | engine | none | terminal-only | tui-local: Network allow/deny rules are a TUI config surface. | Manage network allow/deny rules |
| `/new` | — | primary | session | none | runtime-api | /v1/threads, /v1/sessions/{id}/resume-thread | Start a fresh session |
| `/note` | — | primary | workspace | none | terminal-only | tui-local: Workspace notes are written by the TUI; no Runtime API operation documented. | Jot, list, edit, or drop workspace notes |
| `/overview` | stats | primary | thread | none | terminal-only | tui-local: TUI home dashboard; Mona has its own Home and Studio dashboards. | Show the home dashboard |
| `/permissions` | permission-rules, permission_rules | primary | engine | none | terminal-only | tui-local: Lists and removes saved permission rules; no Runtime API rule-management operation documented. | List and safely remove permission rules |
| `/pet` | — | primary | ui | none | terminal-only | tui-local: Terminal animation surface. | Use the animated pet as your main Codewhale view |
| `/pin` | mini, window-pin | primary | ui | none | terminal-only | tui-local: Pins the terminal window on top. | Pin this window on top |
| `/plugin` | plugins, extensions | advanced | engine | none | runtime-api | /v1/apps/plugins, /v1/apps/plugins/install | Manage trusted plugin bundles (legacy tools stay separate) |
| `/preview-request` | dryrun, preview_request | advanced | thread | none | terminal-only | tui-local: Composes a redacted preview in the TUI. No provider-request inspection route exists on 0.10.2 (D-087). | Preview the next request (redacted) without sending it |
| `/profile` | dangan | advanced | engine | none | terminal-only | tui-local: Switches a named config profile; the Runtime API is bound to the profile it started with. | Switch to a named config profile |
| `/provider` | — | primary | engine | none | runtime-api | /v1/providers, /v1/providers/{id}/switch, /v1/providers/{id}/key | Switch provider or model |
| `/purge` | qingchu | advanced | thread | may-spend | terminal-only | tui-local: Triggers agent context pruning/offloading; the follow-up work is model-driven. | Let the agent prune or offload history to free context |
| `/queue` | queued | primary | thread | none | terminal-only | tui-local: Queued messages are TUI session state; no documented Runtime API queue operation. | See or edit queued messages |
| `/rc` | remote-control | primary | session | none | terminal-only | tui-local: Hands the session to the Codewhale web app; account flow, no Runtime API operation documented. | Resume this exact session from your Codewhale web account |
| `/receipts` | receipt | primary | thread | none | runtime-api | /v1/threads/{id}/receipt, /v1/threads/{id}/turns/{turn_id}/receipt | Show what this session did: files, commands, approvals |
| `/relay` | batonpass, 接力 | advanced | session | none | terminal-only | tui-local: Creates a session relay for a fresh thread; remote/account setup is TUI-driven. | Create a session relay for a fresh thread |
| `/remote-env` | — | primary | session | unknown | unavailable | unavailable: The pinned runtime reports environments=false; hosted Work is not available on this build. | Open new hosted Work from a GitHub or CNB branch tip |
| `/rename` | gaiming, chongmingming | advanced | session | none | runtime-api | /v1/sessions/{id} | Rename this session |
| `/restore` | — | primary | workspace | none | runtime-api | /v1/snapshots, /v1/snapshots/{id}/restore | Roll the workspace back to a turn snapshot |
| `/resume` | r | primary | session | none | runtime-api | /v1/sessions/{id}/resume-thread, /v1/sessions | Resume a session, or import a session JSON file |
| `/retry` | chongshi | primary | thread | may-spend | runtime-api | /v1/threads/{id}/retry | Retry the last request |
| `/review` | shencha | primary | workspace | may-spend | terminal-only | tui-local: Runs a structured review through a model turn; no single Runtime API review operation documented. | Run a structured code review on a file, diff, or PR |
| `/rlm` | recursive, digui | advanced | thread | may-spend | terminal-only | tui-local: Opens a persistent recursive context; model-driven TUI session. | Open a persistent RLM context for a file or text |
| `/router` | — | primary | engine | none | terminal-only | tui-local: Configures the per-turn Auto router; P16 validates saved-route changes but not this router setup. | Set up the per-turn router for Auto model routing |
| `/save` | — | primary | session | none | terminal-only | tui-local: Writes a session export file; no Runtime API operation documented. | Save this session to a file |
| `/sessions` | — | primary | session | none | runtime-api | /v1/sessions, /v1/sessions/summary, /v1/sessions/{id} | Open session history; archive and prune manage old ones |
| `/settings` | — | advanced | ui | none | terminal-only | tui-local: Opens the TUI settings surface. | Open settings |
| `/setup` | — | primary | engine | none | terminal-only | tui-local: Interactive TUI setup wizard; Mona's Settings screens cover the parts P16/P17 qualified. | Set up providers and preferences |
| `/share` | — | advanced | session | none | terminal-only | tui-local: Publishes a session URL through the Codewhale account; no Runtime API operation documented. | Share this session as a web URL |
| `/skill` | jineng | primary | engine | none | runtime-api | /v1/skills, /v1/skills/install, /v1/skills/{name}/trust, /v1/skills/{name}/update | Use, install, or trust a skill |
| `/skills` | jinengliebiao | primary | engine | none | runtime-api | /v1/skills | List local skills or browse the curated registry |
| `/stash` | park | primary | thread | none | terminal-only | tui-local: Parks the TUI composer draft; Mona's DraftJournal owns its own drafts. | Park or restore a composer draft |
| `/status` | — | advanced | thread | none | terminal-only | tui-local: Session status readout; Mona's own dashboard reports the same facts from stored records. | Show session status |
| `/statusline` | — | primary | ui | none | terminal-only | tui-local: Footer configuration. | Choose footer items |
| `/structcopy` | — | primary | session | none | terminal-only | tui-local: Copies a redacted session object to stdout or the clipboard. | Copy one session object as redacted JSON; not a model tool |
| `/subagents` | agents, zhinengti | compatibility | thread | none | runtime-api | /v1/agent-runs | Shortcut for /fleet workers: this session's agents |
| `/system` | xitong | advanced | thread | none | terminal-only | tui-local: Shows the TUI's composed system prompt; no provider-request inspection route exists on 0.10.2. | Show the system prompt |
| `/task` | tasks | primary | thread | may-spend | runtime-api | /v1/tasks, /v1/tasks/{id}, /v1/tasks/{id}/cancel | Manage background tasks |
| `/theme` | — | advanced | ui | none | terminal-only | tui-local: Terminal theme; R06 owns Mona's visual identity. | Pick a theme |
| `/title` | tabtitle, window-title | primary | ui | none | terminal-only | tui-local: Sets the terminal tab/window title. | Set the tab and window title shown in the terminal |
| `/tokens` | — | primary | thread | none | runtime-api | /v1/usage, /v1/threads/{id}/usage | Show token usage |
| `/tools` | tool-studio | advanced | thread | none | terminal-only | tui-local: Inspects the latest prepared tool request in the TUI. | Inspect the latest prepared tool request (read-only) |
| `/transcript` | — | primary | ui | none | terminal-only | tui-local: Terminal transcript overlay. | Open the live transcript overlay |
| `/translate` | translation, transale | primary | engine | unknown | terminal-only | tui-local: Toggles output translation in config; whether translated output is produced by a model is not stated, so cost stays unknown. | Toggle output translation |
| `/tree` | — | primary | session | none | terminal-only | tui-local: Renders the TUI session tree; no Runtime API graph operation documented. | Show session history as a tree (leaf = active branch) |
| `/trust` | xinren | advanced | workspace | none | runtime-api | /v1/workspace/status, /v1/workspace/trust | Change file trust for this session; --save also persists trust for project skills, commands, hooks, MCP servers, and context |
| `/turn` | turns | primary | thread | none | terminal-only | tui-local: Opens the TUI whole-turn inspector; Mona's timeline and receipts are the native equivalent. | Open the whole-turn inspector |
| `/undo` | — | primary | workspace | none | runtime-api | /v1/threads/{id}/undo, /v1/threads/{id}/patch-undo | Undo your last request and its file changes |
| `/update` | upgrade | primary | engine | none | terminal-only | tui-local: Updates the engine release binary from GitHub; Mona never upgrades the pinned engine implicitly. | Check for and install a new Codewhale release |
| `/verbose` | — | advanced | ui | none | terminal-only | tui-local: Shows or hides live reasoning in the TUI transcript. | Toggle live thinking in the transcript |
| `/voice` | yuyin, 语音 | primary | thread | unknown | runtime-api | /v1/voice, /v1/voice/dictate | Dictate into the composer |
| `/voicecontrol` | voice-control, yuyincontrol, 语音控制 | primary | thread | unknown | runtime-api | /v1/voice/control | Toggle voice control: dictation that knows your draft |
| `/voicesend` | voice-send, yuyinsend, 语音发送 | primary | thread | may-spend | runtime-api | /v1/voice/send | Toggle voice auto-send: say "send it" to submit |
| `/workbar` | rail, sidebar | advanced | ui | none | terminal-only | tui-local: Places the TUI workbar. | Place the workbar (bottom/top/left/right/off) |
| `/workflow` | wf | primary | engine | may-spend | unavailable | unavailable: Checked-in Workflows expose no Runtime API route on 0.10.2 (P18: MONA-CAP-018/019). | Run a repeatable, ordered workflow |
| `/workflows` | — | primary | engine | none | unavailable | unavailable: Lists TUI workflow runs; no Runtime API route on 0.10.2. | List or cancel workflow runs here |
| `/workspace` | cwd | primary | workspace | none | terminal-only | tui-local: Shows or switches the TUI workspace; a Runtime server is bound to the workspace it started with. | Show or switch the workspace; worktrees opens the manager |
