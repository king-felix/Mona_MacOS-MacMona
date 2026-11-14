# R10 — Everyday composition and review conveniences

**Task:** R10 · **Requirements:** MONA-007, MONA-014, MONA-024 · **Findings:**
RV-13 · **Platform:** darwin-arm64 · **Engine:** none started for the local
features; the file mention is one read through the engine's contained route.

## What shipped

### Copy, with an acknowledgement

`clipboard:write` is a strict-IPC channel in main. It writes with Electron's
clipboard and **reads the text back**, returning
`{written, label, characters, note}`. The renderer reports success only when
`written` is true; a clipboard that refused is an attention notice, and the
document is never modified by a copy.

Affordances:

- every timeline card has **Copy** (exact `entry.body`, the same bytes the card
  renders — including a truncated long body's visible prefix only when it is
  collapsed? No: the copy button copies the full body; the "show full output"
  control only changes what is displayed), labelled **Copy command** for tool
  cards;
- every fenced code block in rendered Markdown has **Copy code**, wired through
  `Markdown({onCopyCode})` so it hands back the block's source text, not the
  surrounding prose;
- nothing steals focus or selection: the buttons are siblings of the content.

### Conversation search, anchored

`projects:search` → `ProjectService.searchEvents` → `store.searchProjectEvents`:

- one project (and optionally one thread) only;
- `LIKE … ESCAPE '\'` with `%`, `_` and `\` escaped in the query, so `%` is a
  character and a query of `%%%` matches nothing;
- bounded: `LIMIT` ≤ 100 rows, newest first, over the stored `payload_json`;
- a hit carries an anchor — `threadId`, `seq`, `itemId`, `kind`, `timestamp` and
  a ±60/90-character snippet;
- it reads Mona's own SQLite state: no runtime, no socket, no model call.

The Studio toolbar shows the query, the match count and *"Local read only;
nothing is sent to the engine."*, lists up to eight hits, and jumps to one. The
jump sets an anchor; if the matching card is not in the loaded window the console
asks for one more page (`onLoadOlder`) until the card exists — it never claims a
match is on screen when the page has not loaded. The matched card gets an outline
and `data-anchored="true"`. Typing never leaves an older result list: the newest
search wins by token. Command-1…9 screen switching and Command-F (focus the
search field inside Studio) are documented in the shortcut dialog and in
Settings › Appearance › Keyboard, which now lists ⌘1–⌘9 (Memory was missing).

### Jump to latest and unread

While the reader is scrolled back, arriving frames increment an unread count; the
button becomes **"Jump to latest · N new events"**. The count is stated in
*events*, because that is what it counts — a heartbeat is an event, and calling it
a message would be a nicer number and a worse fact. The count resets on jump, on
project change and on thread change. Following the live edge still never fights a
reader who scrolled up.

### Resizable composer everywhere

The R05 grip was rendered only in the immersive layout. R10 renders it in the
ordinary Studio too, with the same `role="separator"`, pointer drag, Arrow keys,
Home/End and `aria-valuemin/max/now`. The maximum is still measured from the live
stage (42 %) and re-clamped by the ResizeObserver, so a shrink cannot leave a
height the stage cannot afford. The R05 test that asserted "only in the immersive
layout" was rewritten to assert the new, deliberate behaviour.

### Favorites and insertion without data loss

`insertPromptText(current, insertion)` is now a tested module
(`src/renderer/shell/composer-text.ts`):

- an empty draft takes the insertion;
- a whitespace-only draft is replaced, and the notice says so;
- otherwise the insertion is **appended**, and every byte of existing text —
  including trailing whitespace, which the previous version `trimEnd()`-ed — is
  preserved. A draft that already ends its own line is not given a blank one.

### File context: a verified read, not an attachment

The disabled "Attach file" button now says what is true. In its place:

- **Mention file…** asks for a workspace-relative path, calls
  `studio:file-preview` → `WorkStudio.previewFile` → the adapter's
  `GET /v1/workspace/files/read` (the engine's contained route, the same one the
  Changes screen uses);
- main refuses absolute paths and any segment `..` **before** the engine is
  asked, and the engine additionally refuses symlinks and escapes;
- the dialog shows availability, byte size, and `~N tokens` explicitly labelled
  as an estimate at 4 characters per token, plus whether the read was truncated
  by Mona's 32 KB limit;
- **Insert as text** appends a fenced block whose fence is longer than any run of
  backticks in the file (so a file containing ```` ``` ```` cannot close the block
  early), with the extension as its info string — plain text in the composer,
  submitted only when the user presses Send. It goes through the same tested
  `insertPromptText` rule as a favorite;
- a binary file reports `binary` with no content and no token estimate. Nothing is
  invented, and the button that would imply an upload stays disabled with the
  reason.

### Tool and change cards reach the scoped Changes view

Tool and failed cards get **Open Changes**, which navigates to the project's
Changes screen. Model output paths are rendered as text; the card never turns a
path from model output into a file open, and a test asserts no
`a[href^="file"]` is produced from a command containing an absolute path.

## Evidence

- `test/r10-conveniences.test.ts` — 10 tests: byte-preserving insertion (3),
  search (3: anchors and snippets, `%`/`_` inert, bounded and thread-scoped), file
  mention (4: refused before start with the reason, absolute/`..` refused without
  a request, text file with size and labelled estimate, binary stays unavailable).
- `test/shell-races.test.tsx` — the real Shell: a search in project A produces a
  hit, and opening project B leaves an empty query, no A snippets and the
  "Matches this project's stored text" scope line.
- `test/studio-screen.test.tsx` — 6 R10 tests: exact copy of a card body, code
  copy returning block source, search results/jump/scope text, anchor requests an
  older page when the card is absent, mention offered while binary attachment
  stays disabled, Open Changes without following model paths, unread count while
  scrolled back.
- `npm run smoke:aurora` (R06) exercises the new toolbar and card actions in the
  real shell and asserts no horizontal overflow at 200 % zoom.

## Review pass

The independent review returned **FAIL** on the first version. Its R10 findings:

1. **Search state and the jump anchor survived a project switch**, so one
   project's stored text could be shown and another project's history paged in
   search of an anchor that could never exist there. Fixed with a project-scoped
   reset and a real-shell test.
2. **The anchor was never cleared**, so every later history change re-scrolled
   the reader. Fixed with a once-per-anchor application.
3. **`insertMention` bypassed the tested helper and could break its own fence.**
   Fixed: it uses `insertPromptText`, and the fence is computed from the file.

## Honest gaps

- Search matches `payload_json` text with `LIKE`. It is not ranked, not
  tokenised, and it will match a tool's JSON keys as well as its prose. It is
  bounded and honest about what it read; a ranked index is not claimed.
- Search reads only what is stored; events pruned by retention are not found.
- Copy uses the system clipboard through main, so it works in the packaged app
  and in the smoke's Electron host; a headless host without a clipboard returns
  `written: false` rather than a false success.
- File mention is not a file picker: it takes a typed workspace-relative path.
  A tree browser would need a directory-listing route the pinned engine does not
  expose to Mona, and inventing one is out of scope.
- The mention block is not a provider attachment. Its token cost is an estimate
  shown before insertion; the actual billed usage is whatever the engine reports
  for the turn.
