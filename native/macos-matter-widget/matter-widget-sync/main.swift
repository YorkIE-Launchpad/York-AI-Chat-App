import Foundation
import WidgetKit

/// Sandboxed App Group writer for Matter WidgetKit.
/// Electron (non-sandboxed) gets EPERM on ~/Library/Group Containers even with
/// application-groups entitlements — this helper uses FileManager container URLs.
///
/// Usage: pipe JSON payload on stdin.
///   matter-widget-sync [WidgetKind]

let appleTeamId = "7G87G26WW6"
let prodGroup = "group.ie.york.app"
let devGroup = "group.ie.york.vecos.dev"
let fileName = "matter-widget.json"
let groupIdentifiers = [
    "\(appleTeamId).\(prodGroup)",
    "\(appleTeamId).\(devGroup)",
    prodGroup,
    devGroup,
]

let kind = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "MatterWidget"
let data = FileHandle.standardInput.readDataToEndOfFile()
guard !data.isEmpty else {
    fputs("matter-widget-sync: empty stdin\n", stderr)
    exit(2)
}

var wrote = 0
var lastError: String?
for group in groupIdentifiers {
    guard let base = FileManager.default.containerURL(
        forSecurityApplicationGroupIdentifier: group
    ) else {
        continue
    }
    let url = base.appendingPathComponent(fileName)
    do {
        try data.write(to: url, options: .atomic)
        wrote += 1
        // Team-ID-prefixed groups are authoritative on macOS 26+; skip legacy once one succeeds.
        if group.hasPrefix(appleTeamId) {
            break
        }
    } catch {
        lastError = "\(group): \(error.localizedDescription)"
    }
}

WidgetCenter.shared.reloadTimelines(ofKind: kind)

if wrote == 0 {
    fputs(
        "matter-widget-sync: failed to write any App Group (\(lastError ?? "no container URL"))\n",
        stderr
    )
    exit(1)
}

exit(0)
