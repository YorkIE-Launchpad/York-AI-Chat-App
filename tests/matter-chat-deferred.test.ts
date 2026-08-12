import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Matter chat deferred send', () => {
  it('ChatView attaches Matter context on first send and clears the draft', () => {
    const chatView = fs.readFileSync(
      path.resolve(process.cwd(), 'src/renderer/components/ChatView.tsx'),
      'utf8'
    );
    expect(chatView).toContain('matterChatDraftBySessionId');
    expect(chatView).toContain('buildChatPrompt');
    expect(chatView).toContain('clearMatterChatDraft');
    expect(chatView).toContain('matter.chatContextWaiting');
    expect(chatView).toContain('composerPrefill');
  });

  it('softens Matter prompt framing to wait for guidance', () => {
    const service = fs.readFileSync(
      path.resolve(process.cwd(), 'src/main/matter/matter-service.ts'),
      'utf8'
    );
    expect(service).toContain('wait for my guidance');
    expect(service).not.toContain(
      'Matter context (use york-os / connected tools to resolve; do not invent sources):'
    );
  });
});
