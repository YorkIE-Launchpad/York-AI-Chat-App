import WidgetKit

let kind = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "MatterWidget"
WidgetCenter.shared.reloadTimelines(ofKind: kind)
