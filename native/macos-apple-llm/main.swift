// york-apple-llm — bundled FoundationModels helper for Apple Local LLM.
//
// Why this exists instead of shelling out to `fm serve`:
// `fm` is a CLI and gates *every* command behind a one-time
// `sudo fm license` agreement (`/Library/Preferences/com.apple.fm.plist`).
// On Jamf-managed employee Macs nobody has sudo, so that path is dead.
// Apps using the FoundationModels framework directly have no such gate —
// they only need Apple Intelligence availability, exactly like any other
// Apple Intelligence app. This helper is that app-path, speaking the same
// OpenAI Chat Completions shape `fm serve` does so GrowthOS can use either.
//
// Usage:
//   york-apple-llm availability          → one-line JSON availability, exit 0
//   york-apple-llm serve [--port 1976]   → OpenAI-compatible server on 127.0.0.1
//
// Routes: GET /health, GET /availability, GET /v1/models,
//         POST /v1/chat/completions (streaming + non-streaming)

import Darwin
import Foundation
import FoundationModels

// MARK: - Availability

struct Availability: Encodable {
    let available: Bool
    let reason: String?
    let message: String?
    let serverRunning: Bool?
}

func currentAvailability(serverRunning: Bool? = nil) -> Availability {
    switch SystemLanguageModel.default.availability {
    case .available:
        return Availability(available: true, reason: nil, message: nil, serverRunning: serverRunning)
    case .unavailable(.deviceNotEligible):
        return Availability(
            available: false,
            reason: "apple-intelligence-unavailable",
            message: "This device does not support Apple Intelligence.",
            serverRunning: serverRunning)
    case .unavailable(.appleIntelligenceNotEnabled):
        return Availability(
            available: false,
            reason: "apple-intelligence-unavailable",
            message: "Apple Intelligence is not enabled on this Mac. Turn it on in System Settings \u{2192} Apple Intelligence.",
            serverRunning: serverRunning)
    case .unavailable(.modelNotReady):
        return Availability(
            available: false,
            reason: "model-unavailable",
            message: "The on-device model is not ready yet (it may still be downloading). Try again shortly.",
            serverRunning: serverRunning)
    @unknown default:
        return Availability(
            available: false,
            reason: "unknown",
            message: "The on-device model is unavailable.",
            serverRunning: serverRunning)
    }
}

func jsonData(_ object: Any) -> Data {
    (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{}".utf8)
}

func availabilityJSON(serverRunning: Bool? = nil) -> Data {
    let a = currentAvailability(serverRunning: serverRunning)
    return jsonData([
        "available": a.available,
        "reason": a.reason as Any,
        "message": a.message as Any,
        "serverRunning": a.serverRunning as Any,
    ].compactMapValues { $0 })
}

// MARK: - Chat request shaping

struct ChatRequest {
    let instructions: String?
    let turns: [(role: String, text: String)]
    let stream: Bool
    let maximumResponseTokens: Int?
    let temperature: Double?
}

func buildPrompt(_ turns: [(role: String, text: String)]) -> String {
    guard let last = turns.last else { return "" }
    if turns.count == 1 { return last.text }
    return turns.map { "\($0.role): \($0.text)" }.joined(separator: "\n")
        + "\n\nRespond as the Assistant to the last User message."
}

func messageText(_ content: Any?) -> String {
    if let text = content as? String { return text }
    if let parts = content as? [[String: Any]] {
        return parts.compactMap { part -> String? in
            guard (part["type"] as? String) == "text" else { return nil }
            return part["text"] as? String
        }.joined(separator: "\n")
    }
    return ""
}

// Agent clients wrap user turns in context blocks (GrowthOS: turn_context
// with a workspace listing, memory, skill bodies, cold-start history). A 4K
// model answers those blocks instead of the question, so they are removed
// from every turn, including replayed history.
private let scaffoldingPatterns: [NSRegularExpression] = [
    "turn_context", "per_turn_context", "memory_context", "knowledge_sources",
    "active_project_context", "active_client_context", "conversation_history",
    "your_configuration", "workspace_info", "system-reminder",
].compactMap { tag in
    try? NSRegularExpression(
        pattern: "<\(tag)\\b[^>]*>[\\s\\S]*?</\(tag)>",
        options: [.caseInsensitive])
} + [
    try? NSRegularExpression(pattern: "<skill\\s+name=[\"'][^\"']+[\"'][\\s\\S]*?</skill>", options: [.caseInsensitive]),
].compactMap { $0 }

func stripScaffolding(_ text: String) -> String {
    guard text.contains("<") else { return text }
    var result = text
    for regex in scaffoldingPatterns {
        let range = NSRange(result.startIndex..., in: result)
        result = regex.stringByReplacingMatches(in: result, range: range, withTemplate: "")
    }
    return result.trimmingCharacters(in: .whitespacesAndNewlines)
}

func parseChatRequest(_ body: Data) -> ChatRequest? {
    guard let root = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any],
          let messages = root["messages"] as? [[String: Any]]
    else { return nil }

    var systemParts: [String] = []
    var turns: [(role: String, text: String)] = []
    for message in messages {
        let role = (message["role"] as? String) ?? "user"
        let text = stripScaffolding(messageText(message["content"]))
        if text.isEmpty && role != "system" { continue }
        switch role {
        case "system", "developer":
            if !text.isEmpty { systemParts.append(text) }
        case "assistant":
            turns.append(("Assistant", text))
        case "tool", "function":
            turns.append(("Tool result", text))
        default:
            turns.append(("User", text))
        }
    }
    guard !turns.isEmpty else { return nil }

    let maxTokens = (root["max_tokens"] as? Int) ?? (root["max_completion_tokens"] as? Int)
    return ChatRequest(
        instructions: systemParts.isEmpty ? nil : systemParts.joined(separator: "\n\n"),
        turns: turns,
        stream: root["stream"] as? Bool ?? false,
        maximumResponseTokens: maxTokens,
        temperature: root["temperature"] as? Double)
}

// MARK: - Context budgeting (4K window)
//
// GrowthOS's agent prompt alone is several thousand tokens, and chat
// history grows every turn. The on-device model hard-fails past its
// context size, so instead of surfacing that error we fit every request:
// instructions are slimmed, the oldest turns are dropped, and a single
// oversized message (e.g. "summarize this long doc") is head+tail
// truncated with a marker. Newest content always survives.

func tokenCount(of text: String, model: SystemLanguageModel) async -> Int {
    if text.isEmpty { return 0 }
    // Exact tokenizer is macOS 26.4+; older 26.x uses a conservative
    // chars-per-token estimate (the fit check also keeps a safety margin).
    if #available(macOS 26.4, *) {
        if let count = try? await model.tokenCount(for: text) { return count }
    }
    return Int(ceil(Double(text.count) / 3.5))
}

func truncateToTokens(_ text: String, budget: Int, model: SystemLanguageModel, keepTail: Bool = false) async -> String {
    if budget <= 0 { return "" }
    if await tokenCount(of: text, model: model) <= budget { return text }
    let chars = Array(text)
    var lo = 0
    var hi = chars.count
    while lo < hi {
        let mid = (lo + hi + 1) / 2
        let candidate = keepTail ? String(chars.suffix(mid)) : String(chars.prefix(mid))
        if await tokenCount(of: candidate, model: model) <= budget {
            lo = mid
        } else {
            hi = mid - 1
        }
    }
    return keepTail ? String(chars.suffix(lo)) : String(chars.prefix(lo))
}

func fitToContext(_ request: ChatRequest, model: SystemLanguageModel) async -> (instructions: String, prompt: String) {
    let contextSize = model.contextSize > 0 ? model.contextSize : 4096
    // Cap the reply too: a chatty 4K model is for short answers, and an
    // uncapped max_tokens from the agent stack would eat the whole window.
    let responseReserve = min(max(request.maximumResponseTokens ?? 512, 128), 512)
    let inputBudget = max(512, contextSize - responseReserve - 192)

    // Format guard comes first: clients may send a coding-agent system
    // prompt ("create files / build deliverables"), which makes this small
    // tool-less model emit HTML/code as chat text. Chat format wins.
    let formatGuard = "You are a chat assistant. Reply in plain text or simple Markdown by default. Write HTML or code only when the user asks for HTML or code, and then write it. Do not create files. Be concise and direct. Answer the user's latest message helpfully; greetings get a friendly greeting. Only if it asks for live, personal, or company data you cannot see (calendars, leaves, messages, the web), say so instead of inventing it."
    // The full GrowthOS agent system prompt does not fit a 4K window and
    // mostly does not apply on-device (tools are unsupported here). Keeping
    // a truncated head of it is worse than dropping it: the coding-agent
    // persona survives the cut and the model keeps trying to create files.
    // Short client instructions are kept; oversized ones are replaced.
    var instructions = request.instructions ?? ""
    let instructionsCap = min(384, inputBudget / 4)
    if await tokenCount(of: instructions, model: model) > instructionsCap {
        instructions = ""
    }
    instructions = instructions.isEmpty ? formatGuard : formatGuard + "\n\n" + instructions
    let instructionsTokens = await tokenCount(of: instructions, model: model)
    let promptBudget = max(256, inputBudget - instructionsTokens)

    var turns = request.turns
    while turns.count > 1,
          await tokenCount(of: buildPrompt(turns), model: model) > promptBudget {
        turns.removeFirst() // drop oldest history first
    }
    var prompt = buildPrompt(turns)
    if await tokenCount(of: prompt, model: model) > promptBudget, var last = turns.last {
        // One oversized message: keep the start and the end (where the
        // actual ask usually lives), mark the middle as elided.
        let headBudget = promptBudget * 3 / 4
        let tailBudget = max(64, promptBudget - headBudget)
        let head = await truncateToTokens(last.text, budget: headBudget, model: model)
        let tail = await truncateToTokens(last.text, budget: tailBudget, model: model, keepTail: true)
        last.text = head + "\n\n[…content truncated to fit the on-device model's context…]\n\n" + tail
        turns[turns.count - 1] = last
        prompt = buildPrompt(turns)
    }
    return (instructions, prompt)
}

// The on-device model serves one generation at a time.
private let generationGate = DispatchSemaphore(value: 1)

func generate(_ request: ChatRequest, onDelta: @escaping (String) -> Void) throws -> String {
    generationGate.wait()
    defer { generationGate.signal() }

    let done = DispatchSemaphore(value: 0)
    var full = ""
    var failure: Error?
    Task {
        do {
            let model = SystemLanguageModel.default
            let fitted = await fitToContext(request, model: model)
            let session = LanguageModelSession(instructions: fitted.instructions)
            let options = GenerationOptions(
                temperature: request.temperature,
                maximumResponseTokens: min(max(request.maximumResponseTokens ?? 512, 128), 512))
            if request.stream {
                var emitted = 0
                for try await snapshot in session.streamResponse(to: fitted.prompt, options: options) {
                    let content = snapshot.content
                    if content.count > emitted {
                        onDelta(String(content.dropFirst(emitted)))
                        emitted = content.count
                    }
                    full = content
                }
            } else {
                full = try await session.respond(to: fitted.prompt, options: options).content
                if !full.isEmpty { onDelta(full) }
            }
        } catch {
            failure = error
        }
        done.signal()
    }
    done.wait()
    if let failure { throw failure }
    return full
}

// MARK: - Minimal HTTP server (POSIX sockets, loopback only)

func sendAll(_ fd: Int32, _ data: Data) {
    data.withUnsafeBytes { raw in
        guard let base = raw.baseAddress else { return }
        var sent = 0
        while sent < raw.count {
            let n = send(fd, base + sent, raw.count - sent, 0)
            if n <= 0 { return }
            sent += n
        }
    }
}

func httpResponse(status: Int, contentType: String, body: Data) -> Data {
    let reason = [200: "OK", 400: "Bad Request", 404: "Not Found", 503: "Service Unavailable"][status] ?? "Error"
    var head = "HTTP/1.1 \(status) \(reason)\r\n"
    head += "Content-Type: \(contentType)\r\n"
    head += "Content-Length: \(body.count)\r\n"
    head += "Connection: close\r\n\r\n"
    return Data(head.utf8) + body
}

func openAIError(status: Int, message: String) -> Data {
    httpResponse(
        status: status,
        contentType: "application/json",
        body: jsonData(["error": ["message": message, "type": "invalid_request_error"]]))
}

func chunkFrame(_ data: Data) -> Data {
    Data("\(String(data.count, radix: 16))\r\n".utf8) + data + Data("\r\n".utf8)
}

func friendlyErrorMessage(_ error: Error) -> String {
    let raw = String(describing: error)
    if raw.localizedCaseInsensitiveContains("context") || raw.localizedCaseInsensitiveContains("exceeds the maximum") {
        return "This conversation is too long for Apple Local LLM's small (~4K) context. Start a new chat, shorten the content, or switch to York LLM / a cloud model for long material."
    }
    return raw
}

func handleChatCompletions(_ fd: Int32, body: Data) {
    guard let request = parseChatRequest(body) else {
        sendAll(fd, openAIError(status: 400, message: "Invalid chat completions request: expected { messages: [...] }"))
        return
    }
    let availability = currentAvailability()
    guard availability.available else {
        sendAll(fd, openAIError(status: 503, message: availability.message ?? "On-device model unavailable"))
        return
    }

    let id = "chatcmpl-\(UUID().uuidString)"
    let created = Int(Date().timeIntervalSince1970)

    if request.stream {
        var head = "HTTP/1.1 200 OK\r\n"
        head += "Content-Type: text/event-stream\r\n"
        head += "Cache-Control: no-cache\r\n"
        head += "Transfer-Encoding: chunked\r\n"
        head += "Connection: close\r\n\r\n"
        sendAll(fd, Data(head.utf8))

        let sendChunk: (Any) -> Void = { object in
            sendAll(fd, chunkFrame(Data("data: ".utf8) + jsonData(object) + Data("\n\n".utf8)))
        }
        sendChunk([
            "id": id, "object": "chat.completion.chunk", "created": created, "model": "system",
            "choices": [["index": 0, "delta": ["role": "assistant", "content": ""], "finish_reason": NSNull()]],
        ])
        do {
            _ = try generate(request) { delta in
                sendChunk([
                    "id": id, "object": "chat.completion.chunk", "created": created, "model": "system",
                    "choices": [["index": 0, "delta": ["content": delta], "finish_reason": NSNull()]],
                ])
            }
            sendChunk([
                "id": id, "object": "chat.completion.chunk", "created": created, "model": "system",
                "choices": [["index": 0, "delta": [String: String](), "finish_reason": "stop"]],
            ])
            sendAll(fd, chunkFrame(Data("data: [DONE]\n\n".utf8)))
            sendAll(fd, Data("0\r\n\r\n".utf8))
        } catch {
            sendChunk(["error": ["message": friendlyErrorMessage(error), "type": "server_error"]])
            sendAll(fd, Data("0\r\n\r\n".utf8))
        }
        return
    }

    do {
        let content = try generate(request) { _ in }
        sendAll(fd, httpResponse(
            status: 200,
            contentType: "application/json",
            body: jsonData([
                "id": id, "object": "chat.completion", "created": created, "model": "system",
                "choices": [[
                    "index": 0,
                    "message": ["role": "assistant", "content": content],
                    "finish_reason": "stop",
                ]],
                "usage": ["prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0],
            ])))
    } catch {
        sendAll(fd, openAIError(status: 503, message: friendlyErrorMessage(error)))
    }
}

func handleConnection(_ fd: Int32) {
    defer { close(fd) }
    var buffer = Data()
    var chunk = [UInt8](repeating: 0, count: 8192)
    var headerEnd: Range<Data.Index>?
    var contentLength = 0

    while headerEnd == nil {
        let n = recv(fd, &chunk, chunk.count, 0)
        if n <= 0 { return }
        buffer.append(contentsOf: chunk[..<n])
        if let range = buffer.range(of: Data("\r\n\r\n".utf8)) {
            headerEnd = range
            let headerText = String(decoding: buffer[..<range.lowerBound], as: UTF8.self)
            for line in headerText.components(separatedBy: "\r\n") {
                let parts = line.split(separator: ":", maxSplits: 1)
                if parts.count == 2, parts[0].lowercased() == "content-length" {
                    contentLength = Int(parts[1].trimmingCharacters(in: .whitespaces)) ?? 0
                }
            }
        }
        if buffer.count > 1_048_576 { return }
    }
    guard let headers = headerEnd else { return }
    var body = buffer[headers.upperBound...]
    while body.count < contentLength {
        let n = recv(fd, &chunk, chunk.count, 0)
        if n <= 0 { break }
        body.append(contentsOf: chunk[..<n])
    }

    let headerText = String(decoding: buffer[..<headers.lowerBound], as: UTF8.self)
    let requestLine = headerText.components(separatedBy: "\r\n").first ?? ""
    let parts = requestLine.split(separator: " ")
    let method = parts.count > 0 ? String(parts[0]) : ""
    let path = parts.count > 1 ? String(parts[1]) : "/"

    switch (method, path) {
    case ("GET", "/health"):
        let a = currentAvailability(serverRunning: true)
        sendAll(fd, httpResponse(status: 200, contentType: "application/json",
                                 body: jsonData(["status": "ok", "available": a.available])))
    case ("GET", "/availability"):
        sendAll(fd, httpResponse(status: 200, contentType: "application/json",
                                 body: availabilityJSON(serverRunning: true)))
    case ("GET", "/v1/models"):
        let a = currentAvailability()
        let data: [[String: Any]] = a.available
            ? [["id": "system", "object": "model", "owned_by": "apple"]]
            : []
        sendAll(fd, httpResponse(status: 200, contentType: "application/json",
                                 body: jsonData(["object": "list", "data": data])))
    case ("POST", "/v1/chat/completions"):
        handleChatCompletions(fd, body: Data(body))
    default:
        sendAll(fd, openAIError(status: 404, message: "Not found: \(method) \(path)"))
    }
}

func serve(port: UInt16) -> Never {
    let listenFd = socket(AF_INET, SOCK_STREAM, 0)
    guard listenFd >= 0 else { fputs("socket() failed\n", stderr); exit(1) }
    var reuse: Int32 = 1
    setsockopt(listenFd, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size))

    var addr = sockaddr_in()
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = port.bigEndian
    addr.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
    let bound = withUnsafePointer(to: &addr) { ptr in
        ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            bind(listenFd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
        }
    }
    guard bound == 0, listen(listenFd, 16) == 0 else {
        fputs("bind/listen on 127.0.0.1:\(port) failed (errno \(errno))\n", stderr)
        exit(1)
    }
    fputs("york-apple-llm serving on http://127.0.0.1:\(port)/v1\n", stderr)

    while true {
        let client = accept(listenFd, nil, nil)
        if client < 0 { continue }
        Thread.detachNewThread {
            handleConnection(client)
        }
    }
}

// MARK: - Entry point

let args = Array(CommandLine.arguments.dropFirst())
if args.first == "availability" {
    print(String(decoding: availabilityJSON(), as: UTF8.self))
    exit(0)
}
if args.first == "serve" {
    var port: UInt16 = 1976
    if let idx = args.firstIndex(of: "--port"), idx + 1 < args.count, let parsed = UInt16(args[idx + 1]) {
        port = parsed
    }
    serve(port: port)
}
fputs("Usage: york-apple-llm availability | serve [--port 1976]\n", stderr)
exit(2)
