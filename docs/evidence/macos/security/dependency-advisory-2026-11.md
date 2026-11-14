# Dependency advisory GHSA-g3hv-75wg-m249 (and GHSA-3g3m-2fjr-6pw4) — closed

**Date:** 2026-11-14 · **Trigger:** the Dependabot alert GitHub reported on the
default branch after the R05 push · **Scope:** development toolchain only ·
**Product runtime:** untouched

## What was reported

GitHub had two npm alerts on `main`, both created `2026-11-14T04:16:03Z`, both
`moderate`, both on **transitive development** dependencies:

- **Alert 2 (open)** — `minimatch` 10.2.6, GHSA-g3hv-75wg-m249 / CVE-2026-118764,
  "potential denial of service via globparts amplification". Vulnerable range
  `>= 7.0.0, < 11.0.1`. A `**/../` transformation inside the `didSomething`
  fixpoint loop clones globparts entries, and the second phase is quadratic over
  the result. Attacker-controlled *pattern* required for amplification.
- **Alert 1 (auto-dismissed by Dependabot, still installed)** — `glob` 13.0.7,
  GHSA-3g3m-2fjr-6pw4 / CVE-2026-118773, "AbortSignal cancellation bypass allows
  post-timeout filesystem traversal". Vulnerable `>= 9.0.0, <= 14.0.1`. Abort
  branches call `cb()` without `return`, so an aborted walk keeps reading
  directories.

`npm audit --package-lock-only` against the committed lockfile reproduced both
as **11 moderate findings** across `minimatch`, `glob`, `@electron/asar`,
`@eslint/config-array`, `eslint`, `typescript-eslint` and its `parser`,
`eslint-plugin`, `type-utils`, `utils`, `typescript-estree` entries — one
advisory each, propagated through the tree.

**Exposure assessed before changing anything.** Neither advisory is reachable in
the product: `npm ls --omit=dev --all` is `react`, `react-dom`, `scheduler`,
`zod`, and `npm audit --omit=dev` reported 0 vulnerabilities. The patterns
`minimatch` compiles here come from `eslint.config.mjs` (developer-authored),
`tsconfig` project matching, and `@electron/packager`'s own ignore list — none
is supplied by a model, a project file, or a network peer. This was fixed
because it is cheap, upstream-sanctioned, and would otherwise accumulate, not
because a live exploit path existed.

## What changed

No override forced on a package that had not moved. Three of the four holders
of a vulnerable range had already published a fix; only one needed pinning:

| Package | Was | Now | Why |
|---|---|---|---|
| `eslint` (direct dev dep) | 10.14.0 | **10.15.0** | upstream moved its own range to `minimatch: ^11.0.5` |
| `@electron/asar` (via `@electron/packager`) | 4.3.1 | **4.3.2** | upstream moved to `glob: ^14.0.2` and `minimatch: ^11.0.1` |
| `glob` | 13.0.7 | **14.0.6** | 14.0.2 is the first patched release; 14.0.6 also carries GHSA-qxr8-q827-836c |
| `minimatch` | 10.2.6 | **11.0.8** | 11.0.1 is the first patched release; 11.0.7 fixed a quadratic-compile regression introduced in 11.0.0, 11.0.8 is latest |
| `@eslint/config-array` | 0.23.5 | 0.23.6 | came with eslint |
| `path-scurry` | 2.0.2 | 3.0.0 | came with glob 14 |
| `@isaacs/nonrecursive-glob-match` | — | 1.1.0 | came with glob 14 |

`npm audit fix` (non-breaking) carried the `@electron/asar` → `glob` → `minimatch`
subtree and `@eslint/config-array`. `eslint` was bumped in `package.json` by
hand. **One override was required:** `@typescript-eslint/typescript-estree@8.72.2`
is the latest release and still declares `minimatch: ^10.2.2`, so

```json
"overrides": {
  "@typescript-eslint/typescript-estree": { "minimatch": "^11.0.8" }
}
```

is scoped to that one package rather than forcing a major bump on everything
that ever asks for `minimatch`. The tree now has exactly **one** `minimatch`
(11.0.8) and **one** `glob` (14.0.6).

Result: `npm audit` — **0 vulnerabilities**, and the tree is cleaner than before
by the same measure.

## Why this major bump is safe here

`minimatch` 11 and `glob` 14 are majors, so the call sites were checked rather
than assumed:

- **`minimatch` 11.0.1 is dual-package** (`exports` carries both `import` and
  `require`, `main` is the CommonJS build) and keeps `engines: 18 || 20 || >=22`.
  `typescript-estree` is CommonJS and calls `minimatch(filePath, pattern, { dot: true })`;
  that function and the `Minimatch` class are unchanged. Proven directly on the
  installed copy: `minimatch("src/a/b.ts", "**/*.ts", { dot: true }) === true`,
  `new Minimatch("**/*.tsx").match("src/x.tsx") === true`.
- **`typescript-estree`'s only `minimatch` call site** is
  `filePathMatchedBy` in `useProgramFromProjectService.js`, reached only with
  `parserOptions.projectService`. This repository's `eslint.config.mjs` does not
  enable the project service, so the pin is defensive rather than load-bearing.
- **`glob` 14 is used by `@electron/asar` only**, and the packaging pipeline
  builds with `asar: false` ("no ASAR archive; app code and executables remain
  in the signed payload"). The filter path was still exercised directly, old
  against new, with the same fixture and the same script
  (`artifacts/asar-filter-parity.txt`): `createPackageWithOptions` with
  `globOptions.ignore` produced **identical** archives and identical ignores on
  4.3.1 (glob 13.0.7 / minimatch 10.2.6) and 4.3.2 (glob 14.0.6 / minimatch 11.0.8).
  One caveat recorded honestly: `drop/**` does not prune the directory entry
  itself in *either* version — that is glob's ignore semantics, not a
  regression, and the earlier `createPackage(src, dest, opts)` form in my first
  probe silently ignored its third argument because the options belong to
  `createPackageWithOptions`.
- **`eslint` 10.15.0** keeps `engines: ^20.19 || ^22.13 || >=24` and the repo's
  `engines: node >= 22` contract; the host runs Node 26.13.0.

## Verification on the final bytes

- `npm audit` → **0 vulnerabilities**; `npm audit --omit=dev` → 0.
- `npm ls minimatch glob` → one version of each (11.0.8 / 14.0.6).
- `npx eslint . --format json` → **297 files linted, 0 errors, 3 pre-existing
  `no-explicit-any` warnings** — the file-matching path really ran, it did not
  silently match nothing.
- `npm run ci` → **green, 18/18 steps** (`format:check`, `lint`, `typecheck`,
  `catalog:check`, three native builds, `test` **983 tests in 90 files**,
  `build`, twelve smokes including `smoke:lifecycle`, renderer scan
  `3 files / 0 patterns`). `artifacts/ci.txt`.
- `npm run mac:doctor` → all eight checks true, disk check true; no Developer ID
  identities, which is expected and is P22's blocker, not this one.
- `npm run mac:package:local` → **every gate through package construction
  passed** (main and renderer bundles, three native components, engine identity
  `0.10.2 ff466b2ed0bf`, app bundle assembled by `@electron/packager` under the
  new `asar`/`glob`/`minimatch`, 17 Mach-O files signed ad-hoc, component package
  built, installer built, declared metadata verified for
  `com.mona.workbench.pkg` 0.1.0 build 129, arm64 only, macOS 14.0+). It then
  stopped at the known admin-gated `installed_copy` check, unchanged from the
  EXT-INSTALL blocker recorded at P23. `artifacts/package-local.txt`.

## What this does not claim

- It does not unblock `mac:package:local`; that still needs an administrator to
  install the current `.pkg`. The dependency change did not move that gate
  either way.
- It does not qualify a signed or shareable release. `--mode release` still
  fails closed without Developer ID identities, which is P22/R14.
- It does not claim the advisories were exploitable here. They were not
  reachable; they are now absent.
- `eslint` 10.15.0 is a minor release inside the pinned major; its own release
  notes were not audited line by line. The repo's `ci` run is the evidence that
  it behaves identically for this codebase, and the three warnings are the same
  three files as before.

## Ledger effect

`package.json` and `package-lock.json` changed, so the product-ledger evidence
that names them was re-recorded through `monabuild evidence` (P02 both files;
P03, P04, P09, P18 `package.json`), each with a note saying the previous hash
described the bytes at that prompt's verification. No requirement status was
lowered and no assertion was removed. `monabuild validate` is green afterwards;
the review ledger records this as RD-012 and flags it to R12, which owns the
final dependency and reconciliation sweep.

## Closed, as GitHub now reports it

Both alerts were closed by Dependabot's own re-scan of the pushed lockfile —
`state: fixed`, not `dismissed`:

```
alert 1  glob       13.0.7   state=fixed  fixed_at=2026-11-14T08:25:42Z
alert 2  minimatch  10.2.6   state=fixed  fixed_at=2026-11-14T08:25:43Z
```

The push that carried the fix printed "1 vulnerability" in its remote banner;
that banner is generated before the scan runs, so the alert API is the
authority. Raw payload: `artifacts/dependabot-alerts-after.json`.
