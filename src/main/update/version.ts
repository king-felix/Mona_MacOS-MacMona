/**
 * Deterministic version and OS ordering for the update flow.
 *
 * No ordering is inferred from a date, a file name, or a source's claim. The
 * dotted numeric version and the integer build are parsed and compared here,
 * and the same comparison is what a downgrade or replay decision rests on.
 */

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Numeric pre-release components; empty for a final release. */
  pre: Array<string | number>;
  raw: string;
}

const VERSION = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/;

export function parseVersion(raw: string): ParsedVersion | null {
  const match = VERSION.exec(raw.trim());
  if (!match) return null;
  const pre = (match[4] ?? "")
    .split(/[.-]/)
    .filter((part) => part.length > 0)
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
    pre,
    raw: raw.trim(),
  };
}

/**
 * SemVer-style precedence: numeric fields first, then a pre-release sorts below
 * its final release, then pre-release components compare numerically against
 * numeric ones and lexically against textual ones. `a` sorts before `b` when
 * the result is negative.
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) {
    // An unparseable version is never "greater"; the caller rejects it earlier.
    return 0;
  }
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (left.pre.length === 0 && right.pre.length === 0) return 0;
  if (left.pre.length === 0) return 1;
  if (right.pre.length === 0) return -1;
  const length = Math.max(left.pre.length, right.pre.length);
  for (let index = 0; index < length; index += 1) {
    const l = left.pre[index];
    const r = right.pre[index];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    const lNumeric = typeof l === "number";
    const rNumeric = typeof r === "number";
    if (lNumeric && rNumeric) return l < r ? -1 : 1;
    if (lNumeric) return -1;
    if (rNumeric) return 1;
    return String(l) < String(r) ? -1 : 1;
  }
  return 0;
}

export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}

export function isSameVersion(a: string, b: string): boolean {
  return compareVersions(a, b) === 0;
}

/** macOS versions are dotted numbers of up to three components. */
export function compareOsVersions(a: string, b: string): number {
  return compareVersions(a, b);
}

/** `0.1.0-p02` is the development package version; the installer strips it. */
export function userVisibleVersion(version: string): string {
  return version.replace(/-p\d+$/, "");
}

/**
 * A build counter is authoritative when both sides have one. The receipt's
 * `build` and the package's `CFBundleVersion` are the same counter.
 */
export function buildNumber(value: string | number | null | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}
