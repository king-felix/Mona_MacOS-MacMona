# native/macos-services

Mona's Finder integration: a standalone macOS Service that receives a selected
folder, validates it, and hands it to the installed Mona app.

## Layout

- `main.swift` — the Service. One code path for service mode (pasteboard from
  `NSApplication.servicesProvider`) and CLI mode (`--cli`, used by tests and the
  doctor).
- `Info.plist` — the advertised contract: menu title **Start new DS project with
  Mona**, message `startProject`, port `MonaService`, eligibility
  `NSSendFileTypes = public.folder` only.
- `test-support/probe/` — a receiver app that claims Mona's bundle identifier
  and records what it receives. Test fixture; never shipped.
- `test-support/harness/` — performs the registered Service with
  `NSPerformService`, exactly as macOS does. Test fixture; never shipped.
- `build/` — compiled output (gitignored): `Mona.service`, the fixtures, and
  `build.json` (target, digest, signature status, descriptor).

## Build

```sh
npm run build:service                     # Mona.service + build.json
node scripts/build-service-fixtures.mjs   # test fixtures
```

`xcrun --sdk macosx swiftc -O -target arm64-apple-macos14.0`, ad-hoc signed and
verified. No Rosetta, no runtime compilation on a recipient machine.

## Behaviour

1. Read local file URLs from the pasteboard. Zero URLs → refuse `NO_FILE_URL`;
   more than one → explicit choice or a typed refusal.
2. Validate: `file:` URL or absolute path only, no remote host, alias/symlink
   resolved, exists, is a directory, readable, not a disk root, not an
   online-only cloud item.
3. Locate Mona by bundle identifier `com.mona.workbench` and verify its code
   signature. Never follow an arbitrary path from the caller.
4. Forward with one `odoc` Apple Event
   (`NSWorkspace.open(_:withApplicationAt:)`), which reaches a running Mona or
   launches it once.
5. Record the handoff in
   `~/Library/Application Support/Mona/services/last-handoff.json` and append a
   bounded phase trace to `service-trace.json`.

The helper never runs the model, never reads project contents, never reads
repository instructions, never invokes a shell, and never submits work.

## Development install

```sh
npm run smoke:service
```

copies the bundle to `~/Library/Services`, registers it with `lsregister -f`,
runs the native proof, and removes it again (install manifest:
`build/install-manifest.json`). `/Library/Services` installation belongs to the
packaged installer (P21); Developer ID signing belongs to P22.

## Known OS behaviours

- LaunchServices does not resolve app bundles from temporary directories; the
  app-side proof installs a development bundle in `~/Applications`.
- Replacing the Service bundle can leave a stale Services record; re-install and
  `lsregister -f` before relying on it.
- `NSPerformService` does not re-apply menu eligibility, which is why the
  Service validates every selection itself.
