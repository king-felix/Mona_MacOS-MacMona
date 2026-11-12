/**
 * Payload hygiene gate. It is deliberately a set of documented patterns rather
 * than a claim of complete secret detection: packaging fails closed when a
 * credential-shaped value, a build-machine path, or developer state appears in
 * a text file that ships.
 */
export const DEFAULT_SECRET_PATTERNS = [
  { label: "provider-key", pattern: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { label: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/ },
  { label: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { label: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

/** The actual build-machine paths, not synthetic `/Users/example` fixtures. */
export function buildHostPatterns(home, checkout) {
  const literal = (value) => String(value).replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [];
  if (home) {
    patterns.push({
      label: "build-host-home",
      pattern: new RegExp(`${literal(home)}(?![A-Za-z0-9._-])`),
    });
  }
  if (checkout) {
    patterns.push({
      label: "build-checkout",
      pattern: new RegExp(`${literal(checkout)}(?![A-Za-z0-9._-])`),
    });
  }
  patterns.push(
    { label: "command-line-tools-path", pattern: /\/Library\/Developer\/CommandLineTools/ },
    { label: "xcode-path", pattern: /\/Applications\/Xcode[^/\s]*\.app/ },
  );
  return patterns;
}

export const FORBIDDEN_FILE_PATTERNS = [
  { label: "source-map", pattern: /\.map$/i },
  { label: "dotenv", pattern: /(^|\/)\.env(\.|$)/i },
  { label: "private-key-file", pattern: /\.(pem|key|p12|pfx)$/i },
  { label: "database", pattern: /\.(sqlite|sqlite3|db)$/i },
  { label: "git-directory", pattern: /(^|\/)\.git(\/|$)/ },
  { label: "build-ledger-directory", pattern: /(^|\/)\.mona(\/|$)/ },
  { label: "session-or-config-store", pattern: /(^|\/)\.codewhale(\/|$)/ },
  { label: "ssh-material", pattern: /(^|\/)id_(rsa|ed25519|ecdsa)(\.|$)/ },
];

export function isProbablyText(buffer) {
  const sample = buffer.subarray(0, 8192);
  return !sample.includes(0);
}

/**
 * Scan a list of `{ path, text }` entries. Paths are relative to the payload and
 * are reported as-is; callers redact their own host prefixes before reporting.
 */
export function scanText(entries, patterns = DEFAULT_SECRET_PATTERNS, allow = []) {
  const hits = [];
  for (const entry of entries) {
    for (const rule of patterns) {
      if (
        allow.some(
          (exemption) => exemption.path.test(entry.path) && exemption.labels.includes(rule.label),
        )
      ) {
        continue;
      }
      const match = rule.pattern.exec(entry.text);
      if (match) {
        hits.push({
          path: entry.path,
          label: rule.label,
          // Never echo a candidate credential; a short offset is enough to locate it.
          excerpt: `${rule.label} at offset ${match.index}`,
        });
      }
    }
  }
  return hits;
}

export function scanNames(paths) {
  return paths
    .filter((path) =>
      FORBIDDEN_FILE_PATTERNS.some((rule) => rule.pattern.test(path.replaceAll("\\", "/"))),
    )
    .map((path) => ({
      path,
      label: FORBIDDEN_FILE_PATTERNS.find((rule) => rule.pattern.test(path.replaceAll("\\", "/")))
        ?.label,
    }));
}
