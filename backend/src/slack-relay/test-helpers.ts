import type { RelayPeer } from './relay-hub.js';
import type { SlackApi, SlackBlock, SlackUserProfile } from './slack-api.js';

export interface FakeSlackApi extends SlackApi {
  posts: Array<{ channel: string; text: string; threadTs?: string; blocks?: SlackBlock[] }>;
  updates: Array<{ channel: string; ts: string; text: string; blocks?: SlackBlock[] }>;
  reactions: Array<{ op: 'add' | 'remove'; channel: string; ts: string; name: string }>;
  responses: Array<{ url: string; body: Record<string, unknown> }>;
  profile: SlackUserProfile;
  identity: { userId: string; teamId: string };
  imChannel: string;
  /** When set, every Web API call waits on this promise (simulates a slow Slack). */
  gate: Promise<void> | null;
}

export function createFakeSlackApi(): FakeSlackApi {
  let tsCounter = 0;
  const wait = async () => {
    if (fake.gate) await fake.gate;
  };
  const fake: FakeSlackApi = {
    posts: [],
    updates: [],
    reactions: [],
    responses: [],
    gate: null,
    identity: { userId: 'U1', teamId: 'T1' },
    imChannel: 'D1',
    profile: {
      id: 'U1',
      teamId: 'T1',
      email: 'dev@york.ie',
      isBot: false,
      deleted: false,
      isRestricted: false,
      isUltraRestricted: false,
      isStranger: false,
    },
    async authTest() {
      return fake.identity;
    },
    async usersInfo() {
      return fake.profile;
    },
    async openIm() {
      return fake.imChannel;
    },
    async postMessage(input) {
      await wait();
      fake.posts.push(input);
      tsCounter += 1;
      return { ts: `100.${tsCounter}` };
    },
    async updateMessage(input) {
      await wait();
      fake.updates.push(input);
    },
    async addReaction(input) {
      await wait();
      fake.reactions.push({ op: 'add', ...input });
    },
    async removeReaction(input) {
      await wait();
      fake.reactions.push({ op: 'remove', ...input });
    },
    async respond(url, body) {
      await wait();
      fake.responses.push({ url, body });
    },
  };
  return fake;
}

export interface FakePeer extends RelayPeer {
  frames: Array<Record<string, unknown>>;
  closed: { code: number; reason: string } | null;
}

export function createFakePeer(id: string): FakePeer {
  const peer: FakePeer = {
    id,
    frames: [],
    closed: null,
    send(frame) {
      peer.frames.push(frame);
    },
    close(code, reason) {
      peer.closed = { code, reason };
    },
  };
  return peer;
}

/** Let queued hub work (Slack calls run off the request path) settle. */
export async function flushAsync(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}
