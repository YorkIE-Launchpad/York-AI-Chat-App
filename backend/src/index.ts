import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import { requireCognito } from './cognito-auth.js';
import { listEnabledModels } from './models.js';
import { proxyToProvider, type ProviderTarget } from './proxy.js';

dotenv.config();

const PORT = Number(process.env.PORT) || 3001;
const HOST = '127.0.0.1';

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
