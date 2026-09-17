import SwiftUI
import WidgetKit

enum MatterWidgetColors {
    static let accent = Color(red: 0, green: 0.706, blue: 0.541)

    static func severity(_ raw: String) -> Color {
        switch raw {
        case "critical": return Color(red: 0.94, green: 0.27, blue: 0.27)
        case "warning": return Color(red: 0.96, green: 0.62, blue: 0.04)
        case "healthy": return Color(red: 0.13, green: 0.77, blue: 0.37)
        default: return accent
        }
    }
}

struct MatterWidgetEntryView: View {
    @Environment(\.widgetFamily) private var family
    let entry: MatterWidgetEntry

    var body: some View {
        switch family {
        case .systemSmall:
            MatterWidgetSmallView(payload: entry.payload)
        case .systemMedium:
            MatterWidgetMediumView(payload: entry.payload)
        case .systemLarge:
            MatterWidgetLargeView(payload: entry.payload)
        default:
            MatterWidgetMediumView(payload: entry.payload)
        }
    }
}

struct MatterWidgetSmallView: View {
    let payload: MatterWidgetPayload

    var body: some View {
        Link(destination: URL(string: "yorkgrowthos://matter")!) {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text("Focus")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Text("\(payload.focusScore)")
                        .font(.title2.bold())
                        .foregroundStyle(MatterWidgetColors.accent)
                }
                HStack(spacing: 8) {
                    if payload.criticalCount > 0 {
                        badge("\(payload.criticalCount) critical", color: MatterWidgetColors.severity("critical"))
                    }
                    if payload.warningCount > 0 {
                        badge("\(payload.warningCount) warn", color: MatterWidgetColors.severity("warning"))
                    }
                }
                Text(payload.briefText)
                    .font(.caption)
                    .lineLimit(2)
                    .foregroundStyle(.primary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }

    private func badge(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.2))
            .foregroundStyle(color)
            .clipShape(Capsule())
    }
}

struct MatterWidgetMediumView: View {
    let payload: MatterWidgetPayload

    var body: some View {
        Link(destination: URL(string: "yorkgrowthos://matter")!) {
            VStack(alignment: .leading, spacing: 8) {
                Text(briefTitle(payload.briefKind))
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(MatterWidgetColors.accent)
                Text(payload.briefText)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(2)
                if let meeting = payload.nextMeeting {
                    Divider()
                    HStack(alignment: .top, spacing: 8) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(meeting.title)
                                .font(.caption.weight(.semibold))
                                .lineLimit(1)
                            if !meeting.whenLine.isEmpty {
                                Text(meeting.whenLine)
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                        }
                        Spacer(minLength: 4)
                        Text(meeting.relative)
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(MatterWidgetColors.accent)
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }

    private func briefTitle(_ kind: String) -> String {
        switch kind {
        case "morning": return "Morning brief"
        case "afternoon": return "Afternoon brief"
        case "evening": return "Evening brief"
        default: return "Matter"
        }
    }
}

struct MatterWidgetLargeView: View {
    let payload: MatterWidgetPayload

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Link(destination: URL(string: "yorkgrowthos://matter")!) {
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text("Matter")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(MatterWidgetColors.accent)
                        Spacer()
                        Text("Focus \(payload.focusScore)")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    Text(payload.briefText)
                        .font(.subheadline.weight(.medium))
                        .lineLimit(3)
                }
            }

            if let meeting = payload.nextMeeting {
                Link(destination: URL(string: "yorkgrowthos://matter/meeting?id=\(meeting.id.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? meeting.id)")!) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Next up")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.secondary)
                        HStack {
                            Text(meeting.title)
                                .font(.caption.weight(.semibold))
                                .lineLimit(1)
                            Spacer()
                            Text(meeting.relative)
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(MatterWidgetColors.accent)
                        }
                        if meeting.hasPrep {
                            Text("Prep ready")
                                .font(.caption2)
                                .foregroundStyle(MatterWidgetColors.accent)
                        }
                    }
                    .padding(8)
                    .background(Color.primary.opacity(0.06))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                }
            }

            if !payload.topSignals.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Signals")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                    ForEach(payload.topSignals.prefix(3), id: \.id) { signal in
                        Link(destination: URL(string: "yorkgrowthos://matter/item?id=\(signal.id.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? signal.id)")!) {
                            HStack(alignment: .top, spacing: 6) {
                                Circle()
                                    .fill(MatterWidgetColors.severity(signal.severity))
                                    .frame(width: 6, height: 6)
                                    .padding(.top, 4)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(signal.title)
                                        .font(.caption.weight(.semibold))
                                        .lineLimit(1)
                                    if !signal.summary.isEmpty {
                                        Text(signal.summary)
                                            .font(.caption2)
                                            .foregroundStyle(.secondary)
                                            .lineLimit(1)
                                    }
                                }
                            }
                        }
                    }
                }
            }

            Text(updatedLabel(payload.updatedAt))
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func updatedLabel(_ ms: TimeInterval) -> String {
        guard ms > 0 else { return "Not synced yet" }
        let date = Date(timeIntervalSince1970: ms / 1000)
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return "Updated \(formatter.localizedString(for: date, relativeTo: Date()))"
    }
}
