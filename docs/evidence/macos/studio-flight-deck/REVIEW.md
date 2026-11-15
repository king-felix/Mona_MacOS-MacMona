# Studio flight deck — implementation evidence

Baseline: `344d41c3f154d6461bb82d873d6d3541faaa09b9` (2026-11-15 remote main).
Working branch: `codex/studio-flight-deck`. Execution host: Linux, Node 24.22.1.
**Claim: implemented and portable checks passed; native visual/install checks
pending. No new installed Mac build or GitHub publication is claimed.**

## Findings and changes

1. Focus explicitly used `min-height: 100vh`, visible page overflow, and a
   transcript that could grow. Replaced this with a definite viewport-height
   chain, `min-height: 0` through flex ancestors, and an internally scrolling
   transcript. The composer has a bounded textarea and observed resize limits.
2. Repeated project/status/activity/usage bands occupied the work surface.
   Introduced one compact dashboard, one activity signal, and Telemetry detail.
3. The inspector added little value to this workflow. Removed it from Studio.
   Existing durable tasks, evidence, and other screens remain.
4. Bottom controls were remote from the prompt and could leave the viewport.
   Submit, Pause/Resume, Interrupt, and secondary controls now sit above it.
5. Old activity derived `running` from the presence of a turn ID. New phases
   require matching current thread/turn events; stale, offline, and human-waiting
   cases override reassuring animation. A local clock detects silence even if
   the next snapshot never arrives. No added engine or provider request.
6. Success notices were persistent; tone and text could also drift independently.
   Added five-second dismissal, hover/focus/visibility pause, and unified receipts.
   Required input/errors remain actionable. No layout displacement from toasts.
7. Zoom now collapses optional facts/navigation and bounds the prompt/console.
   Exact values stay in Telemetry, and command navigation stays accessible.

## Verification performed

- `npm ci --ignore-scripts --no-audit --no-fund`: lockfile dependencies installed.
  Native macOS postinstall work intentionally not represented as performed here.
- `npm run typecheck`: pass (main and renderer).
- `npm run lint`: pass, zero errors; three existing `no-explicit-any` warnings in
  engine-adapter, engine-orchestration, and work-agents tests.
- `npm run build`: pass. Existing large-bundle advisory remains; not a failure.
- Portable suite: **1,123 passed, 11 skipped, 103 files passed**. Four files with
  reproduced untouched-baseline failures were explicitly excluded; not waived
  for the Mac. New tests cover event truth, stale-clock updates without incoming
  snapshots, hidden-window timer cleanup, notice timeout/replacement/focus, moved
  controls, and existing draft/command/fullscreen behavior.
- Subsequent integration checks after the dashboard navigation refinement:
  **71 passed in four files**, including shell races and accessibility components.
- Additional checks on the actual live Studio component (not the old design
  harness): normal and Focus axe checks with Telemetry closed/open pass. The
  initial audit caught a visible/accessibility label mismatch on Exit Focus;
  fixed it and reran **29 tests in four files**, all pass. Color contrast and
  spoken VoiceOver still require rendered/native checks.
- The portable browser fixture also passes a separate strict TypeScript check.
- Baseline `monabuild validate`: pass. Current validator: **16 stale source
  evidence hashes**, plus an attempt-index warning. These are deliberately not
  refreshed without their native checks. Native qualification remains pending.
- Untouched baseline comparison: **8 failed, 37 passed, 1 skipped in four files**:
  runtime-process (3), usage-hud (3, SQLite binding), folder-request (1, Unicode
  filesystem resolution), app-icon (1, native image tooling). The same failures
  occurred before the Studio edits. They require a fresh Mac run, not assertion
  removal. Logs are stored beside this report.
- Formatting, final type/build checks, diff hygiene and secret scan are recorded
  in the handoff state. No native success is inferred from these checks.

## Native visual gate — Needs the Human / Mac execution surface

Three approaches did not yield visual evidence on this execution host:

1. Standalone Chromium could not create its process-singleton socket (`Operation
   not permitted`). The UI never launched.
2. The official Playwright headless-shell download returned malformed/empty ZIP
   data, including the installer's internal retries; no runnable browser resulted.
3. The supported cloud browser could not reach the local dev-server loopback.
   Its documented shared-file route was then rejected by URL policy because
   `file:` is not allowed. That policy explicitly prohibited alternate routes;
   browser work stopped. No security workaround was attempted.

This is an execution-environment limitation, not evidence that Mona renders
correctly or incorrectly. No screenshots or geometry pass claims were fabricated.
The next appropriate check is F02 on the owner's Mac. The portable smoke runner
is supplied but **has not passed on this host**. It tests six viewport cases,
1,200 events, an 8,000-line item, maximum composer resize, reduced motion, stale
status, notice expiry, Enter, and Command-Enter.

## Historical ledger

The prior P/R records describe the prior verified builds. Source changes make
some recorded source hashes stale. Keep those records historical; do not rewrite
them as though native CI or installation happened here. Use the separate
`flight-deck.json` queue and the new prompt file to qualify the changed source.
Owner decisions D-103 (local distribution) and D-111 (reasoning engine gap) remain
unchanged. A reasoning activity label is not a newly supported effort control.
