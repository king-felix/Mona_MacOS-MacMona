# native/macos-services

Native Finder integration (selected-folder Service, file URLs). Implemented at
P09; P02 reserves the location and records the feasibility result.

P01 verified the mechanism with Command Line Tools only: a Swift/AppKit helper
compiled against SDK 14.4, read Finder file URLs from `NSPasteboard`, carried an
`NSServices` Info.plist, passed `plutil -lint`, was ad-hoc signed and verified,
and LaunchServices registered the service (`service id: Open in Mona`). The
verification bundle was disposable; nothing from it ships.

Constraints for the real helper:

- Native arm64 only, explicit deployment target, no Rosetta.
- The Service receives file URLs; it must not read file contents before the
  user chooses a folder in Mona.
- Full app-bundle registration and Finder menu behavior are validated in the
  packaged app (P21), not by a standalone probe.
