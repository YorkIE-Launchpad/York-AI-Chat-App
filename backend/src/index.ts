import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import { requireMinClientVersion } from './client-version.js';
import { requireCognito } from './cognito-auth.js';
import { createCollabInviteRouter } from './collab/invite-router.js';
import { createConnectorOauthRouter } from './connector-oauth-routes.js';
import { createCollabHttpRelayRouter } from './collab/http-relay.js';
import { createShareDocRouter } from './share/doc-router.js';
import { attachCollabRelay } from './collab/yjs-relay.js';
import { listEnabledModels } from './models.js';
import { proxyToProvider, type ProviderTarget } from './proxy.js';
import { log, logWarn } from './safe-log.js';
import { resolveSlackRelayConfig } from './slack-relay/config.js';
import { createSlackEventsRouter } from './slack-relay/events-router.js';
import { SlackRelayHub } from './slack-relay/relay-hub.js';
import { attachSlackRelay } from './slack-relay/relay-ws.js';
import { createSlackApi } from './slack-relay/slack-api.js';
import { createYorkLlmRouter, resolveYorkLlmUpstreamOrigin } from './york-llm-router.js';
import { createZoomSessionRouter, createZoomWebhookRouter } from './zoom-routes.js';
import {
  createZoomOauthCallbackRouter,
  createZoomOauthMisconfiguredRedirectRouter,
} from './zoom-oauth-callback.js';

dotenv.config();

const PORT = Number(process.env.PORT) || 3001;
/** Bind 0.0.0.0 in production so Zoom webhooks can reach a public deploy. */
const HOST =
  process.env.HOST?.trim() || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');

const PROVIDER_TARGETS: ProviderTarget[] = [
  { provider: 'anthropic', upstreamOrigin: 'https://api.anthropic.com', mountPath: '/anthropic' },
  { provider: 'openai', upstreamOrigin: 'https://api.openai.com', mountPath: '/openai' },
  {
    provider: 'gemini',
    upstreamOrigin: 'https://generativelanguage.googleapis.com',
    mountPath: '/gemini',
  },
  { provider: 'typesafe', upstreamOrigin: 'https://api.typesafe.ai', mountPath: '/typesafe' },
];

const app = express();

app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// JSON parsers are scoped to Zoom routes only. A global express.json() consumes the
// request stream before proxyToProvider can read it, which forwards empty bodies to
// upstream LLM APIs and hangs until the client times out (~180s).
const zoomJsonWithRawBody = express.json({
  verify: (req, _res, buf) => {
    (req as express.Request & { rawBody?: string }).rawBody = buf.toString('utf8');
  },
});

// Zoom OAuth public callback (HTML bridge → local Electron listener). No Cognito.
app.use('/oauth/zoom', createZoomOauthCallbackRouter());
// Bare /callback is a common misconfig — explain the correct URI instead of Cognito 401 JSON.
app.use(createZoomOauthMisconfiguredRedirectRouter());
// Zoom webhooks must be public (signature-validated inside the router).
app.use('/zoom', zoomJsonWithRawBody, createZoomWebhookRouter());
// Zoom session register/poll require Cognito (applied inside the router).
app.use('/zoom', express.json(), createZoomSessionRouter());

// Slack remote-control relay. Events are public but Slack-signed; disabled (503) unless fully configured.
const slackRelayConfig = resolveSlackRelayConfig();
const slackRelayApi = slackRelayConfig ? createSlackApi(slackRelayConfig.botToken) : null;
const slackRelayHub = slackRelayApi ? new SlackRelayHub(slackRelayApi) : null;
if (!slackRelayConfig) {
  logWarn('[york-ie-backend] Slack relay disabled (SLACK_RELAY_* env incomplete)');
}
app.use('/slack', createSlackEventsRouter({ config: slackRelayConfig, hub: slackRelayHub }));

// All remaining routes require a valid Cognito JWT and a supported client version
app.use(requireCognito);
app.use(requireMinClientVersion);

app.get('/models', (_req, res) => {
  res.json({ models: listEnabledModels() });
});

// Slack / Google / Zoom connector token exchange + refresh (client secrets stay server-side).
app.use('/connectors/oauth', express.json(), createConnectorOauthRouter());

// Long-poll Yjs relay for proxies that drop WebSocket upgrades (memory only, like /collab/ws).
app.use('/collab', createCollabHttpRelayRouter());

// Stateless collab invite JWT sign/verify (no room storage).
app.use('/collab', express.json(), createCollabInviteRouter());

// Shared artifact documents — stateless invite JWTs (no doc registry); blobs in Hub S3.
app.use('/share/docs', express.json(), createShareDocRouter());

app.use(
  '/york-llm',
  createYorkLlmRouter({
    provider: 'york-llm',
    upstreamOrigin: resolveYorkLlmUpstreamOrigin(),
    mountPath: '/york-llm',
    apiKeyOptional: true,
  })
);

for (const target of PROVIDER_TARGETS) {
  app.use(target.mountPath, (req, res) => {
    void proxyToProvider(req, res, target);
  });
}

const server = app.listen(PORT, HOST, () => {
  log(`[york-ie-backend] listening on http://${HOST}:${PORT}`);
});

// Ephemeral Yjs binary fan-out (no server-side docs). Cognito + invite on upgrade.
attachCollabRelay(server);
log('[york-ie-backend] collab WS relay attached at /collab/ws');

attachSlackRelay(server, { config: slackRelayConfig, hub: slackRelayHub, api: slackRelayApi });
