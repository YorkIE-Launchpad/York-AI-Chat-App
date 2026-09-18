import Foundation

enum MatterWidgetDataStore {
    static let appleTeamId = "7G87G26WW6"
    static let prodGroup = "group.ie.york.app"
    static let devGroup = "group.ie.york.vecos.dev"
    static let fileName = "matter-widget.json"

    /// Prefer Team-ID-prefixed groups (required on macOS 26+ for sandboxed extensions).
    static var groupIdentifiers: [String] {
        [
            "\(appleTeamId).\(prodGroup)",
            "\(appleTeamId).\(devGroup)",
            prodGroup,
            devGroup,
        ]
    }

    static func load() -> MatterWidgetPayload {
        for group in groupIdentifiers {
            guard let base = FileManager.default.containerURL(
                forSecurityApplicationGroupIdentifier: group
            ) else { continue }
            let url = base.appendingPathComponent(fileName)
            guard let data = try? Data(contentsOf: url) else { continue }
            if let decoded = try? JSONDecoder().decode(MatterWidgetPayload.self, from: data) {
                return decoded
            }
        }
        return .placeholder
    }
}
