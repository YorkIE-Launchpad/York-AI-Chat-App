/**
 * `/slack-relay/ws`: authenticated desktop sockets for Slack remote control.
 *
 * Upgrade requires a Cognito **id** token in the Authorization header (never the
 * query string), a supported client version, a verified allowed email, and no
 * browser Origin. After upgrade the desktop must send one `register` frame with
 * its Slack user token within REGISTER_TIMEOUT_MS; the backend resolves it with
 * auth.test and requires the Slack profile email to match the Cognito email.
 */
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { checkClientVersion, YORK_APP_VERSION_HEADER } from '../client-version.js';
import { verifyCognitoTokenDetailed } from '../cognito-auth.js';
import { log, logWarn } from '../safe-log.js';
import { isEmailAllowed, type SlackRelayConfig } from './config.js';
import {
  hashKey,
  ownerKeyOf,
  RELAY_CLOSE_CODES,
  SlidingWindowLimiter,
  type RelayPeer,
  type SlackRelayHub,
} from './relay-hub.js';
import type { SlackApi } from './slack-api.js';

export const SLACK_RELAY_WS_PATH = '/slack-relay/ws';
const REGISTER_TIMEOUT_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_TOTAL_SOCKETS = 2_000;
const UPGRADES_PER_IP_PER_MINUTE = 60;
const UPGRADES_PER_USER_PER_MINUTE = 10;
const FRAMES_PER_SOCKET_PER_MINUTE = 120;
const SLACK_USER_TOKEN_RE = /^(?:xoxp|xoxe\.xoxp)-[A-Za-z0-9-]{10,400}$/;

type VerifyToken = typeof verifyCognitoTokenDetailed;

export interface AttachSlackRelayOptions {
  config: SlackRelayConfig | null;
  hub: SlackRelayHub | null;
  api: SlackApi | null;
  verifyToken?: VerifyToken;
}

interface CognitoIdentity {
  sub: string;
  email: string;
  expiresAtMs: number;
}

function reject(socket: Duplex, status: number, text: string): void {
  try {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } finally {
    socket.destroy();
  }
}

function bearerFromHeader(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (typeof auth !== 'string') return null;
  const match = /^\s*Bearer\s+(\S+)\s*$/i.exec(auth);
  return match?.[1] || null;
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function identityFromPayload(
  payload: Record<string, unknown>,
  config: SlackRelayConfig
): CognitoIdentity | null {
  const sub = typeof payload.sub === 'string' ? payload.sub : '';
  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  const verified = payload.email_verified === true || payload.email_verified === 'true';
  const exp = typeof payload.exp === 'number' ? payload.exp : 0;
  if (!sub || !email || !verified || !exp) return null;
  if (!isEmailAllowed(email, config)) return null;
  return { sub, email, expiresAtMs: exp * 1000 };
}

function parseFrame(data: RawData, isBinary: boolean): Record<string, unknown> | null {
  if (isBinary) return null;
  try {
    const parsed = JSON.parse(data.toString()) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function attachSlackRelay(
  server: HttpServer,
  options: AttachSlackRelayOptions
): WebSocketServer {
  const verifyToken = options.verifyToken ?? verifyCognitoTokenDetailed;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  const ipLimiter = new SlidingWindowLimiter(UPGRADES_PER_IP_PER_MINUTE, 60_000);
  const userLimiter = new SlidingWindowLimiter(UPGRADES_PER_USER_PER_MINUTE, 60_000);

  server.on('upgrade', (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url || '', 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== SLACK_RELAY_WS_PATH) return;

    void (async () => {
      const { config, hub, api } = options;
      if (!config || !hub || !api) return reject(socket, 503, 'Service Unavailable');
      // Browsers always send Origin; legitimate clients are the Electron main process.
      if (req.headers.origin !== undefined) return reject(socket, 403, 'Forbidden');
      if (!ipLimiter.allow(req.socket.remoteAddress || 'unknown')) {
        return reject(socket, 429, 'Too Many Requests');
      }
      // Credentials in URLs leak into proxy/access logs.
      if (url.search) return reject(socket, 400, 'Bad Request');
      if (!checkClientVersion(headerValue(req, YORK_APP_VERSION_HEADER)).ok) {
        return reject(socket, 426, 'Upgrade Required');
      }
      if (wss.clients.size >= MAX_TOTAL_SOCKETS) return reject(socket, 503, 'Service Unavailable');

      const token = bearerFromHeader(req);
      if (!token) return reject(socket, 401, 'Unauthorized');
      const verified = await verifyToken(token);
      if (!verified.ok || verified.tokenUse !== 'id') return reject(socket, 401, 'Unauthorized');
      const identity = identityFromPayload(verified.payload, config);
      if (!identity) return reject(socket, 403, 'Forbidden');
      if (identity.expiresAtMs <= Date.now()) return reject(socket, 401, 'Unauthorized');
      if (!userLimiter.allow(identity.sub)) return reject(socket, 429, 'Too Many Requests');

      wss.handleUpgrade(req, socket, head, (ws) => {
        handleConnection(ws, identity, config, hub, api);
      });
    })().catch((error) => {
      logWarn('[slack-relay] upgrade failed', error);
      socket.destroy();
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const live = ws as WebSocket & { __alive?: boolean };
      if (live.__alive === false) {
        live.terminate();
        continue;
      }
      live.__alive = false;
      live.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();
  wss.on('close', () => clearInterval(heartbeat));

  return wss;
}

function handleConnection(
  ws: WebSocket,
  identity: CognitoIdentity,
  config: SlackRelayConfig,
  hub: SlackRelayHub,
  api: SlackApi
): void {
  const live = ws as WebSocket & { __alive?: boolean };
  live.__alive = true;
  live.on('pong', () => {
    live.__alive = true;
  });

  const peer: RelayPeer = {
    id: randomUUID(),
    send(frame) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
    },
    close(code, reason) {
      try {
        ws.close(code, reason);
      } catch {
        ws.terminate();
      }
    },
  };
  const frameLimiter = new SlidingWindowLimiter(FRAMES_PER_SOCKET_PER_MINUTE, 60_000);
  let state: 'awaiting_register' | 'registering' | 'registered' = 'awaiting_register';

  const registerTimer = setTimeout(() => {
    if (state !== 'registered') peer.close(RELAY_CLOSE_CODES.unauthorized, 'register_timeout');
  }, REGISTER_TIMEOUT_MS);
  const expiryTimer = setTimeout(
    () => peer.close(RELAY_CLOSE_CODES.unauthorized, 'token_expired'),
    Math.max(0, identity.expiresAtMs - Date.now())
  );

  ws.on('close', () => {
    clearTimeout(registerTimer);
    clearTimeout(expiryTimer);
    hub.unregisterPeer(peer);
  });
  ws.on('error', () => {
    hub.unregisterPeer(peer);
  });

  ws.on('message', (data, isBinary) => {
    if (!frameLimiter.allow(peer.id)) {
      peer.close(RELAY_CLOSE_CODES.rateLimited, 'rate_limited');
      return;
    }
    const frame = parseFrame(data, isBinary);
    if (!frame) {
      peer.close(RELAY_CLOSE_CODES.badFrame, 'bad_frame');
      return;
    }

    if (state === 'awaiting_register') {
      if (frame.type !== 'register') {
        peer.close(RELAY_CLOSE_CODES.unauthorized, 'register_required');
        return;
      }
      state = 'registering';
      void registerOwner(frame.slackUserToken, identity, config, hub, api, peer).then((result) => {
        if (ws.readyState !== ws.OPEN) {
          hub.unregisterPeer(peer);
          return;
        }
        if (!result.ok) {
          peer.close(RELAY_CLOSE_CODES.forbidden, result.reason);
          return;
        }
        state = 'registered';
        clearTimeout(registerTimer);
        peer.send({ type: 'registered', slackUserId: result.userId, teamId: result.teamId });
      });
      return;
    }
    if (state === 'registering') {
      peer.close(RELAY_CLOSE_CODES.badFrame, 'frame_before_registered');
      return;
    }

    switch (frame.type) {
      case 'ping':
        peer.send({ type: 'pong' });
        return;
      case 'reply': {
        const requestId = typeof frame.requestId === 'string' ? frame.requestId.slice(0, 64) : null;
        void hub.handleReply(peer, frame.replyHandle, frame.text).then((result) => {
          peer.send({ type: 'reply_result', requestId, ...result });
        });
        return;
      }
      default:
        peer.close(RELAY_CLOSE_CODES.badFrame, 'unknown_frame');
    }
  });
}

type RegisterResult =
  | { ok: true; userId: string; teamId: string }
  | { ok: false; reason: 'invalid_slack_token' | 'slack_identity_rejected' };

async function registerOwner(
  slackUserToken: unknown,
  identity: CognitoIdentity,
  config: SlackRelayConfig,
  hub: SlackRelayHub,
  api: SlackApi,
  peer: RelayPeer
): Promise<RegisterResult> {
  if (typeof slackUserToken !== 'string' || !SLACK_USER_TOKEN_RE.test(slackUserToken)) {
    return { ok: false, reason: 'invalid_slack_token' };
  }
  const tag = hashKey(identity.sub);
  try {
    const slack = await api.authTest(slackUserToken);
    if (slack.teamId !== config.teamId) {
      logWarn(`[slack-relay] register rejected sub=${tag}: wrong team`);
      return { ok: false, reason: 'slack_identity_rejected' };
    }
    const profile = await api.usersInfo(slack.userId);
    const slackEmail = profile.email?.trim().toLowerCase() || '';
    if (
      profile.teamId !== config.teamId ||
      profile.isBot ||
      profile.deleted ||
      profile.isRestricted ||
      profile.isUltraRestricted ||
      profile.isStranger ||
      !slackEmail ||
      slackEmail !== identity.email
    ) {
      logWarn(`[slack-relay] register rejected sub=${tag}: profile/email mismatch`);
      return { ok: false, reason: 'slack_identity_rejected' };
    }
    const imChannel = await api.openIm(slack.userId);
    hub.registerOwner(ownerKeyOf(slack.teamId, slack.userId), peer, imChannel);
    log(`[slack-relay] registered sub=${tag}`);
    return { ok: true, userId: slack.userId, teamId: slack.teamId };
  } catch (error) {
    logWarn(`[slack-relay] register failed sub=${tag}`, error);
    return { ok: false, reason: 'slack_identity_rejected' };
  }
}
