import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

/**
 * A deterministic digest of a workspace as it exists on disk. Verification
 * records this digest; reconciliation recomputes it. A different digest means
 * the code (or a linked evidence file) moved under the verification, so the
 * task returns to `verifying` instead of claiming a stale result.
 *
 * This is deliberately a local, bounded observation, not a semantic diff. It
 * includes file paths and contents up to a cap, and reports `truncated` when a
 * workspace is too large to prove completely.
 */

const SKIP_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".mona",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  "target",
  "DerivedData",
]);

const MAX_FILES = 20_000;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_CONTENT_BYTES = 1024 * 1024;

export interface EvidenceFingerprint {
  path: string;
  resolvedPath: string;
  present: boolean;
  digest: string | null;
  note: string | null;
}

export interface WorkspaceFingerprint {
  digest: string;
  files: number;
  bytes: number;
  truncated: boolean;
  skipReason: string | null;
  evidence: EvidenceFingerprint[];
}

function digestBytes(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function walk(root: string): { lines: string[]; files: number; bytes: number; truncated: boolean } {
  const lines: string[] = [];
  let files = 0;
  let bytes = 0;
  let truncated = false;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const directory = stack.pop() as string;
    let entries: string[];
    try {
      entries = readdirSync(directory).sort();
    } catch {
      lines.push(`unreadable-directory:${relative(root, directory)}`);
      continue;
    }
    for (const name of entries) {
      const path = join(directory, name);
      const rel = relative(root, path) || name;
      let stat;
      try {
        stat = lstatSync(path);
      } catch {
        lines.push(`unreadable-file:${rel}`);
        continue;
      }
      if (stat.isDirectory()) {
        if (SKIP_DIRECTORIES.has(name)) {
          lines.push(`skipped-directory:${rel}`);
          continue;
        }
        stack.push(path);
        continue;
      }
      if (stat.isSymbolicLink()) {
        try {
          lines.push(`link:${rel}:${realpathSync(path)}`);
        } catch {
          lines.push(`unresolved-link:${rel}`);
        }
        continue;
      }
      files += 1;
      if (files > MAX_FILES) {
        truncated = true;
        break;
      }
      if (stat.size <= MAX_CONTENT_BYTES) {
        try {
          const content = readFileSync(path);
          bytes += content.byteLength;
          if (bytes > MAX_TOTAL_BYTES) {
            truncated = true;
            lines.push(`oversize-budget:${rel}`);
            break;
          }
          lines.push(`file:${rel}:${stat.size}:${digestBytes(content)}`);
        } catch {
          lines.push(`unreadable-file:${rel}:${stat.size}`);
        }
      } else {
        truncated = true;
        lines.push(`large-file:${rel}:${stat.size}:${Math.floor(stat.mtimeMs)}`);
      }
    }
    if (files > MAX_FILES || bytes > MAX_TOTAL_BYTES) break;
  }
  return { lines, files, bytes, truncated };
}

function evidenceEntries(root: string, evidencePaths: readonly string[]): EvidenceFingerprint[] {
  return [...new Set(evidencePaths.map((path) => path.trim()).filter(Boolean))]
    .sort()
    .map((path) => {
      const resolvedPath = isAbsolute(path) ? path : resolve(root, path);
      try {
        const stat = lstatSync(resolvedPath);
        if (!stat.isFile()) {
          return {
            path,
            resolvedPath,
            present: false,
            digest: null,
            note: "not a regular file",
          };
        }
        const content = readFileSync(resolvedPath);
        return {
          path,
          resolvedPath,
          present: true,
          digest: digestBytes(content),
          note: null,
        };
      } catch {
        return { path, resolvedPath, present: false, digest: null, note: "missing" };
      }
    });
}

export function workspaceFingerprint(
  rootPath: string,
  evidencePaths: readonly string[] = [],
): WorkspaceFingerprint {
  let root: string;
  try {
    root = realpathSync(rootPath);
  } catch {
    return {
      digest: createHash("sha256").update(`missing-root:${rootPath}`).digest("hex"),
      files: 0,
      bytes: 0,
      truncated: true,
      skipReason: "workspace is not readable",
      evidence: evidenceEntries(rootPath, evidencePaths),
    };
  }
  const walked = walk(root);
  const baseDigest = createHash("sha256")
    .update(["mona-workspace-fingerprint-v1", ...walked.lines].join("\n"))
    .digest("hex");
  return composeVerificationFingerprint(
    root,
    {
      digest: baseDigest,
      files: walked.files,
      bytes: walked.bytes,
      truncated: walked.truncated,
      skipReason: walked.truncated ? "workspace exceeds the bounded fingerprint window" : null,
      evidence: [],
    },
    evidencePaths,
  );
}

/**
 * Combine an already-walked workspace digest with one task's evidence files.
 * The board walks the workspace once and folds each task's own evidence paths
 * in separately, so one task's evidence cannot invalidate another task.
 */
export function composeVerificationFingerprint(
  rootPath: string,
  base: WorkspaceFingerprint,
  evidencePaths: readonly string[],
): WorkspaceFingerprint {
  const evidence = evidenceEntries(rootPath, evidencePaths);
  const lines = [
    "mona-verification-fingerprint-v1",
    base.digest,
    ...evidence.map((entry) =>
      entry.present ? `evidence:${entry.path}:${entry.digest}` : `evidence:${entry.path}:missing`,
    ),
  ];
  return {
    ...base,
    digest: createHash("sha256").update(lines.join("\n")).digest("hex"),
    evidence,
  };
}
