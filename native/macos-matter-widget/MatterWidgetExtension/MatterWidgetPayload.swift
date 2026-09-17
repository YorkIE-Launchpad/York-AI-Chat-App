import Foundation

struct MatterWidgetSignalRow: Codable {
    let id: String
    let title: String
    let summary: String
    let severity: String
}

struct MatterWidgetNextMeeting: Codable {
    let id: String
    let title: String
    let whenLine: String
    let relative: String
    let hasPrep: Bool
}

struct MatterWidgetPayload: Codable {
    let version: Int
    let updatedAt: TimeInterval
    let matterEnabled: Bool
    let focusScore: Int
    let criticalCount: Int
    let warningCount: Int
    let scanning: Bool
    let inScanWindow: Bool
    let briefKind: String
    let briefText: String
    let nextMeeting: MatterWidgetNextMeeting?
    let topSignals: [MatterWidgetSignalRow]

    static let placeholder = MatterWidgetPayload(
        version: 1,
        updatedAt: 0,
        matterEnabled: false,
        focusScore: 0,
        criticalCount: 0,
        warningCount: 0,
        scanning: false,
        inScanWindow: false,
        briefKind: "morning",
        briefText: "Open York GrowthOS to load Matter.",
        nextMeeting: nil,
        topSignals: []
    )
}
