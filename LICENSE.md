# License

**Mona is proprietary. No license is granted.**

This repository is not open source, and nothing here — source, documentation,
screenshots, or build output — may be copied, modified, distributed, sublicensed,
or used to create a derivative work without a written grant from the owner. The
`package.json` field says `"license": "UNLICENSED"` for the same reason.

Building Mona locally for your own use, on the machine that builds it, is the
intended and documented use (see `docs/owner-guide-macos.md`).

## Where the code is visible, and why that is not a license

The source is pushed to a **public** GitHub repository,
`github.com/king-felix/Mona_MacOS-MacMona`, at the owner's explicit instruction
(`D-101`, `D-102` in `.mona/build-macos/DECISIONS.md`; `AGENTS.md` rule 7
otherwise reserves public hosting for the owner). `origin` is that remote and
`main` tracks it.

**Visibility is not permission.** Code that can be read is not code that may be
reused: publishing a repository does not grant a license, and none is granted
here. All rights remain reserved. Anyone who wants to modify or redistribute Mona
needs a written grant from the owner, which does not exist today.

A license decision — choosing terms, adding that text here, and replacing the
`UNLICENSED` field in `package.json` — remains open. This file deliberately does
not make that decision on the owner's behalf, and a public repository must not be
read as having already made it.

There is no contribution process and none is solicited; see `CONTRIBUTING.md`.

## Third-party components

Mona is a frontend for the Codewhale engine. The installed application carries the
full text of every third-party license it is obliged to reproduce, in:

```
/Applications/Mona.app/Contents/Resources/notices/
  THIRD-PARTY-NOTICES.txt      (combined summary and texts)
  LICENSE.codewhale.txt        Codewhale 0.10.2 — MIT
  LICENSE.electron.txt         Electron — MIT
  LICENSES.chromium.html       Chromium and its dependencies
  LICENSE.react.txt            React — MIT
  LICENSE.react-dom.txt        React DOM — MIT
  LICENSE.zod.txt              zod — MIT
```

Those files are written at package time from the dependency tree by
`packaging/macos/build.mjs` (`writeNotices`), and their digests are recorded in
the package's component manifest. A local build therefore ships notices that
match the bytes it shipped.

One dependency is a documented exception rather than a bundled payload: **Git**.
Mona does not bundle Git, because doing so would carry a GPL source-offer
obligation the owner declined (D-105). Git features require Command Line Tools or
another Git on the machine and say so when it is absent.
