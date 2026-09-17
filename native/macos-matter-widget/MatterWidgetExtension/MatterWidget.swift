import SwiftUI
import WidgetKit

@main
struct MatterWidgetBundle: WidgetBundle {
    var body: some Widget {
        MatterWidget()
    }
}

struct MatterWidget: Widget {
    let kind: String = "MatterWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: MatterWidgetProvider()) { entry in
            MatterWidgetEntryView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Matter")
        .description("Briefing, next meeting, and top signals from York GrowthOS.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}
