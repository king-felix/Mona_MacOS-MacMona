// Mona.service — Finder selected-folder Service.
//
// Receives local file URLs from the macOS Services mechanism, validates them as
// exactly one accessible folder, and forwards that folder to the installed
// Mona.app by bundle identity. It never runs the model, never reads project
// contents, never constructs a shell command, and never submits work.
//
// Two entry points share one code path:
//   * Service mode (no arguments): AppKit invokes `startProject` through the
//     provider object declared in NSServices.
//   * CLI mode (`--cli`): used by tests and by the doctor command; prints a
//     JSON receipt and writes the same receipt file.

import AppKit
import Foundation
import Security

// MARK: - Contract

let kServiceMenuTitle = "Start new DS project with Mona"
let kServiceMessage = "startProject"
let kAppBundleIdentifier = "com.mona.workbench"
let kReceiptSchema = 1
let kOpenFolderArgument = "--open-folder"

/// Where the service records the last handoff. Matches the app's per-user
/// Application Support directory (spec §19.2) so diagnostics are in one place.
func defaultReceiptPath() -> String {
    let home = FileManager.default.homeDirectoryForCurrentUser
    let support = home
        .appendingPathComponent("Library/Application Support/Mona/services", isDirectory: true)
    return support.appendingPathComponent("last-handoff.json").path
}

// MARK: - Receipt

struct Receipt: Encodable {
    var schema_version: Int = kReceiptSchema
    var ok: Bool
    var action: String
    var code: String?
    var reason: String?
    var invocation: String
    var inputs: [String]
    var resolved_path: String?
    var device: Int64?
    var inode: Int64?
    var app_bundle_identifier: String?
    var app_path: String?
    var app_signature: String?
    var forwarded: Bool
    var strategy: String?
    var notes: [String]
    var timestamp: String
}

func timestamp() -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: Date())
}

// Bounded, secret-free trace of each invocation's phases. It is the only way
// to tell "the system never called us" apart from "we refused"; the app's
// doctor reads it.
func tracePath() -> String {
    let home = FileManager.default.homeDirectoryForCurrentUser
    return home
        .appendingPathComponent("Library/Application Support/Mona/services", isDirectory: true)
        .appendingPathComponent("service-trace.json").path
}

func trace(_ phase: String, _ extra: [String: Any] = [:]) {
    let path = tracePath()
    var phases: [[String: Any]] = []
    if let existing = try? Data(contentsOf: URL(fileURLWithPath: path)),
        let parsed = try? JSONSerialization.jsonObject(with: existing) as? [String: Any],
        let previous = parsed["phases"] as? [[String: Any]]
    {
        phases = previous
    }
    var entry: [String: Any] = ["phase": phase, "at": timestamp(), "pid": ProcessInfo.processInfo.processIdentifier]
    for (key, value) in extra { entry[key] = value }
    phases.append(entry)
    let document: [String: Any] = ["schema_version": 1, "phases": Array(phases.suffix(40))]
    do {
        let url = URL(fileURLWithPath: path)
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        let data = try JSONSerialization.data(
            withJSONObject: document, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: url, options: .atomic)
    } catch {
        // Tracing must never break the service.
    }
}

func writeReceipt(_ receipt: Receipt, to path: String?) {
    let target = path ?? defaultReceiptPath()
    do {
        let url = URL(fileURLWithPath: target)
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        var data = try encoder.encode(receipt)
        data.append(0x0A)
        try data.write(to: url, options: [.atomic])
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    } catch {
        FileHandle.standardError.write(
            Data("mona-service: could not write receipt at \(target): \(error)\n".utf8)
        )
    }
}

// MARK: - Refusals

enum FolderRefusal: Error {
    case emptyInvocation
    case multiSelection(count: Int, paths: [String])
    case unsupportedScheme(String)
    case remoteFileURL(String)
    case emptyPath
    case embeddedNull
    case missing(String)
    case notADirectory(String)
    case notReadable(String)
    case rootVolume(String)
    case onlineOnly(String)
    case aliasUnresolved(String, String)
    case appNotFound
    case appUntrusted(String)
    case forwardFailed(String)

    var code: String {
        switch self {
        case .emptyInvocation: return "NO_FILE_URL"
        case .multiSelection: return "MULTI_SELECTION"
        case .unsupportedScheme: return "UNSUPPORTED_SCHEME"
        case .remoteFileURL: return "REMOTE_FILE_URL"
        case .emptyPath: return "EMPTY_PATH"
        case .embeddedNull: return "EMBEDDED_NULL"
        case .missing: return "MISSING"
        case .notADirectory: return "NOT_A_DIRECTORY"
        case .notReadable: return "NOT_READABLE"
        case .rootVolume: return "ROOT_VOLUME"
        case .onlineOnly: return "ONLINE_ONLY"
        case .aliasUnresolved: return "ALIAS_UNRESOLVED"
        case .appNotFound: return "APP_NOT_FOUND"
        case .appUntrusted: return "APP_UNTRUSTED"
        case .forwardFailed: return "FORWARD_FAILED"
        }
    }

    var reason: String {
        switch self {
        case .emptyInvocation:
            return "Mona needs one selected folder. Select a folder in Finder, then choose Services → \(kServiceMenuTitle)."
        case .multiSelection(let count, let paths):
            return "Mona opens one project at a time; \(count) folders were selected (\(paths.prefix(3).joined(separator: ", ")))."
        case .unsupportedScheme(let value):
            return "Mona only opens local folders. '\(value)' is not a file URL or an absolute path."
        case .remoteFileURL(let host):
            return "'\(host)' names a remote file server; Mona only opens folders on this Mac."
        case .emptyPath:
            return "That file URL does not name a folder."
        case .embeddedNull:
            return "The selected item's path contains a null character and cannot be opened."
        case .missing(let path):
            return "'\(path)' no longer exists. It may have been moved, renamed, or unmounted."
        case .notADirectory(let path):
            return "'\(path)' is a file, not a folder. Mona opens project folders."
        case .notReadable(let path):
            return "Mona cannot read '\(path)'. Grant access in System Settings → Privacy & Security, or choose a folder inside your home folder."
        case .rootVolume(let path):
            return "'\(path)' is a disk root. Open the project folder rather than the whole volume."
        case .onlineOnly(let path):
            return "'\(path)' is an online-only cloud item. Download it in Finder (right-click → Download Now), then try again."
        case .aliasUnresolved(let path, let detail):
            return "Mona could not resolve the alias '\(path)': \(detail)"
        case .appNotFound:
            return "Mona is not installed where this service expects it. Install or reinstall Mona, then try again."
        case .appUntrusted(let detail):
            return "The Mona app at that location did not pass signature validation (\(detail)). Reinstall Mona from a trusted copy."
        case .forwardFailed(let detail):
            return "macOS could not hand the folder to Mona: \(detail)"
        }
    }
}

// MARK: - Folder validation

struct FolderTarget {
    var input: String
    var url: URL
    var notes: [String]
}

func fileURLFromInput(_ raw: String) throws -> URL {
    if raw.isEmpty { throw FolderRefusal.emptyPath }
    if raw.contains("\u{0}") { throw FolderRefusal.embeddedNull }

    if let url = URL(string: raw), let scheme = url.scheme, !scheme.isEmpty {
        let lowered = scheme.lowercased()
        guard lowered == "file" else { throw FolderRefusal.unsupportedScheme(raw) }
        // A file URL may not name another host; `file://server/share` is not a
        // local folder and must never be treated as one.
        if let host = url.host, !host.isEmpty, host.lowercased() != "localhost" {
            throw FolderRefusal.remoteFileURL(host)
        }
        guard !url.path.isEmpty else { throw FolderRefusal.emptyPath }
        return url
    }

    // No scheme: only an absolute path is accepted. Nothing is interpolated
    // into a shell, so spaces, quotes, newlines, and metacharacters are simply
    // part of the path.
    guard raw.hasPrefix("/") else { throw FolderRefusal.unsupportedScheme(raw) }
    return URL(fileURLWithPath: raw)
}

func validateFolder(_ raw: String) throws -> FolderTarget {
    var notes: [String] = []
    let initial = try fileURLFromInput(raw)

    if initial.path.precomposedStringWithCanonicalMapping != initial.path {
        notes.append("unicode: input was not NFC; using the filesystem path")
    }
    if initial.path != raw && !raw.hasPrefix("file:") {
        notes.append("normalized: path resolved from '\(raw)'")
    }

    // Finder aliases and symlinks resolve to the real folder before anything is
    // forwarded, so the catalog identity matches what the user sees.
    var resolved = initial
    do {
        let aliasResolved = try URL(resolvingAliasFileAt: initial, options: [.withoutUI])
        if aliasResolved.standardizedFileURL.path != initial.standardizedFileURL.path {
            notes.append("resolved: \(initial.path) → \(aliasResolved.path)")
        }
        resolved = aliasResolved
    } catch {
        let nsError = error as NSError
        if nsError.code == NSFileNoSuchFileError || nsError.code == NSFileReadNoSuchFileError {
            throw FolderRefusal.missing(initial.path)
        }
        if nsError.code == NSFileReadUnknownError || nsError.domain == NSCocoaErrorDomain {
            if !FileManager.default.fileExists(atPath: initial.path) {
                throw FolderRefusal.missing(initial.path)
            }
        }
        throw FolderRefusal.aliasUnresolved(initial.path, nsError.localizedDescription)
    }

    // `standardizedFileURL` removes `.`/`..` without touching the filesystem,
    // keeping the receipt stable while `resolvingAliasFileAt` above resolved
    // links.
    let candidate = resolved.standardizedFileURL
    let path = candidate.path

    if path == "/" {
        throw FolderRefusal.rootVolume(path)
    }

    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory) else {
        throw FolderRefusal.missing(path)
    }
    guard isDirectory.boolValue else {
        throw FolderRefusal.notADirectory(path)
    }

    let keys: Set<URLResourceKey> = [
        .isDirectoryKey, .isReadableKey, .isVolumeKey,
        .isUbiquitousItemKey, .ubiquitousItemDownloadingStatusKey,
    ]
    let values: URLResourceValues
    do {
        values = try candidate.resourceValues(forKeys: keys)
    } catch {
        throw FolderRefusal.notReadable(path)
    }

    if values.isReadable == false {
        throw FolderRefusal.notReadable(path)
    }
    if values.isUbiquitousItem == true,
        values.ubiquitousItemDownloadingStatus == .notDownloaded
    {
        throw FolderRefusal.onlineOnly(path)
    }
    if values.isVolume == true {
        notes.append("volume_root: the folder is a volume root; Mona will use it as the project root")
    }

    return FolderTarget(input: raw, url: candidate, notes: notes)
}

// MARK: - App identity

struct AppIdentity {
    var url: URL
    var bundleIdentifier: String
    var signature: String
    var notes: [String]
}

func signatureSummary(of appURL: URL) -> (valid: Bool, detail: String) {
    var staticCode: SecStaticCode?
    var status = SecStaticCodeCreateWithPath(appURL as CFURL, SecCSFlags(rawValue: 0), &staticCode)
    guard status == errSecSuccess, let code = staticCode else {
        return (false, "unreadable code (OSStatus \(status))")
    }
    status = SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: 0), nil)
    guard status == errSecSuccess else {
        return (false, "invalid signature (OSStatus \(status))")
    }

    var information: CFDictionary?
    let infoStatus = SecCodeCopySigningInformation(
        code, SecCSFlags(rawValue: kSecCSSigningInformation), &information)
    guard infoStatus == errSecSuccess, let info = information as? [String: Any] else {
        return (true, "valid, signing information unavailable")
    }
    let identifier = info[kSecCodeInfoIdentifier as String] as? String ?? "unknown"
    let team = info[kSecCodeInfoTeamIdentifier as String] as? String ?? ""
    let flags = info[kSecCodeInfoFlags as String] as? UInt32 ?? 0
    // CS_ADHOC (0x2) is not re-exported to Swift; the value is stable in
    // <Security/SecCode.h> and is only used to describe, never to decide.
    let adhoc = (flags & 0x2) != 0
    if !team.isEmpty {
        return (true, "developer-id:\(team):\(identifier)")
    }
    if adhoc {
        return (true, "adhoc:\(identifier)")
    }
    return (true, "signed:\(identifier)")
}

/// The installer owns `/Applications/Mona.app`. When a developer also has a
/// copy registered with the same bundle identifier, LaunchServices may return
/// either one; prefer the installed location so a stray build cannot intercept
/// a Finder handoff. A candidate is only accepted when it is the expected
/// bundle, executable, and validly signed.
func installedAppCandidate() -> URL? {
    let installed = URL(fileURLWithPath: "/Applications/Mona.app", isDirectory: true)
        .standardizedFileURL
    guard FileManager.default.fileExists(atPath: installed.path),
        let bundle = Bundle(url: installed),
        bundle.bundleIdentifier == kAppBundleIdentifier,
        let executable = bundle.executableURL,
        FileManager.default.isExecutableFile(atPath: executable.path),
        signatureSummary(of: installed).valid
    else {
        return nil
    }
    return installed
}

func locateApp(override: String?) throws -> AppIdentity {
    var notes: [String] = []
    var appURL: URL
    if let override, !override.isEmpty {
        appURL = URL(fileURLWithPath: override).standardizedFileURL
        notes.append("app: located by explicit path (development)")
    } else if let installed = installedAppCandidate() {
        appURL = installed
        notes.append("app: preferred the installed copy at \(installed.path)")
    } else {
        guard
            let located = NSWorkspace.shared.urlForApplication(
                withBundleIdentifier: kAppBundleIdentifier)
        else {
            throw FolderRefusal.appNotFound
        }
        appURL = located.standardizedFileURL
        notes.append("app: located by bundle identity \(kAppBundleIdentifier)")
    }

    guard FileManager.default.fileExists(atPath: appURL.path) else {
        throw FolderRefusal.appNotFound
    }
    guard let bundle = Bundle(url: appURL) else {
        throw FolderRefusal.appUntrusted("\(appURL.path) is not an application bundle")
    }
    let identifier = bundle.bundleIdentifier ?? ""
    guard identifier == kAppBundleIdentifier else {
        throw FolderRefusal.appUntrusted(
            "bundle identifier is '\(identifier)', expected '\(kAppBundleIdentifier)'")
    }
    let executable = bundle.executableURL
    guard let executable, FileManager.default.isExecutableFile(atPath: executable.path) else {
        throw FolderRefusal.appUntrusted("the app has no executable")
    }
    let signature = signatureSummary(of: appURL)
    guard signature.valid else {
        throw FolderRefusal.appUntrusted(signature.detail)
    }
    return AppIdentity(
        url: appURL, bundleIdentifier: identifier, signature: signature.detail, notes: notes)
}

// MARK: - Forwarding

enum ForwardStrategy: String {
    /// Apple `open documents` event addressed to the app. Works whether Mona is
    /// running or not, and is the public path for folder-to-app handoff.
    case documents
    /// Launch the app with `--open-folder`; a running Mona receives it through
    /// its single-instance handling.
    case instance

    static func parse(_ value: String?) -> ForwardStrategy? {
        guard let value else { return .documents }
        switch value {
        case "documents": return .documents
        case "instance": return .instance
        case "auto": return .documents
        default: return nil
        }
    }
}

func forwardWithDocuments(_ folder: URL, app: URL) throws {
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = true
    configuration.addsToRecentItems = false
    let semaphore = DispatchSemaphore(value: 0)
    var failure: String?

    NSWorkspace.shared.open([folder], withApplicationAt: app, configuration: configuration) {
        _, error in
        if let error { failure = error.localizedDescription }
        semaphore.signal()
    }

    if semaphore.wait(timeout: .now() + 10) == .timedOut {
        throw FolderRefusal.forwardFailed("the launch request timed out")
    }
    if let failure { throw FolderRefusal.forwardFailed(failure) }
}

func forwardWithInstance(_ folder: URL, app: URL) throws {
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = true
    configuration.addsToRecentItems = false
    configuration.createsNewApplicationInstance = true
    configuration.arguments = [kOpenFolderArgument, folder.path]
    let semaphore = DispatchSemaphore(value: 0)
    var failure: String?

    NSWorkspace.shared.openApplication(at: app, configuration: configuration) { _, error in
        if let error { failure = error.localizedDescription }
        semaphore.signal()
    }

    if semaphore.wait(timeout: .now() + 10) == .timedOut {
        throw FolderRefusal.forwardFailed("the launch request timed out")
    }
    if let failure { throw FolderRefusal.forwardFailed(failure) }
}

// MARK: - The one open path

struct OpenOptions {
    var inputs: [String]
    var appOverride: String?
    var strategy: ForwardStrategy
    var pickFirst: Bool
    var dryRun: Bool
    var invocation: String
    /// Callback for the interactive multi-selection decision. Service mode asks
    /// the user; CLI mode answers from `pickFirst`.
    var chooseAmongMultiple: (([FolderTarget]) -> Int?)?
}

struct OpenOutcome {
    var receipt: Receipt
    var exitCode: Int32
}

func openFolder(_ options: OpenOptions) -> OpenOutcome {
    var notes: [String] = []
    var inputs = options.inputs

    if inputs.isEmpty {
        let refusal = FolderRefusal.emptyInvocation
        return refusalOutcome(refusal, options: options, notes: notes)
    }

    // Validate each selected item. A multi-selection is a deliberate decision,
    // never an implicit "open the first one".
    var targets: [FolderTarget] = []
    var seen = Set<String>()
    for input in inputs {
        do {
            let target = try validateFolder(input)
            notes.append(contentsOf: target.notes)
            if seen.insert(target.url.path).inserted {
                targets.append(target)
            } else {
                notes.append("duplicate: \(target.url.path) was selected twice")
            }
        } catch let refusal as FolderRefusal {
            return refusalOutcome(refusal, options: options, notes: notes)
        } catch {
            return refusalOutcome(
                .forwardFailed("unexpected validation error: \(error)"), options: options,
                notes: notes)
        }
    }

    if targets.count > 1 {
        var chosen: Int?
        if let choose = options.chooseAmongMultiple {
            chosen = choose(targets)
        } else if options.pickFirst {
            chosen = 0
        }
        guard let index = chosen, targets.indices.contains(index) else {
            return refusalOutcome(
                .multiSelection(count: targets.count, paths: targets.map { $0.url.path }),
                options: options, notes: notes)
        }
        notes.append("multi_selection: opened '\(targets[index].url.path)' by explicit choice")
        targets = [targets[index]]
        inputs = [targets[0].input]
    }

    let target = targets[0]
    var receipt = Receipt(
        ok: true,
        action: "open_folder",
        code: nil,
        reason: nil,
        invocation: options.invocation,
        inputs: inputs,
        resolved_path: target.url.path,
        device: nil,
        inode: nil,
        app_bundle_identifier: nil,
        app_path: nil,
        app_signature: nil,
        forwarded: false,
        strategy: nil,
        notes: notes,
        timestamp: timestamp()
    )

    // Filesystem identity (device, inode) proves the exact folder was forwarded
    // independently of path spelling or Unicode normalization.
    if let attributes = try? FileManager.default.attributesOfItem(atPath: target.url.path),
        let systemNumber = attributes[.systemNumber] as? NSNumber,
        let fileNumber = attributes[.systemFileNumber] as? NSNumber
    {
        receipt.device = systemNumber.int64Value
        receipt.inode = fileNumber.int64Value
    }

    let app: AppIdentity
    do {
        app = try locateApp(override: options.appOverride)
    } catch let refusal as FolderRefusal {
        receipt.ok = false
        receipt.action = "refuse"
        receipt.code = refusal.code
        receipt.reason = refusal.reason
        receipt.notes = notes
        return OpenOutcome(receipt: receipt, exitCode: 2)
    } catch {
        receipt.ok = false
        receipt.action = "refuse"
        receipt.code = "INTERNAL"
        receipt.reason = String(describing: error)
        return OpenOutcome(receipt: receipt, exitCode: 3)
    }
    receipt.app_bundle_identifier = app.bundleIdentifier
    receipt.app_path = app.url.path
    receipt.app_signature = app.signature
    receipt.notes.append(contentsOf: app.notes)
    receipt.strategy = options.strategy.rawValue

    if options.dryRun {
        receipt.notes.append("dry_run: validated only; nothing was forwarded")
        return OpenOutcome(receipt: receipt, exitCode: 0)
    }

    do {
        switch options.strategy {
        case .documents:
            try forwardWithDocuments(target.url, app: app.url)
        case .instance:
            try forwardWithInstance(target.url, app: app.url)
        }
    } catch let refusal as FolderRefusal {
        receipt.ok = false
        receipt.action = "refuse"
        receipt.code = refusal.code
        receipt.reason = refusal.reason
        return OpenOutcome(receipt: receipt, exitCode: 2)
    } catch {
        receipt.ok = false
        receipt.action = "refuse"
        receipt.code = "FORWARD_FAILED"
        receipt.reason = String(describing: error)
        return OpenOutcome(receipt: receipt, exitCode: 2)
    }

    receipt.forwarded = true
    return OpenOutcome(receipt: receipt, exitCode: 0)
}

func refusalOutcome(_ refusal: FolderRefusal, options: OpenOptions, notes: [String])
    -> OpenOutcome
{
    let receipt = Receipt(
        ok: false,
        action: "refuse",
        code: refusal.code,
        reason: refusal.reason,
        invocation: options.invocation,
        inputs: options.inputs,
        resolved_path: nil,
        device: nil,
        inode: nil,
        app_bundle_identifier: nil,
        app_path: nil,
        app_signature: nil,
        forwarded: false,
        strategy: nil,
        notes: notes,
        timestamp: timestamp()
    )
    return OpenOutcome(receipt: receipt, exitCode: 2)
}

// MARK: - User-visible refusal (service mode only)

/// A Service process must never be able to linger on an unanswered alert, so
/// every modal is bounded. Sixty seconds is long enough to read a refusal.
func boundedModalSeconds() -> Int {
    let configured = UserDefaults.standard.integer(forKey: "MonaServiceAlertSeconds")
    return configured >= 5 ? configured : 60
}

func presentRefusal(_ receipt: Receipt) {
    let alert = NSAlert()
    alert.alertStyle = .warning
    alert.messageText = "Mona could not open that folder"
    alert.informativeText = receipt.reason ?? "The selection was not a usable project folder."
    alert.addButton(withTitle: "OK")
    NSApp.activate(ignoringOtherApps: true)
    DispatchQueue.main.asyncAfter(deadline: .now() + .seconds(boundedModalSeconds())) {
        NSApp.abortModal()
    }
    alert.runModal()
}

func presentMultiSelectionChoice(_ targets: [FolderTarget]) -> Int? {
    let alert = NSAlert()
    alert.alertStyle = .informational
    alert.messageText = "Mona opens one project at a time"
    alert.informativeText =
        "\(targets.count) folders are selected. Open \(targets[0].url.lastPathComponent) and ignore the rest?"
    alert.addButton(withTitle: "Open “\(targets[0].url.lastPathComponent)”")
    alert.addButton(withTitle: "Cancel")
    NSApp.activate(ignoringOtherApps: true)
    DispatchQueue.main.asyncAfter(deadline: .now() + .seconds(boundedModalSeconds())) {
        NSApp.abortModal()
    }
    let response = alert.runModal()
    return response == .alertFirstButtonReturn ? 0 : nil
}

// MARK: - Service provider

final class ServiceProvider: NSObject {
    @objc func startProject(
        _ pboard: NSPasteboard,
        userData: String,
        error: AutoreleasingUnsafeMutablePointer<NSString>
    ) {
        let options: [NSPasteboard.ReadingOptionKey: Any] = [.urlReadingFileURLsOnly: true]
        let urls = (pboard.readObjects(forClasses: [NSURL.self], options: options) as? [URL]) ?? []
        let inputs = urls.map { $0.absoluteString }
        trace("message_received", ["count": inputs.count])

        let outcome = openFolder(
            OpenOptions(
                inputs: inputs,
                appOverride: ProcessInfo.processInfo.environment["MONA_APP_PATH"],
                strategy: ForwardStrategy.parse(
                    ProcessInfo.processInfo.environment["MONA_FORWARD_STRATEGY"]) ?? .documents,
                pickFirst: false,
                dryRun: false,
                invocation: "service",
                chooseAmongMultiple: { presentMultiSelectionChoice($0) }
            ))

        writeReceipt(outcome.receipt, to: ProcessInfo.processInfo.environment["MONA_RECEIPT_PATH"])
        trace("finished", ["ok": outcome.receipt.ok, "code": outcome.receipt.code ?? "ok"])
        if !outcome.receipt.ok {
            presentRefusal(outcome.receipt)
        }
        NSApp.terminate(nil)
    }
}

// MARK: - CLI mode

func describeService() -> Int32 {
    let bundle = Bundle.main
    let descriptor: [String: Any] = [
        "schema_version": kReceiptSchema,
        "service": kServiceMenuTitle,
        "message": kServiceMessage,
        "app_bundle_identifier": kAppBundleIdentifier,
        "send_file_types": ["public.folder"],
        "send_types": ["public.file-url"],
        "bundle_identifier": bundle.bundleIdentifier ?? "unbundled",
        "bundle_path": bundle.bundleURL.path,
        "executable": CommandLine.arguments.first ?? "",
    ]
    let data = try? JSONSerialization.data(
        withJSONObject: descriptor, options: [.prettyPrinted, .sortedKeys])
    FileHandle.standardOutput.write(data ?? Data())
    FileHandle.standardOutput.write(Data("\n".utf8))
    return 0
}

func runCli(_ arguments: [String]) -> Int32 {
    if arguments.contains("--describe") { return describeService() }

    var inputs: [String] = []
    var appOverride: String?
    var strategy: ForwardStrategy = .documents
    var pickFirst = false
    var dryRun = false
    var receiptPath: String?

    var index = 0
    while index < arguments.count {
        let argument = arguments[index]
        switch argument {
        case "--cli", "--":
            break
        case kOpenFolderArgument, "--folder", "--path":
            index += 1
            guard index < arguments.count else { return usage() }
            inputs.append(arguments[index])
        case "--app":
            index += 1
            guard index < arguments.count else { return usage() }
            appOverride = arguments[index]
        case "--strategy":
            index += 1
            guard index < arguments.count,
                let parsed = ForwardStrategy.parse(arguments[index])
            else { return usage() }
            strategy = parsed
        case "--pick-first":
            pickFirst = true
        case "--dry-run":
            dryRun = true
        case "--receipt":
            index += 1
            guard index < arguments.count else { return usage() }
            receiptPath = arguments[index]
        default:
            if argument.hasPrefix("--") {
                return usage()
            }
            inputs.append(argument)
        }
        index += 1
    }

    let outcome = openFolder(
        OpenOptions(
            inputs: inputs,
            appOverride: appOverride,
            strategy: strategy,
            pickFirst: pickFirst,
            dryRun: dryRun,
            invocation: "cli",
            chooseAmongMultiple: nil
        ))

    writeReceipt(outcome.receipt, to: receiptPath)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    if let data = try? encoder.encode(outcome.receipt) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    }
    return outcome.exitCode
}

func usage() -> Int32 {
    FileHandle.standardError.write(
        Data(
            """
            usage: MonaService [--cli] [--open-folder <path>]... [--app <path>] \\
                               [--strategy documents|instance] [--pick-first] \\
                               [--dry-run] [--receipt <path>] [--describe]
            Without arguments the binary runs as a macOS Service provider.
            """.utf8))
    return 64
}

// MARK: - Entry

let arguments = Array(CommandLine.arguments.dropFirst())
let isCli = arguments.contains("--cli") || arguments.contains("--describe")
    || arguments.contains("--dry-run") || arguments.contains("--receipt")
    || arguments.contains(kOpenFolderArgument)

if isCli {
    exit(runCli(arguments))
}

trace("launched", ["invocation": "service"])

// Service mode: AppKit must be running for the post office to deliver the
// service message to our provider object.
let application = NSApplication.shared
application.setActivationPolicy(.accessory)
let provider = ServiceProvider()
application.servicesProvider = provider
NSUpdateDynamicServices()
application.run()
trace("run_loop_exited")
