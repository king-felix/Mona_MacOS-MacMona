// P09 test support: a minimal receiver app with Mona's bundle identifier.
//
// It exists only so the native smoke test can prove that the registered Service
// is discovered by macOS, that it validates a selected folder, and that it
// forwards the exact folder to the app identified by bundle identity. It writes
// one JSON receipt and exits.
import AppKit
import Foundation

let receiptPath = NSString(
    string: "~/Library/Application Support/Mona/services/probe-received.json"
).expandingTildeInPath

func writeReceipt(_ payload: [String: Any]) {
    var value = payload
    value["schema_version"] = 1
    value["pid"] = ProcessInfo.processInfo.processIdentifier
    value["timestamp"] = ISO8601DateFormatter().string(from: Date())
    do {
        let url = URL(fileURLWithPath: receiptPath)
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        let data = try JSONSerialization.data(
            withJSONObject: value, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: url, options: .atomic)
    } catch {
        FileHandle.standardError.write(Data("probe: receipt write failed: \(error)\n".utf8))
    }
}

final class ProbeDelegate: NSObject, NSApplicationDelegate {
    private var received = false
    private var startup = Date()

    func application(_ application: NSApplication, open urls: [URL]) {
        received = true
        writeReceipt([
            "event": "open_urls",
            "urls": urls.map { $0.absoluteString },
            "paths": urls.map { $0.path },
            "delivered_after_ms": Int(Date().timeIntervalSince(startup) * 1000),
        ])
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { NSApp.terminate(nil) }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        startup = Date()
        // If no open event arrives, record that fact rather than hanging.
        DispatchQueue.main.asyncAfter(deadline: .now() + 6) {
            if !self.received {
                writeReceipt(["event": "none", "urls": [], "paths": []])
                NSApp.terminate(nil)
            }
        }
    }
}

let app = NSApplication.shared
let delegate = ProbeDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
