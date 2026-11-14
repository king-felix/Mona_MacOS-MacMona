# Security policy

Mona is a local macOS desktop application. It runs on the machine that builds
it, talks to a Codewhale engine on loopback, and is not a service. This file
states the trust boundaries the code actually enforces, how to report a problem
privately, and what is out of scope by design.

## Trust boundaries

### The renderer is sandboxed and has no network

The window is created with `sandbox: true`, `contextIsolation: true`,
`nodeIntegration: false`, `webSecurity: true` and
`allowRunningInsecureContent: false` (`src/main/window.ts`). The document is
served under a strict content policy (`src/main/security.ts`): `default-src
'self'`, `connect-src 'none'`, `object-src 'none'`, `base-uri 'none'`,
`frame-ancestors 'none'`. Permission requests and permission checks are denied,
and `window.open` is refused. Navigation is allowed only to a `file:` URL
inside the built renderer root (`src/main/navigation.ts`).

Consequence: a compromised or malicious string rendered in the UI cannot make a
network request, open a window, or load remote code. `test/boundary.test.ts`
fails if renderer sources reference `process.env`, Node modules, `ipcRenderer`
or the upstream wire types.

### The renderer cannot reach past the bridge

`src/preload/index.ts` exposes one object through `contextBridge`; there is no
raw `ipcRenderer`, no dynamic channel name, and no generic "invoke anything"
call. Every channel has a `zod.strictObject` schema in
`src/main/ipc-contract.ts`, so unknown channels and unknown fields are rejected
before a handler runs.

The sender is checked before any handler: `senderIsTrusted`
(`src/main/ipc-sender.ts`) accepts only the top-level local renderer document —
not a subframe, a navigated frame, a remote page, a destroyed sender, or a frame
whose URL cannot be read. A failure to read the frame is treated as untrusted,
not as permission.

### Policy is set in the main process

The renderer cannot alter the content policy, the sender policy, the navigation
policy, or the credential store directly. What it can request is an enumerated
set of actions with validated payloads, executed in main. There is no general
filesystem API, no shell command channel, and no way for the renderer to name an
executable. The integrated terminal is a bounded capability: its schema carries
`projectId`, `cols` and `rows` only, and the shell and working directory are
chosen in main.

Some of those actions change configuration — switching the engine route, for
example — and they do so through the engine's own config writer with a
revision check and a backup, not by editing files from the renderer.

### Credentials are engine-owned

Mona does not keep provider keys.

- A key typed into Settings is checked against the engine's provider catalog,
  passed to the engine's credential route, and never stored by Mona. The receipt
  reports the engine's own credential state and backend; the value is not echoed
  back.
- A session-scoped key lives in engine memory for that run only.
- `setProviderCredential` refuses a provider the engine does not report, a
  provider id that is not a bounded identifier, and a route whose credential the
  engine does not own (`CREDENTIAL_REFUSED`). Mona will not write around the
  engine's credential store.
- The cached route projection stores only the endpoint authority — scheme and
  host. Userinfo, path, query and fragment never reach the UI or the cache
  (`endpointAuthority` in `src/main/work/settings.ts`).
- `clearProviderCredential` clears through the engine and says which owner it
  affected. It does not touch credential owners it did not create.

### Secrets are redacted before they leave the process

`redactDiagnostics` and `redactHomePath` (`src/main/work/settings.ts`) strip the
home directory and secret-shaped values from diagnostics, engine doctor output
and error messages: private key blocks, `sk-` provider keys, bearer tokens,
`key=value` assignments, URL secrets, URL userinfo and environment assignments.
The terminal redacts its log before writing it (`src/main/terminal/session.ts`).

Redaction is boundary-aware: `/Users/victor2` is not rewritten when the home is
`/Users/victor`. That distinction is a test, not a comment
(`test/p20-failure-matrix.test.ts`).

### Paths and URLs are validated, not assumed

- **Folder intake.** One validator (`src/main/open/folder-request.ts`) handles
  every way a folder arrives. It accepts only local `file:` URLs and absolute
  POSIX paths, refuses a remote host (`REMOTE_FILE_URL`), embedded NULs,
  relative paths, missing items, non-directories, unreadable items and disk
  roots, and resolves symlinks to the real folder. The path is never
  interpolated into a shell command downstream.
- **Identity.** Projects deduplicate by `(dev, ino)` as well as by canonical
  path, so one directory cannot become two records through an alias.
- **Endpoints.** Only `http:` and `https:` with a hostname are accepted for an
  engine base URL; anything else is reported as malformed.
- **Archives.** Extraction resolves real paths, refuses an entry that escapes
  the root through a symlink, and opens with `O_NOFOLLOW`/`O_EXCL` so a link
  planted between the check and the write cannot redirect it. An archive over
  its byte budget or entry count yields no entries at all.

### Child processes get an allowlist, not the environment

- **Git.** Repository hooks execute with the environment Git is given. Mona's
  `buildGitEnvironment` passes an explicit allowlist (PATH, HOME, USER, LOGNAME,
  TMPDIR, locale, Git identity, `XDG_CONFIG_HOME`) with a secret-name filter and
  `GIT_TERMINAL_PROMPT=0`. `SSH_AUTH_SOCK` is deliberately not passed: this
  service runs local subcommands only and never pushes, fetches or clones.
- **Terminal.** The PTY helper receives exactly the `--env` entries given to it,
  built from an allowlist. Provider keys and the runtime token cannot reach a
  shell. Closing the control channel is treated as owner death, so a desktop
  crash cannot leave a shell behind.
- **Supervisor.** The runtime bearer token is written on fd 3, not into argv or
  the supervisor's environment.

### State is private to the user

The support, state and backup directories are created mode `0700` and the
database is `0600`. The database holds project metadata, projections of engine
events, cost records and settings — never provider keys, never a competing
transcript of the conversation.

## Reporting a vulnerability

There is **no security contact in this repository**. No email address, PGP key,
`security.txt`, or advisory process is recorded anywhere in the tree. This file
will not invent one.

That is a gap the owner must close before publication invites reports. If this
repository becomes a place where people are asked to report problems, add — in
the same change — a monitored contact address or a private GitHub security
advisory route, a stated response expectation, and a statement of which versions
receive fixes.

Until then: do not publish the details of an unfixed vulnerability in a public
issue or discussion. Report it privately through the owner's own channel, with
the version and build from Settings, the steps that reproduce it, and what you
observed.

## Out of scope

The following are outside this repository's security boundary:

- **The Codewhale engine and model providers.** The pinned engine is a separate
  project; report its defects upstream. Provider billing, quotas and model
  behaviour are not Mona's.
- **Electron, Chromium, Node and macOS.** Report these upstream. Mona configures
  the sandbox and content policy; it does not patch the runtime.
- **Development-only dependencies.** Advisories in the lint and packaging
  toolchain are recorded in
  `docs/evidence/macos/security/dependency-advisory-2026-11.md` and are not in
  the shipped payload. The packaged runtime dependencies are `react`,
  `react-dom` and `zod`.
- **A permissive approval posture the user chose.** If a user grants the engine
  shell access, or trusts a repository or plugin, the engine's own permission
  model governs what runs. Mona shows the posture that was recorded; it does not
  second-guess a deliberate grant.
- **Gatekeeper rejecting this build on another Mac.** That is the distribution
  decision, not a defect. See below.
- **Anything requiring physical access, an already-compromised user account, or
  a modified build.** Rebuilding the app and removing a control is not a
  vulnerability in the app that ships.

## Local distribution, stated plainly

Mona has no shareable release, by decision (`.mona/build-macos/DECISIONS.md`,
"There is no shareable release; the deliverable is a local build" — the ledger
carries two entries numbered D-103, so cite it by title).

- The app is **ad-hoc signed**. There is no Developer ID signature and no
  notarization ticket.
- macOS will refuse it on any other Mac; a `spctl` assessment there rejects it.
  On the machine that built it, the local build runs.
- `npm run mac:release` is implemented and **fails closed**. It is not weakened,
  renamed or repurposed to produce something that looks shareable.
- Anyone else who wants Mona builds it from source themselves.

A Gatekeeper rejection on a second Mac is therefore expected behaviour, not a
vulnerability, and should not be reported as one.
