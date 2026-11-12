import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { inflateRawSync } from "node:zlib";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { StateError } from "./errors";

/**
 * A deliberately small ZIP reader/writer for portable bundles.
 *
 * Mona writes a store-only archive with fixed timestamps and sorted entry names,
 * so two exports of the same records are byte-identical and digest-comparable.
 *
 * The reader is fail-closed. It refuses absolute paths, `..` segments,
 * backslashes, NUL bytes, duplicate names, encrypted entries, symlinks and
 * device nodes, zip64, and anything that would exceed the declared byte caps.
 * An unsafe entry is dropped and reported; it is never handed to a caller as if
 * it were a file name, and `extractArchive` re-validates every path against the
 * extraction root before writing a byte.
 */

export interface ArchiveEntryInput {
  path: string;
  data: Buffer;
}

export interface ArchiveEntry {
  path: string;
  data: Buffer;
  digest: string;
  mode: number;
}

export interface ArchiveProblem {
  path: string;
  code:
    | "ABSOLUTE_PATH"
    | "PATH_ESCAPE"
    | "BACKSLASH"
    | "CONTROL_CHARACTER"
    | "DUPLICATE_ENTRY"
    | "SYMLINK"
    | "UNSUPPORTED_METHOD"
    | "ENCRYPTED"
    | "ZIP64_UNSUPPORTED"
    | "ENTRY_TOO_LARGE"
    | "ARCHIVE_TOO_LARGE"
    | "TOO_MANY_ENTRIES"
    | "CHECKSUM_MISMATCH"
    | "TRUNCATED"
    | "MALFORMED";
  message: string;
}

export interface ArchiveReadResult {
  entries: ArchiveEntry[];
  problems: ArchiveProblem[];
  /** True only when every entry passed validation. */
  safe: boolean;
  digest: string;
}

export interface ArchiveReadOptions {
  maxEntries?: number;
  maxEntryBytes?: number;
  maxTotalBytes?: number;
}

const DEFAULTS: Required<ArchiveReadOptions> = {
  maxEntries: 512,
  maxEntryBytes: 32 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
};

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const STORE = 0;
const DEFLATE = 8;
/** 1980-01-01, the earliest MS-DOS timestamp; fixed so exports are stable. */
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function sha256Bytes(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * One canonical relative name: forward slashes, no drive or root prefix, no
 * `.`/`..` segment, no control character, no empty segment, bounded length.
 */
export function assertSafeEntryPath(path: string): void {
  if (!path) {
    throw new StateError("IMPORT_INVALID", "archive entry has no name", { path });
  }
  if (path.length > 512) {
    throw new StateError("IMPORT_INVALID", "archive entry name is too long", { path });
  }
  if (isAbsolute(path) || path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    throw new StateError("IMPORT_INVALID", "archive entry uses an absolute path", { path });
  }
  if (path.includes("\\")) {
    throw new StateError("IMPORT_INVALID", "archive entry uses a backslash separator", { path });
  }
  for (const char of path) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      throw new StateError("IMPORT_INVALID", "archive entry name has a control character", {
        path,
      });
    }
  }
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new StateError("IMPORT_INVALID", "archive entry escapes its root", { path });
    }
  }
}

/**
 * Resolve an archive entry beneath a root, refusing anything that does not stay
 * inside it. This is the only path function extraction may use.
 */
export function safeJoin(root: string, entryPath: string): string {
  assertSafeEntryPath(entryPath);
  const base = resolve(root);
  const target = resolve(base, normalize(entryPath));
  if (target !== base && !target.startsWith(`${base}${sep}`)) {
    throw new StateError("IMPORT_INVALID", "archive entry escapes the extraction root", {
      path: entryPath,
      root: base,
    });
  }
  return target;
}

/** Deterministic store-only archive: sorted names, fixed timestamps. */
export function writeArchive(entries: readonly ArchiveEntryInput[]): Buffer {
  const seen = new Set<string>();
  const ordered = [...entries].sort((left, right) => (left.path < right.path ? -1 : 1));
  for (const entry of ordered) {
    assertSafeEntryPath(entry.path);
    if (seen.has(entry.path)) {
      throw new StateError("IMPORT_INVALID", "archive contains a duplicate entry", {
        path: entry.path,
      });
    }
    seen.add(entry.path);
  }

  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of ordered) {
    const name = Buffer.from(entry.path, "utf8");
    const checksum = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(STORE, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(STORE, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, entry.data);
    centrals.push(central, name);
    offset += local.length + name.length + entry.data.length;
  }

  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_SIGNATURE, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(ordered.length, 8);
  end.writeUInt16LE(ordered.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuffer, end]);
}

export function readArchive(buffer: Buffer, options: ArchiveReadOptions = {}): ArchiveReadResult {
  const limits = { ...DEFAULTS, ...options };
  const problems: ArchiveProblem[] = [];
  const entries: ArchiveEntry[] = [];
  const seen = new Set<string>();
  const totalDigest = createHash("sha256");
  let totalBytes = 0;

  const fail = (code: ArchiveProblem["code"], path: string, message: string): void => {
    problems.push({ path, code, message });
  };

  if (buffer.length < 22) {
    return {
      entries: [],
      problems: [{ path: "", code: "TRUNCATED", message: "archive is shorter than its trailer" }],
      safe: false,
      digest: totalDigest.digest("hex"),
    };
  }

  // The end-of-central-directory record sits at the end, before an optional
  // comment of at most 65535 bytes.
  let endOffset = -1;
  const floor = Math.max(0, buffer.length - 22 - 65_535);
  for (let index = buffer.length - 22; index >= floor; index -= 1) {
    if (buffer.readUInt32LE(index) === END_SIGNATURE) {
      endOffset = index;
      break;
    }
  }
  if (endOffset === -1) {
    return {
      entries: [],
      problems: [
        { path: "", code: "MALFORMED", message: "archive has no end-of-directory record" },
      ],
      safe: false,
      digest: totalDigest.digest("hex"),
    };
  }

  const count = buffer.readUInt16LE(endOffset + 10);
  const centralSize = buffer.readUInt32LE(endOffset + 12);
  const centralOffset = buffer.readUInt32LE(endOffset + 16);
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    fail("ZIP64_UNSUPPORTED", "", "zip64 archives are not accepted");
    return { entries, problems, safe: false, digest: totalDigest.digest("hex") };
  }
  if (centralOffset + centralSize > buffer.length) {
    fail("TRUNCATED", "", "central directory extends past the archive");
    return { entries, problems, safe: false, digest: totalDigest.digest("hex") };
  }
  if (count > limits.maxEntries) {
    fail("TOO_MANY_ENTRIES", "", `archive declares ${count} entries`);
    return { entries, problems, safe: false, digest: totalDigest.digest("hex") };
  }

  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      fail("MALFORMED", "", "central directory entry is unreadable");
      break;
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const checksum = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const externalAttributes = buffer.readUInt32LE(cursor + 38);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;
    if (nameStart + nameLength > buffer.length) {
      fail("MALFORMED", "", "central directory name is truncated");
      break;
    }
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString("utf8");
    cursor = nameStart + nameLength + extraLength + commentLength;

    if (flags & 0x0001) {
      fail("ENCRYPTED", name, "encrypted entries are not accepted");
      continue;
    }
    const unixMode = (externalAttributes >>> 16) & 0xffff;
    const fileType = unixMode & 0o170000;
    if (fileType === 0o120000) {
      fail("SYMLINK", name, "symbolic links are not accepted");
      continue;
    }
    if (fileType !== 0 && fileType !== 0o100000) {
      fail("SYMLINK", name, "only regular files are accepted");
      continue;
    }
    if (method !== STORE && method !== DEFLATE) {
      fail("UNSUPPORTED_METHOD", name, `compression method ${method} is not supported`);
      continue;
    }
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      fail("ZIP64_UNSUPPORTED", name, "zip64 entry sizes are not accepted");
      continue;
    }
    if (uncompressedSize > limits.maxEntryBytes) {
      fail("ENTRY_TOO_LARGE", name, `entry declares ${uncompressedSize} bytes`);
      continue;
    }
    try {
      assertSafeEntryPath(name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code: ArchiveProblem["code"] = name.includes("\\")
        ? "BACKSLASH"
        : isAbsolute(name) || name.startsWith("/")
          ? "ABSOLUTE_PATH"
          : /(^|\/)\.\.(\/|$)/.test(name)
            ? "PATH_ESCAPE"
            : "MALFORMED";
      fail(code, name, message);
      continue;
    }
    if (seen.has(name)) {
      fail("DUPLICATE_ENTRY", name, "archive repeats an entry name");
      continue;
    }
    seen.add(name);

    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      fail("MALFORMED", name, "local header is unreadable");
      continue;
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > buffer.length) {
      fail("TRUNCATED", name, "entry data extends past the archive");
      continue;
    }
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    let data: Buffer;
    if (method === STORE) {
      data = Buffer.from(raw);
    } else {
      try {
        data = inflateRawSync(raw, { maxOutputLength: limits.maxEntryBytes });
      } catch (error) {
        fail("MALFORMED", name, error instanceof Error ? error.message : "inflate failed");
        continue;
      }
    }
    if (data.length !== uncompressedSize) {
      fail("CHECKSUM_MISMATCH", name, "entry size does not match its header");
      continue;
    }
    if (crc32(data) !== checksum) {
      fail("CHECKSUM_MISMATCH", name, "entry checksum does not match its data");
      continue;
    }
    totalBytes += data.length;
    if (totalBytes > limits.maxTotalBytes) {
      // The archive is over budget: refuse every entry, not just the one that
      // crossed the line, so a caller can never import a prefix of a bundle
      // that was declared too large.
      fail("ARCHIVE_TOO_LARGE", name, "archive exceeds the accepted total size");
      entries.length = 0;
      break;
    }
    totalDigest.update(name);
    totalDigest.update("\0");
    totalDigest.update(data);
    entries.push({
      path: name,
      data,
      digest: sha256Bytes(data),
      mode: unixMode & 0o777 || 0o644,
    });
  }

  return {
    entries,
    problems,
    safe: problems.length === 0,
    digest: totalDigest.digest("hex"),
  };
}

export interface ExtractOptions extends ArchiveReadOptions {
  /** False by default: a bundle never overwrites an existing local file. */
  overwrite?: boolean;
}

/**
 * Prepare one destination path and return it only when every component is a
 * real directory (or, for the final component, a regular file). A pre-existing
 * symlink anywhere beneath the root is refused: lexical validation alone cannot
 * see a link planted before extraction, and `mkdirSync({recursive})` and
 * `writeFileSync` would both follow it out of the root.
 */
function prepareTarget(baseReal: string, entryPath: string, overwrite: boolean): string {
  assertSafeEntryPath(entryPath);
  const segments = entryPath.split("/");
  let current = baseReal;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] as string;
    const next = join(current, segment);
    const last = index === segments.length - 1;
    let stats: ReturnType<typeof lstatSync> | null = null;
    try {
      stats = lstatSync(next);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "ENOENT") throw error;
    }
    if (stats) {
      if (stats.isSymbolicLink()) {
        throw new StateError("IMPORT_INVALID", "archive destination contains a symlink", {
          path: entryPath,
          component: next,
        });
      }
      if (last) {
        if (!stats.isFile()) {
          throw new StateError("IMPORT_INVALID", "archive destination is not a regular file", {
            path: entryPath,
            component: next,
          });
        }
        if (!overwrite) {
          throw new StateError(
            "IMPORT_INVALID",
            "file already exists; extraction never overwrites",
            {
              path: entryPath,
            },
          );
        }
      } else if (!stats.isDirectory()) {
        throw new StateError("IMPORT_INVALID", "archive destination path is not a directory", {
          path: entryPath,
          component: next,
        });
      }
    } else if (!last) {
      mkdirSync(next, { mode: 0o700 });
    }
    current = next;
  }
  // Belt and braces: the parent we are about to write into must still resolve
  // inside the root, so a race that swapped a directory for a link is refused
  // before any byte is written.
  const parentReal = realpathSync(dirname(current));
  if (parentReal !== baseReal && !parentReal.startsWith(`${baseReal}${sep}`)) {
    throw new StateError("IMPORT_INVALID", "archive entry escapes the extraction root", {
      path: entryPath,
      root: baseReal,
    });
  }
  return current;
}

/**
 * Extract beneath `root` only. Every path is revalidated lexically and against
 * the real filesystem, symlink entries were already dropped by the reader, and
 * files are created `0600` with no executable bit. A write is opened with
 * `O_NOFOLLOW`/`O_EXCL` so a link planted between the check and the write is
 * still refused.
 */
export function extractArchive(
  buffer: Buffer,
  root: string,
  options: ExtractOptions = {},
): {
  written: string[];
  skipped: Array<{ path: string; reason: string }>;
  problems: ArchiveProblem[];
} {
  const parsed = readArchive(buffer, options);
  const written: string[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  mkdirSync(resolve(root), { recursive: true, mode: 0o700 });
  const base = realpathSync(resolve(root));
  const overwrite = options.overwrite === true;

  for (const entry of parsed.entries) {
    let target: string;
    try {
      target = prepareTarget(base, entry.path, overwrite);
    } catch (error) {
      skipped.push({
        path: entry.path,
        reason: error instanceof Error ? error.message : "unsafe path",
      });
      continue;
    }
    const flags =
      fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      (overwrite ? fsConstants.O_TRUNC : fsConstants.O_EXCL) |
      (fsConstants.O_NOFOLLOW ?? 0);
    const descriptor = openSync(target, flags, 0o600);
    try {
      writeSync(descriptor, entry.data);
      chmodSync(target, 0o600);
    } finally {
      closeSync(descriptor);
    }
    written.push(entry.path);
  }

  return { written, skipped, problems: parsed.problems };
}

/** Read an archive from disk. The size cap is checked before parsing. */
export function readArchiveFile(path: string, options: ArchiveReadOptions = {}): ArchiveReadResult {
  const limits = { ...DEFAULTS, ...options };
  const buffer = readFileSync(path);
  if (buffer.length > limits.maxTotalBytes * 4) {
    return {
      entries: [],
      problems: [
        {
          path,
          code: "ARCHIVE_TOO_LARGE",
          message: `archive is ${buffer.length} bytes on disk`,
        },
      ],
      safe: false,
      digest: sha256Bytes(buffer),
    };
  }
  return readArchive(buffer, options);
}

/** Write an archive to disk at `0600`, creating the parent directory. */
export function writeArchiveFile(path: string, entries: readonly ArchiveEntryInput[]): Buffer {
  const buffer = writeArchive(entries);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, buffer, { mode: 0o600 });
  chmodSync(path, 0o600);
  return buffer;
}

export function joinEntryPath(...segments: string[]): string {
  return segments
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.replace(/^\/+|\/+$/g, ""))
    .join("/");
}

export function isArchivePath(path: string): boolean {
  return /\.zip$/i.test(path) || /\.mona$/i.test(path);
}

export const ARCHIVE_ROOT_JOIN = join;
