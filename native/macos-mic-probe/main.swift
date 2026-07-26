import AppKit
import CoreAudio
import Foundation

struct MicProcess: Codable {
  let pid: Int32
  let bundleId: String?
  let name: String?
  let path: String?
}

struct ProbeResult: Codable {
  let active: Bool
  let mode: String
  let processes: [MicProcess]
  let deviceRunningSomewhere: Bool
}

enum ProbeError: Error {
  case status(OSStatus, String)
}

func makeAddress(
  selector: AudioObjectPropertySelector,
  scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal
) -> AudioObjectPropertyAddress {
  AudioObjectPropertyAddress(
    mSelector: selector,
    mScope: scope,
    mElement: kAudioObjectPropertyElementMain
  )
}

func getScalarProperty<T>(
  objectID: AudioObjectID,
  selector: AudioObjectPropertySelector,
  scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal
) throws -> T {
  var address = makeAddress(selector: selector, scope: scope)
  let value = UnsafeMutablePointer<T>.allocate(capacity: 1)
  defer { value.deallocate() }
  var size = UInt32(MemoryLayout<T>.size)
  let status = AudioObjectGetPropertyData(objectID, &address, 0, nil, &size, value)
  guard status == noErr else {
    throw ProbeError.status(status, "scalar \(selector)")
  }
  return value.move()
}

func getArrayProperty<T>(
  objectID: AudioObjectID,
  selector: AudioObjectPropertySelector,
  scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal
) throws -> [T] {
  var address = makeAddress(selector: selector, scope: scope)
  var size: UInt32 = 0
  let sizeStatus = AudioObjectGetPropertyDataSize(objectID, &address, 0, nil, &size)
  guard sizeStatus == noErr else {
    throw ProbeError.status(sizeStatus, "size \(selector)")
  }
  guard size > 0 else { return [] }

  let count = Int(size) / MemoryLayout<T>.stride
  var values = Array<T>(unsafeUninitializedCapacity: count) { buffer, initializedCount in
    initializedCount = count
  }
  var mutableSize = size
  let dataStatus = values.withUnsafeMutableBytes { rawBuffer -> OSStatus in
    guard let baseAddress = rawBuffer.baseAddress else {
      return kAudioHardwareUnspecifiedError
    }
    return AudioObjectGetPropertyData(objectID, &address, 0, nil, &mutableSize, baseAddress)
  }
  guard dataStatus == noErr else {
    throw ProbeError.status(dataStatus, "data \(selector)")
  }
  return values
}

func anyInputDeviceRunningSomewhere() -> Bool {
  do {
    let deviceIDs: [AudioObjectID] = try getArrayProperty(
      objectID: AudioObjectID(kAudioObjectSystemObject),
      selector: kAudioHardwarePropertyDevices
    )
    for deviceID in deviceIDs {
      // Only consider devices with input channels.
      var address = makeAddress(
        selector: kAudioDevicePropertyStreamConfiguration,
        scope: kAudioObjectPropertyScopeInput
      )
      var cfgSize: UInt32 = 0
      guard AudioObjectGetPropertyDataSize(deviceID, &address, 0, nil, &cfgSize) == noErr,
            cfgSize > 0
      else {
        continue
      }
      let raw = UnsafeMutableRawPointer.allocate(
        byteCount: Int(cfgSize),
        alignment: MemoryLayout<AudioBufferList>.alignment
      )
      defer { raw.deallocate() }
      var mutableCfgSize = cfgSize
      guard AudioObjectGetPropertyData(deviceID, &address, 0, nil, &mutableCfgSize, raw) == noErr
      else {
        continue
      }
      let channels = UnsafeMutableAudioBufferListPointer(
        raw.assumingMemoryBound(to: AudioBufferList.self)
      ).reduce(0) { $0 + Int($1.mNumberChannels) }
      guard channels > 0 else { continue }

      let running: UInt32 = (try? getScalarProperty(
        objectID: deviceID,
        selector: kAudioDevicePropertyDeviceIsRunningSomewhere
      )) ?? 0
      if running != 0 {
        return true
      }
    }
  } catch {
    return false
  }
  return false
}

func resolveProcess(pid: pid_t) -> MicProcess {
  if let app = NSRunningApplication(processIdentifier: pid) {
    return MicProcess(
      pid: pid,
      bundleId: app.bundleIdentifier,
      name: app.localizedName,
      path: app.bundleURL?.path
    )
  }
  return MicProcess(pid: pid, bundleId: nil, name: nil, path: nil)
}

func probeFromProcessObjects() throws -> ProbeResult {
  let processObjectIDs: [AudioObjectID] = try getArrayProperty(
    objectID: AudioObjectID(kAudioObjectSystemObject),
    selector: kAudioHardwarePropertyProcessObjectList
  )

  var processes: [MicProcess] = []
  for processObjectID in processObjectIDs {
    let isRunningInput: UInt32 = (try? getScalarProperty(
      objectID: processObjectID,
      selector: kAudioProcessPropertyIsRunningInput
    )) ?? 0
    guard isRunningInput != 0 else { continue }

    let pidValue: pid_t = try getScalarProperty(
      objectID: processObjectID,
      selector: kAudioProcessPropertyPID
    )
    guard pidValue > 0 else { continue }
    processes.append(resolveProcess(pid: pidValue))
  }

  let deviceRunning = anyInputDeviceRunningSomewhere()
  return ProbeResult(
    active: !processes.isEmpty,
    mode: "process",
    processes: processes,
    deviceRunningSomewhere: deviceRunning
  )
}

func probeFallbackDeviceOnly() -> ProbeResult {
  let deviceRunning = anyInputDeviceRunningSomewhere()
  return ProbeResult(
    active: deviceRunning,
    mode: "device",
    processes: [],
    deviceRunningSomewhere: deviceRunning
  )
}

func main() {
  let result: ProbeResult
  do {
    result = try probeFromProcessObjects()
  } catch {
    result = probeFallbackDeviceOnly()
  }

  let encoder = JSONEncoder()
  encoder.outputFormatting = [.sortedKeys]
  do {
    let data = try encoder.encode(result)
    if let json = String(data: data, encoding: .utf8) {
      print(json)
    } else {
      print("{\"active\":false,\"mode\":\"error\",\"processes\":[],\"deviceRunningSomewhere\":false}")
      exit(1)
    }
  } catch {
    fputs("encode failed: \(error)\n", stderr)
    exit(1)
  }
}

main()
