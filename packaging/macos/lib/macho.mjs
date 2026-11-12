/**
 * Minimal Mach-O reader used by the packaging gate.
 *
 * Architecture and minimum-OS checks must not depend on the developer's `file`
 * or `otool` output being parsed by eye, and they must work on a fat binary
 * slice. Only the fields the packaging manifest needs are decoded.
 */

const CPU_TYPES = new Map([
  [7, "i386"],
  [0x01000007, "x86_64"],
  [12, "arm"],
  [0x0100000c, "arm64"],
  [0x0200000c, "arm64_32"],
  [18, "ppc"],
  [0x01000012, "ppc64"],
]);

const MH_MAGIC = 0xfeedface;
const MH_MAGIC_64 = 0xfeedfacf;
const MH_CIGAM = 0xcefaedfe;
const MH_CIGAM_64 = 0xcffaedfe;
const FAT_MAGIC = 0xcafebabe;
const FAT_CIGAM = 0xbebafeca;
const FAT_MAGIC_64 = 0xcafebabf;
const FAT_CIGAM_64 = 0xbfbafeca;

const LC_VERSION_MIN_MACOSX = 0x24;
const LC_BUILD_VERSION = 0x32;
const PLATFORM_MACOS = 1;

function versionString(packed) {
  const major = (packed >>> 16) & 0xffff;
  const minor = (packed >>> 8) & 0xff;
  const patch = packed & 0xff;
  return patch === 0 ? `${major}.${minor}` : `${major}.${minor}.${patch}`;
}

function thinSlice(buffer, offset, littleEndian, is64) {
  const read32 = (at) =>
    littleEndian ? buffer.readUInt32LE(offset + at) : buffer.readUInt32BE(offset + at);
  const cpuType = read32(4) >>> 0;
  const ncmds = read32(16);
  const headerSize = is64 ? 32 : 28;
  let cursor = offset + headerSize;
  let minOs = null;
  for (let index = 0; index < ncmds && cursor + 8 <= buffer.length; index += 1) {
    const command = read32(cursor - offset);
    const size = read32(cursor - offset + 4);
    if (size < 8) break;
    if (command === LC_BUILD_VERSION && size >= 16) {
      const platform = read32(cursor - offset + 8);
      if (platform === PLATFORM_MACOS) minOs = versionString(read32(cursor - offset + 12));
    } else if (command === LC_VERSION_MIN_MACOSX && size >= 12) {
      minOs ??= versionString(read32(cursor - offset + 8));
    }
    cursor += size;
  }
  return { architecture: CPU_TYPES.get(cpuType) ?? `cpu:${cpuType}`, minOs };
}

function decodeThin(buffer, offset = 0) {
  if (offset + 8 > buffer.length) return null;
  const magic = buffer.readUInt32BE(offset);
  let littleEndian;
  let is64;
  if (magic === MH_MAGIC) [littleEndian, is64] = [false, false];
  else if (magic === MH_MAGIC_64) [littleEndian, is64] = [false, true];
  else if (magic === MH_CIGAM) [littleEndian, is64] = [true, false];
  else if (magic === MH_CIGAM_64) [littleEndian, is64] = [true, true];
  else return null;
  return thinSlice(buffer, offset, littleEndian, is64);
}

/**
 * Returns `null` for a non-Mach-O file, otherwise the architectures present and
 * the minimum macOS version recorded by the first macOS build-version command.
 */
export function readMachO(buffer) {
  if (buffer.length < 8) return null;
  const magic = buffer.readUInt32BE(0);
  if (magic === MH_MAGIC || magic === MH_MAGIC_64 || magic === MH_CIGAM || magic === MH_CIGAM_64) {
    const slice = decodeThin(buffer, 0);
    if (!slice) return null;
    return {
      kind: "mach-o",
      fat: false,
      architectures: [slice.architecture],
      minOs: slice.minOs,
    };
  }
  const fat =
    magic === FAT_MAGIC || magic === FAT_CIGAM || magic === FAT_MAGIC_64 || magic === FAT_CIGAM_64;
  if (!fat) return null;
  const littleEndian =
    magic === FAT_CIGAM || magic === FAT_CIGAM_64 || magic === 0xbebafeca || magic === 0xbfbafeca;
  const is64 = magic === FAT_MAGIC_64 || magic === FAT_CIGAM_64 || magic === 0xbfbafeca;
  const read32 = (at) => (littleEndian ? buffer.readUInt32LE(at) : buffer.readUInt32BE(at));
  const count = read32(4);
  const architectures = [];
  let minOs = null;
  let cursor = 8;
  for (let index = 0; index < count && cursor + 20 <= buffer.length; index += 1) {
    const cpuType = read32(cursor) >>> 0;
    const offset = is64 ? Number(buffer.readBigUInt64BE(cursor + 8)) : read32(cursor + 8);
    architectures.push(CPU_TYPES.get(cpuType) ?? `cpu:${cpuType}`);
    const slice = decodeThin(buffer, offset);
    if (slice?.minOs && CPU_TYPES.get(cpuType) === "arm64" && !minOs) minOs = slice.minOs;
    cursor += is64 ? 32 : 20;
  }
  return { kind: "mach-o", fat: true, architectures, minOs };
}
