// P09 test support: performs the registered Service the way macOS does.
//
// The harness puts the same pasteboard types Finder puts down (file URLs) and
// asks the system to perform the service by its advertised menu title. That
// makes registration, eligibility, and delivery observable, instead of running
// the helper binary from a terminal and calling that integration.
//
// usage: P09Harness --mode url|empty|multi|text --path <folder> [<folder>...]
//                   --service <menu title> --receipt <path>
import AppKit
import Foundation

func argument(_ name: String) -> String? {
    let arguments = CommandLine.arguments
    guard let index = arguments.firstIndex(of: name), index + 1 < arguments.count else {
        return nil
    }
    return arguments[index + 1]
}

func argumentList(_ name: String) -> [String] {
    let arguments = CommandLine.arguments
    var values: [String] = []
    var index = 0
    while index < arguments.count {
        if arguments[index] == name, index + 1 < arguments.count {
            values.append(arguments[index + 1])
            index += 1
        }
        index += 1
    }
    return values
}

let mode = argument("--mode") ?? "url"
let serviceTitle = argument("--service") ?? "Start new DS project with Mona"
let receiptPath = argument("--receipt")
let paths = argumentList("--path")

func writeReceipt(_ payload: [String: Any]) {
    var value = payload
    value["schema_version"] = 1
    value["service"] = serviceTitle
    value["mode"] = mode
    value["paths"] = paths
    value["timestamp"] = ISO8601DateFormatter().string(from: Date())
    guard let receiptPath else { return }
    do {
        let data = try JSONSerialization.data(
            withJSONObject: value, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: URL(fileURLWithPath: receiptPath), options: .atomic)
    } catch {
        FileHandle.standardError.write(Data("harness: receipt write failed: \(error)\n".utf8))
    }
}

NSApplication.shared.setActivationPolicy(.accessory)

// Ask the system to re-read the Services directories before performing, the
// same refresh a user gets when a service is installed or toggled.
NSUpdateDynamicServices()
Thread.sleep(forTimeInterval: 0.4)

let pasteboard = NSPasteboard.general
pasteboard.clearContents()

switch mode {
case "empty":
    break
case "text":
    pasteboard.setString(paths.first ?? "", forType: .string)
default:
    let objects = paths.map { URL(fileURLWithPath: $0) as NSURL }
    pasteboard.writeObjects(objects)
}

let performed = NSPerformService(serviceTitle, pasteboard)
writeReceipt([
    "performed": performed,
    "pasteboard_types": pasteboard.types?.map { $0.rawValue } ?? [],
])
print(performed ? "performed" : "not-performed")
exit(performed ? 0 : 3)
