# york-apple-llm

On-device Apple Foundation Model helper using **FoundationModels** (macOS 26+ SDK).

## Why not `fm serve`?

The `fm` CLI gates every command behind a one-time `sudo fm license`.
On Jamf-managed employee Macs nobody has sudo, so GrowthOS ships this
helper instead: apps using the FoundationModels framework have no license
gate — only Apple Intelligence availability. `fm serve` remains a fallback
for builds without the helper, and IT can pre-accept its terms on a fleet
with `scripts/jamf/accept-fm-license.sh`.

## Build

Requires Xcode with the macOS 26+ SDK:

```bash
npm run build:apple-llm
```

Also runs as part of `npm run build` (macOS only; no-op elsewhere).

Output: `resources/tools/darwin-{arm64|x64}/bin/york-apple-llm`

## Protocol

```bash
york-apple-llm availability        # one-line JSON: {"available":true,...}
york-apple-llm serve --port 1976   # OpenAI-compatible server on 127.0.0.1
```

Routes: `GET /health`, `GET /availability`, `GET /v1/models`,
`POST /v1/chat/completions` (streaming SSE + non-streaming, model `system`).

No account, no network, no API key. Tool calls are not supported by the
on-device model — best for summarizing, extracting, classifying, rewriting.
