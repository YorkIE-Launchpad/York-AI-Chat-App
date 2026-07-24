import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { log, logWarn } from '../utils/logger';

const DEFAULT_RELAY_PORT = 19890;

function getRelayPort(): number {
  const raw = process.env.VECOS_OAUTH_RELAY_PORT?.trim();
  const parsed = raw ? Number(raw) : DEFAULT_RELAY_PORT;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RELAY_PORT;
}

export function getOAuthRelayBaseUrl(): string {
  return `http://127.0.0.1:${getRelayPort()}`;
}

let relayServer: Server | null = null;
let deliverCodeToMain: ((code: string) => boolean) | null = null;

export function isOAuthRelayListening(): boolean {
  return Boolean(relayServer?.listening);
}

export function registerOAuthRelayDeliverer(fn: (code: string) => boolean): void {
  deliverCodeToMain = fn;
}

function setCors(res: ServerResponse, origin: string | undefined): void {
  const allowed =
    origin && (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:'))
      ? origin
      : 'http://localhost:6767';
  res.setHeader('Access-Control-Allow-Origin', allowed);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return null;
  return JSON.parse(text) as unknown;
}

export function ensureOAuthCodeRelayServer(): void {
  if (relayServer?.listening) return;

  const port = getRelayPort();
  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    setCors(res, origin);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url?.split('?')[0] ?? '/';

    if (req.method === 'GET' && url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, relay: getOAuthRelayBaseUrl() }));
      return;
    }

    if (req.method !== 'POST' || url !== '/relay') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Not found' }));
      return;
    }

    try {
      const body = (await readJsonBody(req)) as { code?: string } | null;
      const code = typeof body?.code === 'string' ? body.code.trim() : '';
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Missing code' }));
        return;
      }
      if (!deliverCodeToMain?.(code)) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: false,
            error: 'No active sign-in in VECOS. Start sign-in from the app first.',
          })
        );
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (error) {
      logWarn('[Auth] OAuth relay error:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Relay failed' }));
    }
  });

  server.on('error', (error) => {
    logWarn('[Auth] OAuth relay server error:', error);
    if (relayServer === server) {
      relayServer = null;
    }
  });

  server.listen(port, '127.0.0.1', () => {
    relayServer = server;
    log('[Auth] OAuth code relay listening on', getOAuthRelayBaseUrl());
  });
}

export function stopOAuthCodeRelayServer(): void {
  if (!relayServer) return;
  relayServer.close();
  relayServer = null;
}
