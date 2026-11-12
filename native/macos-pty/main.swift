// mona-pty — a minimal, native arm64 PTY host for Mona's integrated terminal.
//
// Why a helper process instead of a Node native module: Mona ships no native
// addon, so there is no Electron ABI coupling and nothing is compiled on a
// recipient Mac. The helper is a standalone Swift executable, ad-hoc signed in
// development and Developer-ID signed at P22.
//
// Contract (fixed; the TypeScript side validates it):
//   stdin  (fd 0)  raw bytes typed by the user        -> pty master
//   stdout (fd 1)  raw bytes produced by the shell    <- pty master
//   fd 3           newline-delimited JSON control:
//                    {"op":"resize","cols":120,"rows":40}
//                    {"op":"kill","signal":"TERM"|"INT"|"KILL"}
//                    {"op":"terminate"}   graceful: TERM, 2s, KILL
//   fd 4           newline-delimited JSON events:
//                    {"event":"started","pid":123,"cols":..,"rows":..}
//                    {"event":"exit","code":0,"signal":null}
//                    {"event":"error","message":".."}
//
// The child is launched as a session leader in a new process group with the pty
// as its controlling terminal, so `kill(-pid, sig)` reaches the whole foreground
// tree, matching how the owned runtime is stopped. The helper never reads shell
// startup files: the shell is exec'd with an explicit environment assembled by
// the caller, and `-f` skips zsh's rc files.

import Darwin
import Foundation

let CONTROL_FD: Int32 = 3
let EVENT_FD: Int32 = 4
let MAX_CONTROL_LINE = 4096
let READ_CHUNK = 16 * 1024

struct Options {
  var shell: String = "/bin/zsh"
  var arguments: [String] = ["-f"]
  var cwd: String
  var cols: Int = 80
  var rows: Int = 24
  var env: [String] = []
}

func fail(_ message: String) -> Never {
  writeEvent(["event": "error", "message": message])
  exit(70)
}

// Darwin exposes FD_SET/FD_ISSET as C macros, which Swift cannot import.
func fdZero(_ set: inout fd_set) {
  withUnsafeMutablePointer(to: &set.fds_bits) { pointer in
    pointer.withMemoryRebound(to: Int32.self, capacity: 32) { bits in
      for index in 0..<32 { bits[index] = 0 }
    }
  }
}

func fdSet(_ fd: Int32, _ set: inout fd_set) {
  guard fd >= 0, fd < 1024 else { return }
  let index = Int(fd / 32)
  let mask = Int32(1) << Int32(fd % 32)
  withUnsafeMutablePointer(to: &set.fds_bits) { pointer in
    pointer.withMemoryRebound(to: Int32.self, capacity: 32) { bits in
      bits[index] |= mask
    }
  }
}

func fdIsSet(_ fd: Int32, _ set: inout fd_set) -> Bool {
  guard fd >= 0, fd < 1024 else { return false }
  let index = Int(fd / 32)
  let mask = Int32(1) << Int32(fd % 32)
  return withUnsafeMutablePointer(to: &set.fds_bits) { pointer -> Bool in
    pointer.withMemoryRebound(to: Int32.self, capacity: 32) { bits in
      (bits[index] & mask) != 0
    }
  }
}

func writeAll(_ fd: Int32, _ bytes: UnsafeRawPointer, _ count: Int) -> Bool {
  var offset = 0
  while offset < count {
    let written = write(fd, bytes + offset, count - offset)
    if written > 0 {
      offset += written
    } else if written < 0 && errno == EINTR {
      continue
    } else {
      return false
    }
  }
  return true
}

func writeEvent(_ fields: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: fields, options: []),
    var text = String(data: data, encoding: .utf8)
  else { return }
  text += "\n"
  text.withCString { pointer in
    _ = writeAll(EVENT_FD, pointer, Int(strlen(pointer)))
  }
}

func parseOptions() -> Options {
  let defaults = FileManager.default.currentDirectoryPath
  var options = Options(cwd: defaults)
  let args = CommandLine.arguments
  var index = 1
  while index < args.count {
    let flag = args[index]
    let value: String? = index + 1 < args.count ? args[index + 1] : nil
    switch flag {
    case "--shell":
      if let value { options.shell = value }
      index += 2
    case "--arg":
      if let value { options.arguments.append(value) }
      index += 2
    case "--cwd":
      if let value { options.cwd = value }
      index += 2
    case "--cols":
      if let value, let parsed = Int(value) { options.cols = parsed }
      index += 2
    case "--rows":
      if let value, let parsed = Int(value) { options.rows = parsed }
      index += 2
    case "--env":
      if let value { options.env.append(value) }
      index += 2
    default:
      index += 1
    }
  }
  return options
}

func setWindowSize(_ fd: Int32, cols: Int, rows: Int) {
  var size = winsize()
  size.ws_col = UInt16(max(1, min(cols, 1000)))
  size.ws_row = UInt16(max(1, min(rows, 1000)))
  size.ws_xpixel = 0
  size.ws_ypixel = 0
  _ = ioctl(fd, UInt(TIOCSWINSZ), &size)
}

func signalNumber(_ name: String) -> Int32 {
  switch name.uppercased() {
  case "INT": return SIGINT
  case "KILL": return SIGKILL
  case "HUP": return SIGHUP
  case "QUIT": return SIGQUIT
  default: return SIGTERM
  }
}

let options = parseOptions()

// --- pty ---------------------------------------------------------------------
let master = posix_openpt(O_RDWR | O_NOCTTY)
if master < 0 { fail("posix_openpt failed: errno \(errno)") }
if grantpt(master) != 0 { fail("grantpt failed: errno \(errno)") }
if unlockpt(master) != 0 { fail("unlockpt failed: errno \(errno)") }
guard let slaveName = ptsname(master) else { fail("ptsname failed") }
let slavePath = strdup(String(cString: slaveName))
if slavePath == nil { fail("strdup failed") }
let slave = open(slavePath!, O_RDWR | O_NOCTTY)
if slave < 0 { fail("open slave failed: errno \(errno)") }
setWindowSize(master, cols: options.cols, rows: options.rows)

// --- argv / envp, built before fork so the child only calls async-safe code ---
var argvStrings: [String] = [options.shell] + options.arguments
var argvPointers: [UnsafeMutablePointer<CChar>?] = argvStrings.map { strdup($0) }
argvPointers.append(nil)
var envPointers: [UnsafeMutablePointer<CChar>?] = options.env.map { strdup($0) }
envPointers.append(nil)
let shellPointer = argvPointers[0]!

// --- spawn -------------------------------------------------------------------
// Swift marks fork() unavailable, so the fork/exec sequence lives in spawn.c and
// is linked into this binary. The child sets up its own session and controlling
// terminal there; nothing but the pty crosses into the shell.
@_silgen_name("mona_spawn_pty")
func mona_spawn_pty(
  _ slave: UnsafePointer<CChar>,
  _ shell: UnsafePointer<CChar>,
  _ argv: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>,
  _ envp: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>,
  _ cwd: UnsafePointer<CChar>
) -> Int32

let pid = options.cwd.withCString { cwdPointer in
  mona_spawn_pty(slavePath!, shellPointer, &argvPointers, &envPointers, cwdPointer)
}
if pid <= 0 { fail("spawn failed: errno \(pid == 0 ? 0 : -pid)") }

// --- parent ------------------------------------------------------------------
close(slave)
writeEvent([
  "event": "started",
  "pid": Int(pid),
  "cols": options.cols,
  "rows": options.rows,
  "shell": options.shell,
])

// A dead reader (Mona quitting) must not take the helper down mid-write.
signal(SIGPIPE, SIG_IGN)

var childExited = false
var exitCode: Int32 = 0
var exitSignal: Int32 = 0
var terminating = false
var terminateDeadline: DispatchTime? = nil
var masterOpen = true
var inputOpen = true
var pending = [UInt8]()
var controlBuffer = [UInt8]()

func reapIfExited() {
  if childExited { return }
  var status: Int32 = 0
  let result = waitpid(pid, &status, WNOHANG)
  if result == pid {
    childExited = true
    // Darwin's WIFEXITED/WEXITSTATUS/WTERMSIG are C macros Swift cannot import.
    let low = status & 0x7f
    if low == 0 {
      exitCode = (status >> 8) & 0xff
    } else if low != 0x7f {
      exitSignal = low
    }
  }
}

func signalGroup(_ signal: Int32) {
  if pid > 0 {
    _ = kill(-pid, signal)
    _ = kill(pid, signal)
  }
}

func beginTerminate() {
  if terminating { return }
  terminating = true
  signalGroup(SIGTERM)
  terminateDeadline = DispatchTime.now() + .milliseconds(2000)
}

func handleControl(_ line: [UInt8]) {
  guard !line.isEmpty,
    let object = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any],
    let op = object["op"] as? String
  else { return }
  switch op {
  case "resize":
    let cols = (object["cols"] as? Int) ?? options.cols
    let rows = (object["rows"] as? Int) ?? options.rows
    setWindowSize(master, cols: cols, rows: rows)
    writeEvent(["event": "resized", "cols": cols, "rows": rows])
  case "kill":
    let name = (object["signal"] as? String) ?? "TERM"
    signalGroup(signalNumber(name))
  case "terminate":
    beginTerminate()
  default:
    break
  }
}

func flushPending() -> Bool {
  guard !pending.isEmpty else { return true }
  let wrote = pending.withUnsafeBytes { buffer -> Int in
    write(STDOUT_FILENO, buffer.baseAddress, buffer.count)
  }
  if wrote > 0 {
    pending.removeFirst(wrote)
    return true
  }
  if wrote < 0 && errno == EINTR { return true }
  if wrote < 0 && errno == EAGAIN { return true }
  return false
}

func appendPending(_ bytes: UnsafeRawBufferPointer) {
  pending.append(contentsOf: bytes)
}

while true {
  reapIfExited()
  if childExited && pending.isEmpty && !masterOpen { break }
  if terminating, let deadline = terminateDeadline, DispatchTime.now() >= deadline {
    signalGroup(SIGKILL)
    terminateDeadline = nil
  }

  var readSet = fd_set()
  fdZero(&readSet)
  if masterOpen { fdSet(master, &readSet) }
  if inputOpen { fdSet(STDIN_FILENO, &readSet) }
  fdSet(CONTROL_FD, &readSet)
  var writeSet = fd_set()
  fdZero(&writeSet)
  if !pending.isEmpty { fdSet(STDOUT_FILENO, &writeSet) }

  var timeout = timeval(tv_sec: 0, tv_usec: 100_000)
  let ready = select(max(master, max(STDIN_FILENO, CONTROL_FD)) + 1, &readSet, &writeSet, nil, &timeout)
  if ready < 0 {
    if errno == EINTR { continue }
    break
  }

  if masterOpen && fdIsSet(master, &readSet) {
    var buffer = [UInt8](repeating: 0, count: READ_CHUNK)
    let count = buffer.withUnsafeMutableBytes { raw -> Int in
      read(master, raw.baseAddress, READ_CHUNK)
    }
    if count > 0 {
      buffer.withUnsafeBytes { raw in
        appendPending(UnsafeRawBufferPointer(rebasing: raw.prefix(count)))
      }
    } else if count == 0 {
      masterOpen = false
    } else if errno != EINTR && errno != EAGAIN {
      // EIO is the normal end-of-pty on macOS once the child is gone.
      masterOpen = false
    }
  }

  if inputOpen && fdIsSet(STDIN_FILENO, &readSet) {
    var buffer = [UInt8](repeating: 0, count: READ_CHUNK)
    let count = buffer.withUnsafeMutableBytes { raw -> Int in
      read(STDIN_FILENO, raw.baseAddress, READ_CHUNK)
    }
    if count > 0 {
      _ = buffer.withUnsafeBytes { raw in
        writeAll(master, raw.baseAddress!, count)
      }
    } else if count == 0 {
      inputOpen = false
    } else if errno != EINTR && errno != EAGAIN {
      inputOpen = false
    }
  }

  if fdIsSet(CONTROL_FD, &readSet) {
    var buffer = [UInt8](repeating: 0, count: MAX_CONTROL_LINE)
    let count = buffer.withUnsafeMutableBytes { raw -> Int in
      read(CONTROL_FD, raw.baseAddress, MAX_CONTROL_LINE)
    }
    if count > 0 {
      for byte in buffer.prefix(count) {
        if byte == 0x0A {
          handleControl(controlBuffer)
          controlBuffer.removeAll(keepingCapacity: true)
        } else if controlBuffer.count < MAX_CONTROL_LINE {
          controlBuffer.append(byte)
        }
      }
    } else if count == 0 {
      // The owner closed the control channel: end the session, do not orphan it.
      beginTerminate()
    }
  }

  if !pending.isEmpty && !flushPending() {
    beginTerminate()
    break
  }

  if childExited && !masterOpen { break }
}

// Drain anything the kernel still holds for the pty before reporting the exit.
if masterOpen {
  while true {
    var buffer = [UInt8](repeating: 0, count: READ_CHUNK)
    let count = buffer.withUnsafeMutableBytes { raw -> Int in
      read(master, raw.baseAddress, READ_CHUNK)
    }
    if count <= 0 { break }
    let wrote = buffer.withUnsafeBytes { raw in
      writeAll(STDOUT_FILENO, raw.baseAddress!, count)
    }
    if !wrote { break }
  }
}
_ = flushPending()
reapIfExited()
writeEvent([
  "event": "exit",
  "code": childExited && exitSignal == 0 ? Int(exitCode) : NSNull(),
  "signal": exitSignal == 0 ? NSNull() : Int(exitSignal),
])
exit(0)
