# packaging/macos

Installer and release assets. Populated at P21/P22; P02 reserves the location
and records the target contract.

- Pinned Electron arm64 target; native helpers built for the same architecture.
- Self-contained payload: the native Codewhale binary launches without Node on
  the recipient's PATH (verified in P01 with `env -i PATH=/usr/bin:/bin`).
- Ad-hoc signing is possible now; Developer ID signing, notarization, and
  stapling require credentials that are absent (P22 external prerequisite).
