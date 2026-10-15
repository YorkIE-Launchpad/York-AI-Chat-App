import type { RelayPeer } from './relay-hub.js';
import type { SlackApi, SlackUserProfile } from './slack-api.js';

export interface FakeSlackApi extends SlackApi {
  posts: Array<{ channel: string; text: string; threadTs?: string }>;
  profile: SlackUserProfile;
  identity: { userId: string; teamId: string };
  imChannel: string;
}

export function createFakeSlackApi(): FakeSlackApi {
  const fake: FakeSlackApi = {
    posts: [],
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
      fake.posts.push(input);
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
