# R07 — Answering agents inside Mona

**Task:** R07 · **Requirements:** MONA-002, MONA-019 · **Findings:** RV-10,
UX-AGENT-COMMS · **Platform:** darwin-arm64 · **Engine:** pinned Codewhale 0.10.2
(`ff466b2ed0bf`), **0 model requests** in every run recorded here.

## The defect being fixed

At R05 an engine ask was a sentence in memory:

```ts
pendingInput: string | null;   // StudioSession
```

It carried no id, no thread, no turn, no options and no status; it was set by a
`kind`-only classifier (`pendingInputFor`) that never read the payload. The text
told the user to *"Switch to Work with your saved Full Access profile, or answer
in Codewhale"* — advice to widen the permission posture or leave the app. A
restart forgot the request entirely, because the stream resumes from the stored
cursor and a prompt already at or below it is never re-delivered.

## What exists now

### The engine's own contract, qualified against the running engine

`docs/evidence/macos/artifacts/upstream-RUNTIME_API.md` documents both reply
routes; `scripts/pending-smoke.mjs` confirms them against the installed binary,
with no inference:

- `GET /v1/threads/{id}` returns `pending_approvals[]` and `pending_user_inputs[]`
  **beside** `thread` and `turns` at the envelope's top level. Measured keys on
  0.10.2: `thread, turns, items, latest_seq, pending_approvals,
  pending_user_inputs, pending_dynamic_tool_calls, approval_grants`. (The first
  implementation looked inside `thread` and read nothing; the smoke is what
  caught it.)
- `POST /v1/approvals/{approval_id}` with `{decision, remember}` answers one
  approval. A capability that is not pending returns `404`
  (`no pending approval with id '…'`).
- `POST /v1/user-input/{thread_id}/{request_id}` with
  `{answers:[{id,label,value}]}` answers a structured question. The engine
  excludes submitted values from durable items on its own side.

### Durable rows, not sentences

Schema **v12** adds `pending_requests`:

```
id, project_id, thread_id, engine_thread_id, turn_id, kind, request_key,
tool_name, title, summary, detail_json, status, decision, decided_by,
acknowledgement, note, created_at, updated_at, settled_at
UNIQUE (engine_thread_id, kind, request_key)
```

`request_key` is the Runtime-minted capability (`approval_<32 hex>`) or the
question's request id. The unique index is the engine's own rule: a capability is
unique per prompt and single-use. Status is an explicit ladder —
`pending → sending → answered | expired | cancelled | unknown` — and `decision`
is written **only** when the Runtime acknowledged, so a 404 never records that
the user denied anything.

### Ingest, settle, hydrate

- `ingest` parses each frame with `pendingSignalFor` (request) or
  `pendingSettlementFor` (settlement). A settlement records the *engine's* reason:
  `approval.timeout` is `expired` with no decision, `cancelled: true` is
  `cancelled` with no decision — the payload's `deny` is not attributed to the
  user.
- `hydratePending` reads the engine's own list on **start** (cold, reattached and
  still-live), after a terminal turn, and on the live early-return path. A cold
  start has no in-memory bindings, so it hydrates the conversations the store
  already holds (`hydrateStoredThreads`, bounded to four) — without that, a
  request recorded before a restart stayed invisible until the user submitted
  something.
- Requests the engine lists are recorded/refreshed; rows it no longer lists are
  marked `expired` **with the reason stated**. Reconciliation is **per kind**:
  an engine that reported `pending_approvals` and said nothing about
  `pending_user_inputs` has not said "no questions", so only the reported list
  may expire rows. When neither list is present, `available` is false and
  nothing is expired.
- Duplicate delivery updates the captured detail of a still-pending row instead
  of creating a second prompt; a settled row is never reopened.
- A row left in **`sending`** by a process that died mid-answer is reopened —
  with the note *"a previous answer was interrupted before it was acknowledged"*
  — because the engine still lists it, which is first-hand evidence nothing was
  delivered. The reopen is refused while this process holds the claim
  (`session.answering`), so a reconcile running during a genuine send cannot
  turn an in-flight delivery into a second prompt.

### Answering

`studio.answerPending(projectId, rowId, response)`:

1. loads the row and refuses when it belongs to another project (`NOT_FOUND`) or
   another conversation (`sessionKnowsThread`, which checks bindings — an ask may
   outlive its turn);
2. validates a question answer against the engine's own rules **before** spending
   the capability: known question ids, option labels the engine offered (or free
   text), exactly one answer for a single-select question, every question
   answered, no answerable question with a missing identity;
3. **claims** the row with a compare-and-set (`pending|unknown → sending`), so a
   double click, a duplicate IPC delivery or a second renderer cannot send a
   second decision;
4. POSTs through the adapter, which echoes the capability verbatim (path-encoded)
   and maps `404` to an outcome, not an exception;
5. records the outcome: `answered` (2xx, `decided_by: user`, acknowledgement text
   stored), `expired` (404, no decision recorded), `refused` (other non-2xx, row
   returns to `pending` with the Runtime's note), or `unknown` (transport
   failure — the row keeps the decision and says the reply may not have reached
   the engine; the card is not offered again until the engine's list is read).

An `unknown` row stays on screen: it is still an ask the engine may be waiting
on, so the card reports the unconfirmed delivery and offers **Read the engine's
list again** (which runs the same hydrate) instead of vanishing into a notice.

A question's free-text field is offered only when the engine offered no options,
because the engine validates a label against those options — showing the field on
an option question would let the user type an answer Mona cannot submit.

"Reply sent" is therefore never a claim about a click. It is the Runtime's own
2xx. IPC is a strict zod object (`studio:answer-pending`) that names Mona's row
id; the capability itself never crosses to the renderer — asserted in both the
unit suite (`capability_kept_in_main`) and the smoke.

### The screen

`PendingRequestCard` sits above the console, not inside the scrollback. It shows
the tool and the arguments the engine captured (behind a disclosure), the
permission posture the turn ran under, the turn id, and either `Allow once` /
`Deny` with an explicit "remember this class for the session" checkbox (a grant
never changes the posture, and the copy says so) or the questions with their
options, descriptions and an "Other" field. Settled rows are not rendered as a
call for attention. In the immersive layout the stack is bounded so it cannot
push the composer out of the window (found by looking at an R06 capture).

The old advice is gone: nothing in the UI suggests switching to Full Access or
answering elsewhere. The chosen mode is untouched by answering.

## Evidence

- `artifacts/r07-pending-smoke.json` — real engine, isolated HOME/workspace,
  **12/12 assertions true, 0 model requests**: thread detail really carries the
  pending lists; the adapter reads them; both reply routes exist and reject an
  unknown capability; a stored row is expired only because the engine no longer
  lists it, with the reason; the row survives a fresh `WorkStudio` over the same
  store and is rendered by it; the expired row cannot be answered; the capability
  does not appear in the renderer view. (The real engine cannot be asked to list
  a synthetic capability, so the *reopen-while-still-listed* path is proven by
  the unit tests, which control the engine's answer — the smoke proves only that
  a row outlives the process that recorded it.)
- `test/studio-pending.test.ts` — 24 tests: parser units (capability vs
  tool-call id, path-shaped capability refused, question options, timeout vs
  person's denial), durable row + snapshot view, 2xx acknowledgement with the
  exact request body, 404 → expired with no decision, concurrent double answer
  sends exactly one request, structured answer accepted / wrong option refused
  before the claim, single-select answered twice refused, duplicate capability
  stored once, two live capabilities kept apart, settlement from the engine's own
  event, restart beside an unsent draft, expiry from the engine's list,
  "no list at all" leaves rows alone, transport failure → `unknown` and a retry
  refused, a cross-project row refused, a dead process's `sending` row reopened
  while a live one is not, one kind expired while the other is only silent, and
  an `unknown` row reopened only because the engine still lists it.
- `test/studio-screen.test.tsx` — the card renders the ask, sends
  `{kind:"approval", decision:"allow", remember:false}`, keeps Send disabled until
  every question is answered, and no longer contains the old "cannot answer"
  guidance.

## Remaining engine limitations, stated

- **A live approval prompt has not been round-tripped.** Manufacturing one
  requires a turn, a tool call and therefore inference. The contract, the
  capability's single-use behaviour, the 404 path and the row lifecycle are all
  verified; the 2xx path is verified against a fixture transport and against the
  route's existence on the real engine. This is recorded rather than papered
  over.
- **Remembered grants** are passed through (`remember`) but Mona does not display
  the grant list; `GET` grant management is not wired.
- **Clarifications from a compatibility (tool-free) transport** cannot be
  answered at all — the engine refuses interactive execution there. Mona's own
  path is the full `/v1/*` API, so this only affects a turn started by another
  client.
- The pending card is not a notification: if the user is on another screen, the
  work-board `Needs-you` indicator is the cross-screen signal (R08/R09).
- **The `user_input.required` payload shape has never been observed from the
  pinned engine.** The smoke's `pending_user_inputs` was empty (a fresh thread
  has nothing pending), and upstream documentation names `request_id` and
  `questions[].{id,header,question,options[{label,description}],multi_select}`
  without a captured sample. Mona's parser accepts both `payload.questions` and
  `payload.request.questions`, requires answerable ids, and renders whatever
  labels it is given; if the real shape differed, the card would be absent rather
  than wrong. This is a disclosed gap, not a verified claim, and it is the first
  thing to check with a live Ask-mode turn.
