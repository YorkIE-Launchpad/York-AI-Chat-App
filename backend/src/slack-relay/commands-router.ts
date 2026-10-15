/**
 * Public Slack slash-command endpoint (`POST /slack/commands`) for `/growthos`.
 *
 * Answers within Slack's 3-second window using only in-memory state: `help` and
 * "desktop offline" are answered directly, everything else gets an ephemeral
 * acknowledgement and is forwarded to the owner's desktop afterwards. Results
 * arrive as bot messages in the owner's IM.
 */
import express, { type Request, type Response, type Router } from 'express';
import { helpText } from './blocks.js';
import type { SlackRelayConfig } from './config.js';
import { TYPED_COMMANDS, isOneOf, type CommandName } from './protocol.js';
import type { SlackRelayHub } from './relay-hub.js';
import type { SlackApi } from './slack-api.js';
import { escapeSlackText } from './sanitize.js';
import {
  afterAck,
  ephemeral,
  rawSlackBody,
  respondEphemeral,
  resultMessage,
  verifiedRawBody,
} from './slack-request.js';

const ALIASES: Record<string, CommandName> = {
  list: 'chats',
  ls: 'chats',
  chat: 'chats',
  reset: 'new',
  cancel: 'stop',
  abort: 'stop',
  '?': 'help',
  models: 'model',
  workspaces: 'workspace',
  ws: 'workspace',
  project: 'workspace',
  projects: 'workspace',
};

const ACKS: Record<Exclude<CommandName, 'help' | 'open' | 'pick'>, string> = {
  new: 'Starting a new chat…',
  chats: 'Fetching your recent chats…',
  model: 'Checking models…',
  workspace: 'Checking workspaces…',
  stop: 'Stopping…',
  status: 'Checking…',
};

export function parseSlashText(text: string): {
  name: CommandName | null;
  arg: string;
  raw: string;
} {
  const trimmed = text.trim();
  if (!trimmed) return { name: 'help', arg: '', raw: '' };
  const first = trimmed.split(/\s+/)[0];
  const raw = first.toLowerCase();
  const name = ALIASES[raw] ?? (isOneOf(TYPED_COMMANDS, raw) ? raw : null);
  const arg = trimmed.slice(first.length).trim();
  return { name, arg, raw };
}

export function createSlackCommandsRouter(deps: {
  config: SlackRelayConfig | null;
  hub: SlackRelayHub | null;
  api: SlackApi | null;
}): Router {
  const router = express.Router();

  router.post('/commands', rawSlackBody, (req: Request, res: Response) => {
    const { config, hub, api } = deps;
    if (!config || !hub || !api) {
      res.status(503).json({ error: 'slack_relay_disabled' });
      return;
    }
    const rawBody = verifiedRawBody(req, config);
    if (rawBody === null) {
      res.status(401).json({ error: 'invalid_signature' });
      return;
    }

    const form = new URLSearchParams(rawBody);
    const teamId = form.get('team_id') ?? '';
    const userId = form.get('user_id') ?? '';
    const channelId = form.get('channel_id') ?? '';
    const appId = form.get('api_app_id');
    if ((appId && appId !== config.appId) || teamId !== config.teamId) {
      res.status(403).json({ error: 'wrong_workspace' });
      return;
    }
    if (!/^[UW][A-Z0-9]{1,30}$/.test(userId)) {
      res.status(400).json({ error: 'invalid_user' });
      return;
    }

    const triggerId = form.get('trigger_id') ?? '';
    if (triggerId && !hub.markEventSeen(`cmd:${triggerId}`)) {
      res.status(200).end();
      return;
    }

    const command = form.get('command') ?? undefined;
    const { name, arg, raw } = parseSlashText(form.get('text') ?? '');
    if (name === null) {
      res.json(
        ephemeral(`I don't know \`${escapeSlackText(raw.slice(0, 30))}\`.\n\n${helpText(command)}`)
      );
      return;
    }
    if (name === 'help' || name === 'open' || name === 'pick') {
      res.json(ephemeral(helpText(command)));
      return;
    }

    const availability = hub.commandAvailability(teamId, userId);
    if (availability !== 'ok') {
      res.json(ephemeral(resultMessage(availability)));
      return;
    }

    const inIm = hub.ownerImChannel(teamId, userId) === channelId;
    res.json(
      ephemeral(inIm ? ACKS[name] : `${ACKS[name]} I'll reply in your York IE GrowthOS DM.`)
    );

    const responseUrl = form.get('response_url');
    afterAck('slash command', async () => {
      const result = hub.dispatchCommand({ teamId, userId, name, arg: arg || undefined });
      if (result !== 'ok') await respondEphemeral(api, responseUrl, resultMessage(result));
    });
  });

  return router;
}
