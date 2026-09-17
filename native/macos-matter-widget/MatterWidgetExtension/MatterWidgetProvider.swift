import WidgetKit

struct MatterWidgetEntry: TimelineEntry {
    let date: Date
    let payload: MatterWidgetPayload
}

struct MatterWidgetProvider: TimelineProvider {
    func placeholder(in context: Context) -> MatterWidgetEntry {
        MatterWidgetEntry(date: Date(), payload: .placeholder)
    }

    func getSnapshot(in context: Context, completion: @escaping (MatterWidgetEntry) -> Void) {
        completion(MatterWidgetEntry(date: Date(), payload: MatterWidgetDataStore.load()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<MatterWidgetEntry>) -> Void) {
        let payload = MatterWidgetDataStore.load()
        let entry = MatterWidgetEntry(date: Date(), payload: payload)
        let next = Calendar.current.date(byAdding: .minute, value: 15, to: Date()) ?? Date().addingTimeInterval(900)
        completion(Timeline(entries: [entry], policy: .after(next)))
    }
}
