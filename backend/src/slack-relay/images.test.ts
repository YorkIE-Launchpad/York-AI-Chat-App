import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { toInboundFile } from './files.js';
import { IMAGE_LIMITS, sniffImageType } from './protocol.js';
import { SlackRelayHub, type InboundSlackMessage } from './relay-hub.js';
import { isSlackFileUrl } from './slack-api.js';
import { createFakePeer, createFakeSlackApi } from './test-helpers.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 9, 9]);
const HTML = new TextEncoder().encode('<!DOCTYPE html><html>Sign in</html>');

const url = (path: string) => `https://files.slack.com/files-pri/T1-${path}`;

function imageFile(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `${id}.png`,
    mimetype: 'image/png',
    size: 1_000,
    url_private_download: url(`${id}/download`),
    thumb_1024: url(`${id}/thumb_1024.png`),
    ...overrides,
  };
}

let counter = 0;
function inbound(overrides: Partial<InboundSlackMessage> = {}): InboundSlackMessage {
  counter += 1;
  return {
    eventId: `EvImg${counter}`,
    teamId: 'T1',
    userId: 'U1',
    channel: 'D1',
    text: '',
    ts: '7.0',
    ...overrides,
  };
}

function setup(capabilities = ['status', 'approvals', 'commands', 'images']) {
  const api = createFakeSlackApi();
  const hub = new SlackRelayHub(api);
  const peer = createFakePeer('p1');
  hub.registerOwner('T1:U1', peer, 'D1', capabilities);
  return { api, hub, peer };
}

describe('image helpers', () => {
  it('detects image types from bytes, not names', () => {
    assert.equal(sniffImageType(PNG), 'image/png');
    assert.equal(sniffImageType(JPEG), 'image/jpeg');
    assert.equal(sniffImageType(new TextEncoder().encode('GIF89a....')), 'image/gif');
    assert.equal(sniffImageType(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
    assert.equal(sniffImageType(HTML), null);
    assert.equal(sniffImageType(new Uint8Array()), null);
  });

  it('only trusts files.slack.com URLs', () => {
    assert.ok(isSlackFileUrl(url('F1/a.png')));
    assert.equal(isSlackFileUrl('http://files.slack.com/x'), false);
    assert.equal(isSlackFileUrl('https://files.slack.com.evil.com/x'), false);
    assert.equal(isSlackFileUrl('https://user@files.slack.com/x'), false);
    assert.equal(isSlackFileUrl('https://evil.com/files.slack.com'), false);
  });

  it('prefers the original when small enough, then thumbnails', () => {
    assert.deepEqual(toInboundFile(imageFile('F1'))?.urls, [
      url('F1/download'),
      url('F1/thumb_1024.png'),
    ]);
    const big = toInboundFile(imageFile('F2', { size: IMAGE_LIMITS.imageMaxBytes + 1 }));
    assert.deepEqual(big?.urls, [url('F2/thumb_1024.png')]);
    const foreign = toInboundFile(
      imageFile('F3', { url_private_download: 'https://evil.com/x', thumb_1024: undefined })
    );
    assert.deepEqual(foreign?.urls, []);
    assert.equal(toInboundFile({ id: 'nope' }), null);
    assert.equal(toInboundFile(imageFile('F4', { mimetype: 'application/pdf' }))?.isImage, false);
  });
});

describe('SlackRelayHub images', () => {
  it('forwards attached images as base64 with the text', async () => {
    const { api, hub, peer } = setup();
    api.files.set(url('F1/download'), PNG);
    const result = await hub.handleInbound(
      inbound({ text: 'what is this?', files: [imageFile('F1')] })
    );
    assert.equal(result, 'delivered');
    const frame = peer.frames.at(-1)!;
    assert.equal(frame.type, 'event');
    assert.equal(frame.text, 'what is this?');
    assert.deepEqual(frame.images, [
      { name: 'F1.png', mediaType: 'image/png', data: Buffer.from(PNG).toString('base64') },
    ]);
    await hub.drain();
    assert.equal(api.posts.length, 0);
  });

  it('delivers image-only messages and falls back to a thumbnail when the original is too big', async () => {
    const { api, hub, peer } = setup();
    api.files.set(url('F1/download'), new Uint8Array(IMAGE_LIMITS.imageMaxBytes + 1));
    api.files.set(url('F1/thumb_1024.png'), JPEG);
    assert.equal(await hub.handleInbound(inbound({ files: [imageFile('F1')] })), 'delivered');
    const frame = peer.frames.at(-1)!;
    assert.equal(frame.text, '');
    assert.equal((frame.images as Array<{ mediaType: string }>)[0].mediaType, 'image/jpeg');
    assert.deepEqual(api.downloads, [url('F1/download'), url('F1/thumb_1024.png')]);
  });

  it('looks up files that only say check_file_info', async () => {
    const { api, hub, peer } = setup();
    api.fileInfos.set('F1', imageFile('F1'));
    api.files.set(url('F1/download'), PNG);
    await hub.handleInbound(inbound({ files: [{ id: 'F1', file_access: 'check_file_info' }] }));
    assert.equal((peer.frames.at(-1)!.images as unknown[]).length, 1);
  });

  it('tells the owner which files were skipped, and still sends the rest', async () => {
    const { api, hub, peer } = setup();
    api.files.set(url('F1/download'), PNG);
    api.files.set(url('F2/download'), HTML);
    const files = [
      imageFile('F1'),
      imageFile('F2'),
      imageFile('F3', { name: 'report.pdf', mimetype: 'application/pdf' }),
    ];
    assert.equal(await hub.handleInbound(inbound({ text: 'see', files })), 'delivered');
    assert.equal((peer.frames.at(-1)!.images as unknown[]).length, 1);
    await hub.drain();
    assert.equal(api.posts.length, 1);
    assert.match(api.posts[0].text, /F2\.png, report\.pdf/);
  });

  it('caps images per message', async () => {
    const { api, hub, peer } = setup();
    const files = Array.from({ length: 6 }, (_, i) => imageFile(`F${i + 1}`));
    for (const f of files) api.files.set(f.url_private_download, PNG);
    await hub.handleInbound(inbound({ files }));
    assert.equal((peer.frames.at(-1)!.images as unknown[]).length, IMAGE_LIMITS.imagesMax);
    await hub.drain();
    assert.match(api.posts[0].text, /F5\.png, F6\.png/);
  });

  it('drops a message whose only image could not be read', async () => {
    const { api, hub, peer } = setup();
    const before = peer.frames.length;
    assert.equal(await hub.handleInbound(inbound({ files: [imageFile('F1')] })), 'dropped');
    assert.equal(peer.frames.length, before);
    await hub.drain();
    assert.match(api.posts[0].text, /could not include: F1\.png/);
  });

  it('asks older desktops to update instead of downloading', async () => {
    const { api, hub, peer } = setup(['status', 'approvals', 'commands']);
    api.files.set(url('F1/download'), PNG);
    assert.equal(await hub.handleInbound(inbound({ files: [imageFile('F1')] })), 'dropped');
    assert.equal(
      await hub.handleInbound(inbound({ text: 'and this', files: [imageFile('F1')] })),
      'delivered'
    );
    assert.equal(peer.frames.at(-1)!.images, undefined);
    assert.deepEqual(api.downloads, []);
    await hub.drain();
    assert.equal(api.posts.length, 2);
    assert.match(api.posts[0].text, /Update York IE GrowthOS/);
  });

  it('keeps message order while an image downloads', async () => {
    const { api, hub, peer } = setup();
    api.files.set(url('F1/download'), PNG);
    let release!: () => void;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const download = api.downloadFile.bind(api);
    api.downloadFile = async (u, max) => {
      await slow;
      return download(u, max);
    };
    const first = hub.handleInbound(inbound({ text: 'image', files: [imageFile('F1')] }));
    const second = hub.handleInbound(inbound({ text: 'follow-up' }));
    release();
    assert.deepEqual(await Promise.all([first, second]), ['delivered', 'delivered']);
    assert.deepEqual(
      peer.frames.filter((f) => f.type === 'event').map((f) => f.text),
      ['image', 'follow-up']
    );
  });
});
