import Foundation

enum MatterWidgetDataStore {
    static let prodGroup = "group.ie.york.app"
    static let devGroup = "group.ie.york.vecos.dev"
    static let fileName = "matter-widget.json"

    static func load() -> MatterWidgetPayload {
        for group in [prodGroup, devGroup] {
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
