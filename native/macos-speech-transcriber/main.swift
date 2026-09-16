import AppKit
import AVFoundation
import Darwin
import Foundation
import Speech

func applyAccessoryActivationPolicy() {
  let app = NSApplication.shared
  if app.activationPolicy() != .accessory {
    app.setActivationPolicy(.accessory)
  }
}

private var ioInput = FileHandle.standardInput
private var ioOutput = FileHandle.standardOutput
/// When set, PCM/control reads use blocking `recv` (FileHandle can EOF early on sockets).
private var socketFd: Int32? = nil

func connectUnixStreamSocket(at path: String) throws -> FileHandle {
  let fd = socket(AF_UNIX, SOCK_STREAM, 0)
  guard fd >= 0 else {
    throw NSError(domain: "MeetingSpeech", code: 30, userInfo: [NSLocalizedDescriptionKey: "socket() failed"])
  }
  var addr = sockaddr_un()
  addr.sun_family = sa_family_t(AF_UNIX)
  let maxPath = MemoryLayout.size(ofValue: addr.sun_path) - 1
  guard path.utf8.count < maxPath else {
    close(fd)
    throw NSError(domain: "MeetingSpeech", code: 31, userInfo: [NSLocalizedDescriptionKey: "Socket path too long"])
  }
  _ = path.withCString { cstr in
    strncpy(&addr.sun_path.0, cstr, maxPath)
  }
  let addrLen = socklen_t(MemoryLayout<sockaddr_un>.size)
  let connectResult = withUnsafePointer(to: &addr) { ptr in
    ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPtr in
      connect(fd, sockaddrPtr, addrLen)
    }
  }
  guard connectResult == 0 else {
    close(fd)
    throw NSError(
      domain: "MeetingSpeech",
      code: 32,
      userInfo: [NSLocalizedDescriptionKey: "connect() to \(path) failed: \(errno)"]
    )
  }
  return FileHandle(fileDescriptor: fd, closeOnDealloc: true)
}

func configureIoTransport(socketPath: String?) throws {
  guard let socketPath, !socketPath.isEmpty else {
    socketFd = nil
    ioInput = FileHandle.standardInput
    ioOutput = FileHandle.standardOutput
    return
  }
  let handle = try connectUnixStreamSocket(at: socketPath)
  let fd = handle.fileDescriptor
  let flags = fcntl(fd, F_GETFL)
  if flags >= 0 {
    _ = fcntl(fd, F_SETFL, flags & ~O_NONBLOCK)
  }
  socketFd = fd
  ioInput = handle
  ioOutput = handle
}

struct JsonEvent: Encodable {
  let type: String
  let itemId: String?
  let text: String?
  let message: String?
}

func emit(_ event: JsonEvent) {
  guard let data = try? JSONEncoder().encode(event),
        let line = String(data: data, encoding: .utf8)
  else {
    return
  }
  ioOutput.write((line + "\n").data(using: .utf8)!)
}

func emitError(_ message: String) {
  emit(JsonEvent(type: "error", itemId: nil, text: nil, message: message))
}

@available(macOS 26.0, *)
func ensureSpeechAuthorized() async throws {
  let current = SFSpeechRecognizer.authorizationStatus()
  if current == .authorized {
    return
  }
  if current == .denied || current == .restricted {
    throw NSError(
      domain: "MeetingSpeech",
      code: 20,
      userInfo: [
        NSLocalizedDescriptionKey:
          "Speech recognition is off for York GrowthOS. In System Settings → Privacy & Security → Speech Recognition, turn on York GrowthOS (the speech helper), then try again.",
      ]
    )
  }
  let resolved = await withCheckedContinuation { (cont: CheckedContinuation<SFSpeechRecognizerAuthorizationStatus, Never>) in
    DispatchQueue.main.async {
      SFSpeechRecognizer.requestAuthorization { status in
        cont.resume(returning: status)
      }
    }
  }
  guard resolved == .authorized else {
    throw NSError(
      domain: "MeetingSpeech",
      code: 21,
      userInfo: [
        NSLocalizedDescriptionKey:
          "Speech recognition permission was not granted.",
      ]
    )
  }
}

func readExact(_ handle: FileHandle, count: Int) -> Data? {
  var remaining = count
  var data = Data()
  while remaining > 0 {
    let chunk = handle.readData(ofLength: remaining)
    if chunk.isEmpty {
      return data.isEmpty ? nil : data
    }
    data.append(chunk)
    remaining -= chunk.count
  }
  return data
}

func readExactBlockingSocket(fd: Int32, count: Int) -> Data? {
  var remaining = count
  var data = Data()
  while remaining > 0 {
    let chunkSize = min(remaining, 65_536)
    var buffer = [UInt8](repeating: 0, count: chunkSize)
    let readCount: ssize_t = buffer.withUnsafeMutableBytes { raw in
      guard let base = raw.baseAddress else { return ssize_t(-1) }
      return recv(fd, base, chunkSize, 0)
    }
    if readCount < 0 {
      return data.isEmpty ? nil : data
    }
    if readCount == 0 {
      return data.isEmpty ? nil : data
    }
    data.append(buffer, count: Int(readCount))
    remaining -= Int(readCount)
  }
  return data
}

func readExactFromIo(count: Int) -> Data? {
  if let fd = socketFd {
    return readExactBlockingSocket(fd: fd, count: count)
  }
  return readExact(ioInput, count: count)
}

/// Converts incoming PCM16 buffers to the analyzer format (macOS 26 — no AnalyzerInputConverter).
@available(macOS 26.0, *)
final class AnalyzerPcmAdapter {
  private let analyzerFormat: AVAudioFormat
  private let sourceFormat: AVAudioFormat
  private let converter: AVAudioConverter

  init(analyzerFormat: AVAudioFormat, sourceFormat: AVAudioFormat) throws {
    self.analyzerFormat = analyzerFormat
    self.sourceFormat = sourceFormat
    guard let converter = AVAudioConverter(from: sourceFormat, to: analyzerFormat) else {
      throw NSError(
        domain: "MeetingSpeech",
        code: 3,
        userInfo: [NSLocalizedDescriptionKey: "Failed to create AVAudioConverter"]
      )
    }
    self.converter = converter
  }

  func convert(_ source: AVAudioPCMBuffer) throws -> [AnalyzerInput] {
    let ratio = analyzerFormat.sampleRate / sourceFormat.sampleRate
    let capacity = AVAudioFrameCount(Double(source.frameLength) * ratio) + 32
    guard let output = AVAudioPCMBuffer(pcmFormat: analyzerFormat, frameCapacity: capacity) else {
      return []
    }

    var supplied = false
    var error: NSError?
    let status = converter.convert(to: output, error: &error) { _, outStatus in
      if supplied {
        outStatus.pointee = .noDataNow
        return nil
      }
      supplied = true
      outStatus.pointee = .haveData
      return source
    }

    if status == .error {
      throw error ?? NSError(domain: "MeetingSpeech", code: 4, userInfo: nil)
    }
    guard output.frameLength > 0 else {
      return []
    }
    return [AnalyzerInput(buffer: output)]
  }

}

@available(macOS 26.0, *)
func installTranscriberAssets(for transcriber: SpeechTranscriber, locale: Locale) async throws {
  _ = try await AssetInventory.reserve(locale: locale)
  if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
    try await request.downloadAndInstall()
  }
}

@available(macOS 26.0, *)
final class TranscriptionSession {
  private let transcriber: SpeechTranscriber
  private let analyzer: SpeechAnalyzer
  private let inputBuilder: AsyncStream<AnalyzerInput>.Continuation
  private let pcmAdapter: AnalyzerPcmAdapter
  private let pcmFormat: AVAudioFormat
  private var resultsTask: Task<Void, Never>?
  private var segmentIndex = 0
  private var currentItemId = ""
  private var pendingPcm = Data()
  private let pcmChunkBytes = 6_400 // 200 ms @ 16 kHz mono PCM16
  init() async throws {
    guard SpeechTranscriber.isAvailable else {
      throw NSError(
        domain: "MeetingSpeech",
        code: 10,
        userInfo: [NSLocalizedDescriptionKey: "SpeechTranscriber is not available on this device"]
      )
    }

    let requested = Locale(identifier: "en-US")
    guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: requested) else {
      throw NSError(
        domain: "MeetingSpeech",
        code: 11,
        userInfo: [NSLocalizedDescriptionKey: "en-US speech locale is not supported"]
      )
    }

    transcriber = SpeechTranscriber(
      locale: locale,
      transcriptionOptions: [],
      reportingOptions: [.volatileResults],
      attributeOptions: []
    )

    try await installTranscriberAssets(for: transcriber, locale: locale)

    let audioFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber])
    guard let audioFormat else {
      throw NSError(
        domain: "MeetingSpeech",
        code: 1,
        userInfo: [NSLocalizedDescriptionKey: "No compatible audio format"]
      )
    }

    guard let pcm = AVAudioFormat(
      commonFormat: .pcmFormatInt16,
      sampleRate: 16_000,
      channels: 1,
      interleaved: false
    ) else {
      throw NSError(
        domain: "MeetingSpeech",
        code: 2,
        userInfo: [NSLocalizedDescriptionKey: "Failed to create PCM format"]
      )
    }
    pcmFormat = pcm
    pcmAdapter = try AnalyzerPcmAdapter(analyzerFormat: audioFormat, sourceFormat: pcm)

    let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
    inputBuilder = continuation
    analyzer = SpeechAnalyzer(modules: [transcriber])
    try await analyzer.start(inputSequence: stream)

    resultsTask = Task {
      do {
        for try await result in transcriber.results {
          let piece = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
          if piece.isEmpty { continue }
          if result.isFinal {
            let itemId = currentItemId.isEmpty ? "seg-\(segmentIndex)" : currentItemId
            emit(JsonEvent(type: "final", itemId: itemId, text: piece, message: nil))
            segmentIndex += 1
            currentItemId = ""
          } else {
            if currentItemId.isEmpty {
              currentItemId = "seg-\(segmentIndex)-partial"
            }
            emit(JsonEvent(type: "partial", itemId: currentItemId, text: piece, message: nil))
          }
        }
      } catch {
        emitError("Results stream failed: \(error.localizedDescription)")
      }
    }
  }

  func ingestPcm16(_ data: Data) throws {
    pendingPcm.append(data)
    while pendingPcm.count >= pcmChunkBytes {
      let chunk = Data(pendingPcm.prefix(pcmChunkBytes))
      let produced = try ingestPcmChunk(chunk)
      if produced == 0 {
        break
      }
      pendingPcm.removeFirst(pcmChunkBytes)
    }
  }

  @discardableResult
  private func ingestPcmChunk(_ data: Data) throws -> Int {
    let frameCount = UInt32(data.count / 2)
    guard frameCount > 0 else { return 0 }
    guard let buffer = AVAudioPCMBuffer(pcmFormat: pcmFormat, frameCapacity: frameCount) else {
      return 0
    }
    buffer.frameLength = frameCount
    data.withUnsafeBytes { raw in
      guard let base = raw.baseAddress else { return }
      memcpy(buffer.int16ChannelData![0], base, data.count)
    }
    let inputs = try pcmAdapter.convert(buffer)
    if inputs.isEmpty {
      return 0
    }
    for input in inputs {
      inputBuilder.yield(input)
    }
    return inputs.count
  }

  func finish() async throws {
    inputBuilder.finish()
    try await analyzer.finalizeAndFinishThroughEndOfInput()
    resultsTask?.cancel()
  }
}

@available(macOS 26.0, *)
func runAuthorizeOnly() async {
  do {
    try await ensureSpeechAuthorized()
    emit(JsonEvent(type: "ready", itemId: nil, text: nil, message: nil))
    exit(0)
  } catch {
    emitError(error.localizedDescription)
    exit(1)
  }
}

@available(macOS 26.0, *)
func runTranscriptionLoop() async {
  let session: TranscriptionSession
  do {
    try await ensureSpeechAuthorized()
    session = try await TranscriptionSession()
  } catch {
    emitError(error.localizedDescription)
    return
  }
  emit(JsonEvent(type: "ready", itemId: nil, text: nil, message: nil))

  while true {
    guard let lengthData = readExactFromIo(count: 4) else {
      try? await session.finish()
      return
    }
    let length = lengthData.withUnsafeBytes { $0.load(as: UInt32.self) }
    if length == 0 { continue }
    if length > 4_000_000 {
      emitError("Frame too large")
      return
    }
    guard let pcm = readExactFromIo(count: Int(length)) else {
      try? await session.finish()
      return
    }

    do {
      try session.ingestPcm16(pcm)
    } catch {
      emitError(error.localizedDescription)
      return
    }
  }
}

func socketPathFromArguments() -> String? {
  let args = CommandLine.arguments
  guard let idx = args.firstIndex(of: "--socket"), idx + 1 < args.count else {
    return nil
  }
  return args[idx + 1]
}

if #available(macOS 26.0, *) {
  applyAccessoryActivationPolicy()
  let authorizeOnly = CommandLine.arguments.contains("--authorize-only")
  do {
    try configureIoTransport(socketPath: authorizeOnly ? nil : socketPathFromArguments())
  } catch {
    emitError(error.localizedDescription)
    exit(1)
  }
  Task {
    if authorizeOnly {
      await runAuthorizeOnly()
    } else {
      await runTranscriptionLoop()
      exit(0)
    }
  }
  dispatchMain()
} else {
  emitError("SpeechAnalyzer requires macOS 26 or later")
  exit(1)
}
