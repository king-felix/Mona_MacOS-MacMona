# Hardened Runtime entitlements

| File            | Applied to                                          | Why                                                                                                                                              |
| --------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `main.plist`    | `Mona.app` and its main executable                  | Electron requires JIT, unsigned executable memory, and dyld environment variables. Nothing more is granted.                                      |
| `helper.plist`  | `Electron Helper*.app` inside `Contents/Frameworks` | The same three Electron entitlements plus `com.apple.security.inherit`, which is the documented inheritance entitlement for a child process.     |
| `service.plist` | `Mona.service`                                      | Empty on purpose. The Service launches the app and exits; it runs no JIT, loads no unsigned plugins, and spawns nothing that needs an exception. |

No entitlement is granted to frameworks, dylibs, the native helpers
(`mona-supervisor`, `mona-pty`), or the bundled `codewhale` engine. Under the
Hardened Runtime a signed binary of ours needs none of them, and a blanket
grant is exactly the widening this file exists to avoid.

`packaging/macos/lib/signing.mjs` is the policy that maps a component to one of
these files; `test/release-trust.test.ts` asserts the mapping per component
class so a new binary cannot silently inherit the main app's exceptions.
