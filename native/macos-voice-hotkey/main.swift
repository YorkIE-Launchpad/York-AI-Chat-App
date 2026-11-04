import ApplicationServices
import Carbon.HIToolbox
import CoreGraphics
import Foundation

/// System-wide hold/release watcher for one accelerator.
/// stdout: newline JSON { "type": "ready" | "down" | "up" | "error", "message"?: string }
/// Requires Accessibility (CGEventTap).

struct HotkeyEvent: Encodable {
  let type: String
  let message: String?
}

func emit(_ type: String, message: String? = nil) {
  var object: [String: String] = ["type": type]
  if let message { object["message"] = message }
  guard let data = try? JSONSerialization.data(withJSONObject: object),
        let line = String(data: data, encoding: .utf8)
  else { return }
  fputs(line + "\n", stdout)
  fflush(stdout)
}

func parseMods(_ raw: String) -> CGEventFlags {
  var flags: CGEventFlags = []
  for part in raw.lowercased().split(separator: ",") {
    switch part.trimmingCharacters(in: .whitespaces) {
    case "control", "ctrl": flags.insert(.maskControl)
    case "option", "alt": flags.insert(.maskAlternate)
    case "shift": flags.insert(.maskShift)
    case "command", "cmd", "meta": flags.insert(.maskCommand)
    default: break
    }
  }
  return flags
}

func keyCode(for name: String) -> CGKeyCode? {
  let key = name.lowercased()
  let letterMap: [Character: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
    "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29,
    "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46,
  ]
  if key.count == 1, let ch = key.first, let code = letterMap[ch] { return code }
  switch key {
  case "space": return 49
  case "return", "enter": return 36
  case "tab": return 48
  case "escape", "esc": return 53
  default: return nil
  }
}

func parseAccelerator(_ raw: String) -> (flags: CGEventFlags, key: CGKeyCode)? {
  let parts = raw.split(separator: "+").map { $0.trimmingCharacters(in: .whitespaces) }
  guard parts.count >= 2 else { return nil }
  let keyName = String(parts.last!)
  let modNames = parts.dropLast().joined(separator: ",")
  let flags = parseMods(modNames)
  guard !flags.isEmpty, let code = keyCode(for: keyName) else { return nil }
  return (flags, code)
}

func requiredFlagsMatch(_ eventFlags: CGEventFlags, required: CGEventFlags) -> Bool {
  let interesting: CGEventFlags = [.maskControl, .maskAlternate, .maskShift, .maskCommand]
  return eventFlags.intersection(interesting) == required
}

var acceleratorArg = ""
var index = 1
let args = CommandLine.arguments
while index < args.count {
  if args[index] == "--accelerator", index + 1 < args.count {
    acceleratorArg = args[index + 1]
    index += 2
  } else {
    index += 1
  }
}

guard let target = parseAccelerator(acceleratorArg) else {
  emit("error", message: "Invalid accelerator. Use --accelerator Control+Shift+D")
  exit(1)
}

let trusted = AXIsProcessTrustedWithOptions(
  [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
)
if !trusted {
  emit("error", message: "Accessibility permission is required for the hold shortcut.")
  exit(2)
}

final class WatchState {
  let flags: CGEventFlags
  let key: CGKeyCode
  var holding = false
  var tap: CFMachPort?

  init(flags: CGEventFlags, key: CGKeyCode) {
    self.flags = flags
    self.key = key
  }

  func handle(type: CGEventType, event: CGEvent) {
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
      if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
      return
    }

    let code = CGKeyCode(event.getIntegerValueField(.keyboardEventKeycode))
    let eventFlags = event.flags

    if type == .keyDown, code == key, requiredFlagsMatch(eventFlags, required: flags) {
      if !holding {
        holding = true
        emit("down")
      }
      return
    }

    if holding {
      if type == .keyUp, code == key {
        holding = false
        emit("up")
        return
      }
      if type == .flagsChanged, !requiredFlagsMatch(eventFlags, required: flags) {
        holding = false
        emit("up")
      }
    }
  }
}

let state = WatchState(flags: target.flags, key: target.key)
let mask =
  (1 << CGEventType.keyDown.rawValue)
  | (1 << CGEventType.keyUp.rawValue)
  | (1 << CGEventType.flagsChanged.rawValue)

guard
  let tap = CGEvent.tapCreate(
    tap: .cgSessionEventTap,
    place: .headInsertEventTap,
    options: .listenOnly,
    eventsOfInterest: CGEventMask(mask),
    callback: { _, type, event, refcon -> Unmanaged<CGEvent>? in
      guard let refcon else { return Unmanaged.passUnretained(event) }
      let watch = Unmanaged<WatchState>.fromOpaque(refcon).takeUnretainedValue()
      watch.handle(type: type, event: event)
      return Unmanaged.passUnretained(event)
    },
    userInfo: Unmanaged.passUnretained(state).toOpaque()
  )
else {
  emit("error", message: "Could not create key event tap.")
  exit(3)
}

state.tap = tap
let runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)
emit("ready")
CFRunLoopRun()
