import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import { requireCognito } from './cognito-auth.js';
import { listEnabledModels } from './models.js';
import { proxyToProvider, type ProviderTarget } from './proxy.js';
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
  { provider: 'openrouter', upstreamOrigin: 'https://openrouter.ai/api', mountPath: '/openrouter' },
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

// All remaining routes require a valid Cognito JWT
app.use(requireCognito);

app.get('/models', (_req, res) => {
  res.json({ models: listEnabledModels() });
});

for (const target of PROVIDER_TARGETS) {
  app.use(target.mountPath, (req, res) => {
    void proxyToProvider(req, res, target);
  });
}

app.listen(PORT, HOST, () => {
  console.log(`[york-ie-backend] listening on http://${HOST}:${PORT}`);
});
