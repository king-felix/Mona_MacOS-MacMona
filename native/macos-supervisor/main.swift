// mona-supervisor — owned process-tree supervisor for Mona on macOS.
//
// Contract (see docs/decisions/ADR-003-runtime-supervisor.md):
//   mona-supervisor --control <socket> --workspace <dir> [--grace-ms N]
//                   [--log <file>] [--label <name>] -- <executable> [args...]
//
// fd 3 is the owner-liveness channel. Mona writes the runtime bearer token as
// the first newline-terminated line and then keeps the pipe open. EOF means the
// desktop owner is gone: the supervisor stops the child tree and exits. The
// token travels over that pipe, never over argv or the supervisor environment.
//
// The supervisor never becomes a daemon. It exits as soon as the child exits or
// the tree has been stopped. There is no login item, launch agent, or root
// service behind it.
//
// Ownership is tracked by (pid, start time) and process group. Descendants are
// sampled while the tree is alive so a grandchild that calls setpgid() or is
// reparented to launchd can still be identified and stopped by identity. A pid
// whose start time no longer matches is treated as reused and is never killed.

import Darwin
import Foundation

// MARK: - Receipts

func emit(_ object: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(object),
          let data = try? JSONSerialization.data(withJSONObject: object, options: []),
          var line = String(data: data, encoding: .utf8)
    else { return }
    line += "\n"
    FileHandle.standardOutput.write(Data(line.utf8))
}

func fail(_ code: Int32, _ message: String) -> Never {
    FileHandle.standardError.write(Data("mona-supervisor: \(message)\n".utf8))
    exit(code)
}

// MARK: - Arguments

struct Arguments {
    let controlSocket: String
    let workspace: String
    let graceMs: Int
    let logPath: String?
    let label: String
    let executable: String
    let childArguments: [String]
}

func parseArguments() -> Arguments {
    var control: String?
    var workspace: String?
    var graceMs = 8_000
    var logPath: String?
    var label = "runtime"
    var index = 1
    let argv = CommandLine.arguments
    while index < argv.count {
        let argument = argv[index]
        if argument == "--" {
            index += 1
            break
        }
        func value() -> String {
            index += 1
            guard index < argv.count else { fail(2, "missing value for \(argument)") }
            return argv[index]
        }
        switch argument {
        case "--control": control = value()
        case "--workspace": workspace = value()
        case "--grace-ms": graceMs = Int(value()) ?? 8_000
        case "--log": logPath = value()
        case "--label": label = value()
        case "--help":
            print(
                "usage: mona-supervisor --control <socket> --workspace <dir> "
                    + "[--grace-ms N] [--log <file>] [--label <name>] -- <exe> [args...]")
            exit(0)
        default:
            fail(2, "unknown argument \(argument)")
        }
        index += 1
    }
    guard let control, !control.isEmpty else { fail(2, "--control is required") }
    guard let workspace, !workspace.isEmpty else { fail(2, "--workspace is required") }
    guard index < argv.count else { fail(2, "child executable is required after --") }
    let executable = argv[index]
    let childArguments = Array(argv[(index + 1)...])
    return Arguments(
        controlSocket: control,
        workspace: workspace,
        graceMs: max(0, min(graceMs, 60_000)),
        logPath: logPath,
        label: label,
        executable: executable,
        childArguments: childArguments)
}

let options = parseArguments()

// MARK: - Process table

// sys/wait.h status macros are not imported into Swift.
func wifExited(_ status: Int32) -> Bool { (status & 0x7f) == 0 }
func wExitStatus(_ status: Int32) -> Int32 { (status >> 8) & 0xff }
func wifSignaled(_ status: Int32) -> Bool {
    let signal = status & 0x7f
    return signal != 0 && signal != 0x7f
}
func wTermSignal(_ status: Int32) -> Int32 { status & 0x7f }

struct ProcessIdentity: Equatable {
    let pid: Int32
    let pgid: Int32
    let startSec: Int64
    let startUsec: Int32

    var token: String { "\(pid):\(startSec).\(startUsec)" }
}

func processIdentity(_ pid: Int32) -> ProcessIdentity? {
    guard pid > 0 else { return nil }
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
    var info = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.stride
    let result = withUnsafeMutablePointer(to: &info) { pointer -> Int32 in
        pointer.withMemoryRebound(to: CChar.self, capacity: size) { raw in
            sysctl(&mib, 4, raw, &size, nil, 0)
        }
    }
    // A zombie is finished work, not a live process to signal or report.
    guard result == 0, info.kp_proc.p_pid == pid, info.kp_proc.p_stat != 5 else { return nil }
    let start = info.kp_proc.p_starttime
    return ProcessIdentity(
        pid: pid,
        pgid: info.kp_eproc.e_pgid,
        startSec: Int64(start.tv_sec),
        startUsec: Int32(start.tv_usec))
}

func allProcesses() -> [ProcessIdentity] {
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0]
    var size = 0
    guard sysctl(&mib, 4, nil, &size, nil, 0) == 0, size > 0 else { return [] }
    // The table can grow between the two calls; add slack and retry once.
    for _ in 0..<2 {
        let capacity = size / MemoryLayout<kinfo_proc>.stride + 32
        var buffer = [kinfo_proc](repeating: kinfo_proc(), count: capacity)
        var actual = capacity * MemoryLayout<kinfo_proc>.stride
        let result = buffer.withUnsafeMutableBytes { raw -> Int32 in
            sysctl(&mib, 4, raw.baseAddress, &actual, nil, 0)
        }
        if result == 0 {
            let count = actual / MemoryLayout<kinfo_proc>.stride
            return buffer.prefix(count).map { entry in
                let start = entry.kp_proc.p_starttime
                return ProcessIdentity(
                    pid: entry.kp_proc.p_pid,
                    pgid: entry.kp_eproc.e_pgid,
                    startSec: Int64(start.tv_sec),
                    startUsec: Int32(start.tv_usec))
            }
        }
        size += MemoryLayout<kinfo_proc>.stride * 32
    }
    return []
}

func parentMap() -> [Int32: Int32] {
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0]
    var size = 0
    guard sysctl(&mib, 4, nil, &size, nil, 0) == 0, size > 0 else { return [:] }
    let capacity = size / MemoryLayout<kinfo_proc>.stride + 32
    var buffer = [kinfo_proc](repeating: kinfo_proc(), count: capacity)
    var actual = capacity * MemoryLayout<kinfo_proc>.stride
    let result = buffer.withUnsafeMutableBytes { raw -> Int32 in
        sysctl(&mib, 4, raw.baseAddress, &actual, nil, 0)
    }
    guard result == 0 else { return [:] }
    var map: [Int32: Int32] = [:]
    for entry in buffer.prefix(actual / MemoryLayout<kinfo_proc>.stride) {
        map[entry.kp_proc.p_pid] = entry.kp_eproc.e_ppid
    }
    return map
}

// MARK: - Shared state

final class SupervisorState {
    let lock = NSLock()
    var childPid: Int32 = 0
    var childStart: ProcessIdentity?
    var tracked: [Int32: ProcessIdentity] = [:]
    var stopping = false
    var finished = false
    var childExit: [String: Any]?

    func withLock<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }
}

let state = SupervisorState()
let controlFD: Int32 = socket(AF_UNIX, SOCK_STREAM, 0)
guard controlFD >= 0 else { fail(4, "cannot create control socket: \(String(cString: strerror(errno)))") }

// MARK: - Stop routine

func signalOwned(_ signal: Int32) {
    // Snapshot under the lock; process lookups happen outside it.
    let (group, expected, tracked) = state.withLock {
        (state.childPid, state.childStart, state.tracked)
    }
    // The child leads its own process group by construction.
    if group > 0, let expected {
        let leader = processIdentity(group)
        if leader != nil && leader!.startSec == expected.startSec
            && leader!.startUsec == expected.startUsec
        {
            _ = kill(-group, signal)
        }
        // If the leader is gone, the group id may have been reused by a stranger.
        // Ownership then rests only on tracked (pid, start time) identities.
    }
    for (pid, identity) in tracked where pid != group {
        if let current = processIdentity(pid), current.startSec == identity.startSec,
           current.startUsec == identity.startUsec
        {
            _ = kill(pid, signal)
        }
    }
}

func aliveTracked() -> [Int32] {
    let (child, tracked) = state.withLock { (state.childStart, state.tracked) }
    var alive: [Int32] = []
    if let child, let current = processIdentity(child.pid),
       current.startSec == child.startSec, current.startUsec == child.startUsec
    {
        alive.append(child.pid)
    }
    for (pid, identity) in tracked {
        if let current = processIdentity(pid), current.startSec == identity.startSec,
           current.startUsec == identity.startUsec
        {
            alive.append(pid)
        }
    }
    return Array(Set(alive)).sorted()
}

/// Stop the owned tree: TERM the group and every tracked descendant, wait for
/// the grace period, then KILL whatever is still verifiably ours. Returns the
/// receipt fields. Safe to call more than once; only the first call acts.
func stopTree(reason: String, graceMs: Int, force: Bool) -> [String: Any] {
    let shouldRun = state.withLock { () -> Bool in
        if state.stopping || state.finished { return false }
        state.stopping = true
        return true
    }
    if !shouldRun {
        return ["ok": false, "state": "already_stopping"]
    }

    emit(["event": "stopping", "reason": reason, "grace_ms": graceMs, "force": force])
    // Capture descendants one last time before signalling: a grandchild that
    // escapes its process group between samples is still ours to clean up.
    trackDescendants()
    var escalated = false
    var signaled = 0

    if !force {
        let snapshot = state.withLock { state.tracked }
        let expected = state.withLock { state.childStart }
        if let leader = expected, let current = processIdentity(leader.pid),
           current.startSec == leader.startSec, current.startUsec == leader.startUsec
        {
            _ = kill(-leader.pid, SIGTERM)
            signaled += 1
        }
        for (pid, identity) in snapshot where pid != expected?.pid {
            if let current = processIdentity(pid), current.startSec == identity.startSec,
               current.startUsec == identity.startUsec
            {
                _ = kill(pid, SIGTERM)
                signaled += 1
            }
        }
        let deadline = Date().addingTimeInterval(Double(graceMs) / 1000.0)
        while Date() < deadline {
            if aliveTracked().isEmpty { break }
            usleep(50_000)
        }
    } else {
        escalated = true
        signalOwned(SIGKILL)
    }

    if !aliveTracked().isEmpty {
        escalated = true
        signalOwned(SIGKILL)
        let deadline = Date().addingTimeInterval(2.0)
        while Date() < deadline {
            if aliveTracked().isEmpty { break }
            usleep(50_000)
        }
    }

    // Reap our direct child if it has exited.
    var status: Int32 = 0
    let waited = waitpid(state.childPid, &status, WNOHANG)
    var exitReceipt: [String: Any] = ["code": NSNull(), "signal": NSNull(), "reaped": waited > 0]
    if waited > 0 {
        if wifExited(status) {
            exitReceipt["code"] = Int(wExitStatus(status))
        } else if wifSignaled(status) {
            exitReceipt["signal"] = Int(wTermSignal(status))
        }
        state.withLock { state.childExit = exitReceipt }
    }

    let survivors = aliveTracked()
    let receipt: [String: Any] = [
        "ok": true,
        "state": survivors.isEmpty ? "stopped" : "survivors",
        "reason": reason,
        "graceful": !force,
        "escalated": escalated,
        "signal_count": signaled,
        "survivors": survivors,
        "exit": exitReceipt,
    ]
    emit(["event": "stopped"].merging(receipt) { current, _ in current })
    return receipt
}

// MARK: - Descendant tracking

func trackDescendants() {
    let parent = parentMap()
    var byPid: [Int32: ProcessIdentity] = [:]
    for identity in allProcesses() { byPid[identity.pid] = identity }
    var children: [Int32: [Int32]] = [:]
    for (pid, ppid) in parent {
        children[ppid, default: []].append(pid)
    }
    let root = state.withLock { state.childPid }
    guard root > 0 else { return }
    var seen = Set<Int32>([root])
    var queue = [root]
    while let current = queue.popLast() {
        for child in children[current] ?? [] where !seen.contains(child) {
            seen.insert(child)
            queue.append(child)
        }
    }
    state.withLock {
        for pid in seen {
            if let identity = byPid[pid] { state.tracked[pid] = identity }
        }
        // Forget processes that are gone so the map cannot grow without bound.
        if state.tracked.count > 512 {
            state.tracked = state.tracked.filter { processIdentity($0.key) != nil }
        }
    }
}

// MARK: - Owner liveness (fd 3)

func readOwnerChannel() -> String {
    var line = Data()
    var byte: UInt8 = 0
    while true {
        let count = read(3, &byte, 1)
        if count <= 0 { return "" }
        if byte == 0x0A { break }
        line.append(byte)
        if line.count > 512 { return "" }
    }
    return String(data: line, encoding: .utf8) ?? ""
}

func watchOwner() {
    DispatchQueue.global().async {
        // Every byte after the token line is a heartbeat; EOF is the signal.
        var buffer = [UInt8](repeating: 0, count: 256)
        while true {
            let count = read(3, &buffer, buffer.count)
            if count > 0 { continue }
            if count == 0 {
                let receipt = stopTree(reason: "owner_liveness_lost", graceMs: options.graceMs, force: false)
                finish(exitCode: receipt["state"] as? String == "stopped" ? 0 : 1)
            }
            if errno == EINTR { continue }
            return
        }
    }
}

// MARK: - Finish

func finish(exitCode: Int32) -> Never {
    let already = state.withLock { () -> Bool in
        if state.finished { return true }
        state.finished = true
        return false
    }
    if !already {
        emit(["event": "exiting", "supervisor_pid": Int32(getpid())])
    }
    _ = unlink(options.controlSocket)
    exit(exitCode)
}

// MARK: - Control socket

func respond(_ fd: Int32, _ object: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(object),
          let data = try? JSONSerialization.data(withJSONObject: object, options: [])
    else { return }
    var payload = data
    payload.append(0x0A)
    payload.withUnsafeBytes { raw in
        var offset = 0
        while offset < raw.count {
            let written = write(fd, raw.baseAddress!.advanced(by: offset), raw.count - offset)
            if written <= 0 { break }
            offset += written
        }
    }
}

func handleControlConnection(_ fd: Int32) {
    var buffer = Data()
    var chunk = [UInt8](repeating: 0, count: 1024)
    while !buffer.contains(0x0A) && buffer.count < 8_192 {
        let count = read(fd, &chunk, chunk.count)
        if count <= 0 { break }
        buffer.append(contentsOf: chunk[0..<count])
    }
    guard let newline = buffer.firstIndex(of: 0x0A) else {
        respond(fd, ["ok": false, "error": "missing request"])
        close(fd)
        return
    }
    let body = buffer[buffer.startIndex..<newline]
    guard let request = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any],
          let operation = request["op"] as? String
    else {
        respond(fd, ["ok": false, "error": "malformed request"])
        close(fd)
        return
    }
    switch operation {
    case "status":
        respond(fd, [
            "ok": true,
            "state": state.withLock { state.finished ? "exited" : (state.stopping ? "stopping" : "running") },
            "supervisor_pid": Int32(getpid()),
            "child_pid": state.withLock { state.childPid },
            "child_start": (state.withLock { state.childStart?.token }) as Any? ?? NSNull(),
            "tracked": state.withLock { state.tracked.count },
            "alive": aliveTracked(),
        ])
        close(fd)
    case "stop", "force-stop":
        let force = operation == "force-stop" || (request["force"] as? Bool ?? false)
        let grace = (request["graceMs"] as? Int) ?? options.graceMs
        let receipt = stopTree(reason: "control_request", graceMs: grace, force: force)
        respond(fd, receipt.merging(["ok": true]) { current, _ in current })
        close(fd)
        finish(exitCode: (receipt["state"] as? String) == "stopped" ? 0 : 1)
    default:
        respond(fd, ["ok": false, "error": "unknown op \(operation)"])
        close(fd)
    }
}

func serveControlSocket() {
    _ = unlink(options.controlSocket)
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let pathBytes = Array(options.controlSocket.utf8)
    guard pathBytes.count < MemoryLayout.size(ofValue: address.sun_path) else {
        fail(4, "control socket path is too long")
    }
    withUnsafeMutablePointer(to: &address.sun_path) { pointer in
        pointer.withMemoryRebound(to: CChar.self, capacity: pathBytes.count) { destination in
            for (index, byte) in pathBytes.enumerated() {
                destination[index] = CChar(bitPattern: byte)
            }
        }
    }
    let length = socklen_t(MemoryLayout<sockaddr_un>.size)
    let bindResult = withUnsafePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
            bind(controlFD, sockaddrPointer, length)
        }
    }
    guard bindResult == 0 else {
        fail(4, "cannot bind control socket \(options.controlSocket): \(String(cString: strerror(errno)))")
    }
    _ = chmod(options.controlSocket, 0o600)
    guard listen(controlFD, 8) == 0 else {
        fail(4, "cannot listen on control socket: \(String(cString: strerror(errno)))")
    }
    DispatchQueue.global().async {
        while true {
            let connection = accept(controlFD, nil, nil)
            if connection < 0 {
                if errno == EINTR { continue }
                return
            }
            DispatchQueue.global().async { handleControlConnection(connection) }
        }
    }
}

// MARK: - Spawn

let ownerToken = readOwnerChannel()
guard ownerToken.count >= 16 else {
    fail(3, "owner liveness channel must provide the runtime token on fd 3")
}

// Signals and owner liveness are active before the child exists, so a stop or
// an owner death during startup still cleans up whatever has been spawned.
signal(SIGPIPE, SIG_IGN)
signal(SIGTERM, SIG_IGN)
let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
termSource.setEventHandler {
    let receipt = stopTree(reason: "supervisor_sigterm", graceMs: options.graceMs, force: false)
    finish(exitCode: (receipt["state"] as? String) == "stopped" ? 0 : 1)
}
termSource.resume()
watchOwner()

// Only the supervisor's own working directory changes; the child inherits it.
guard chdir(options.workspace) == 0 else {
    fail(5, "cannot enter workspace \(options.workspace): \(String(cString: strerror(errno)))")
}

var logFD: Int32 = open("/dev/null", O_WRONLY)
if let logPath = options.logPath {
    logFD = open(logPath, O_WRONLY | O_CREAT | O_APPEND, 0o600)
}
guard logFD >= 0 else { fail(5, "cannot open log file: \(String(cString: strerror(errno)))") }

var environment = ProcessInfo.processInfo.environment
environment["CODEWHALE_RUNTIME_TOKEN"] = ownerToken
var argumentPointers = ([options.executable] + options.childArguments).map { strdup($0) }
argumentPointers.append(nil)
var environmentPointers = environment.map { strdup("\($0.key)=\($0.value)") }
environmentPointers.append(nil)

var fileActions: posix_spawn_file_actions_t?
posix_spawn_file_actions_init(&fileActions)
posix_spawn_file_actions_adddup2(&fileActions, logFD, 1)
posix_spawn_file_actions_adddup2(&fileActions, logFD, 2)

var attributes: posix_spawnattr_t?
posix_spawnattr_init(&attributes)
var flags = Int16(POSIX_SPAWN_SETPGROUP)
#if canImport(Darwin)
flags |= Int16(POSIX_SPAWN_CLOEXEC_DEFAULT)
#endif
posix_spawnattr_setflags(&attributes, flags)
posix_spawnattr_setpgroup(&attributes, 0)

var childPid: pid_t = 0
let spawnResult = posix_spawn(
    &childPid, options.executable, &fileActions, &attributes, argumentPointers, environmentPointers)

// Free the strdup'ed arrays; the kernel has copied them.
for pointer in argumentPointers where pointer != nil { free(pointer) }
for pointer in environmentPointers where pointer != nil { free(pointer) }
posix_spawn_file_actions_destroy(&fileActions)
posix_spawnattr_destroy(&attributes)
if logFD > 2 { close(logFD) }

guard spawnResult == 0 else {
    emit([
        "event": "spawn_failed",
        "errno": Int(spawnResult),
        "message": String(cString: strerror(spawnResult)),
        "executable": options.executable,
    ])
    finish(exitCode: 6)
}

guard let identity = processIdentity(childPid) else {
    emit(["event": "spawn_failed", "errno": Int(ECHILD), "message": "child identity unavailable"])
    _ = kill(-childPid, SIGKILL)
    finish(exitCode: 6)
}
state.withLock {
    state.childPid = childPid
    state.childStart = identity
    state.tracked[childPid] = identity
}

emit([
    "event": "started",
    "supervisor_pid": Int32(getpid()),
    "child_pid": Int32(childPid),
    "child_start": identity.token,
    "pgid": Int32(childPid),
    "executable": options.executable,
    "label": options.label,
    "token_source": "fd3",
])

serveControlSocket()

// The supervisor exits when the child exits; a detached child never outlives
// its owner unnoticed. Bounded restart is Mona's decision, not the supervisor's.
DispatchQueue.global().async {
    trackDescendants()
    while true {
        if state.withLock({ state.stopping || state.finished }) { break }
        var status: Int32 = 0
        let result = waitpid(childPid, &status, WNOHANG)
        if result == childPid {
            // A stop request owns the exit path; never race it to exit(0).
            if state.withLock({ state.stopping || state.finished }) { break }
            var receipt: [String: Any] = ["code": NSNull(), "signal": NSNull()]
            if wifExited(status) {
                receipt["code"] = Int(wExitStatus(status))
            } else if wifSignaled(status) {
                receipt["signal"] = Int(wTermSignal(status))
            }
            state.withLock { state.childExit = receipt }
            // Clean up descendants that the child left behind.
            _ = stopTree(reason: "child_exited", graceMs: 1_000, force: false)
            emit(["event": "exited", "child_pid": Int32(childPid), "exit": receipt])
            finish(exitCode: 0)
        }
        usleep(100_000)
    }
}

// Sample descendants continuously so escaped or reparented grandchildren keep
// their recorded identity for the stop path.
let timer = DispatchSource.makeTimerSource(queue: .global())
timer.schedule(deadline: .now(), repeating: .milliseconds(250))
timer.setEventHandler { trackDescendants() }
timer.resume()

dispatchMain()
