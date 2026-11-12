import { describe, expect, it } from 'vitest';
import type { Message, Session } from '../../renderer/types';
import { withNotifyUserSkillNote } from '../../main/skills/notify-user-skill-note';
import {
  NotifyUserExtension,
  buildCompletionNotice,
  isUserWatchingSession,
  parseNotifyUserParams,
  resetForegroundSessionForTests,
  setForegroundSessionId,
  type NotifyUserHost,
  type NotifyUserNotice,
} from '../../main/tools/notify-user-extension';

function session(partial: Partial<Session> = {}): Session {
  return {
    id: 's1',
    title: 'Quarterly brief',
    status: 'idle',
    mountedPaths: [],
    allowedTools: [],
    memoryEnabled: true,
    ...partial,
  } as Session;
}

function assistant(text: string, id = 'a1'): Message {
  return {
    id,
    sessionId: 's1',
    role: 'assistant',
    content: [{ type: 'text', text }],
    timestamp: 1,
  };
}

function host(overrides: Partial<NotifyUserHost> = {}): {
  host: NotifyUserHost;
  shown: NotifyUserNotice[];
} {
  const shown: NotifyUserNotice[] = [];
  return {
    shown,
    host: {
      isEnabled: () => true,
      isUserWatching: () => false,
      isLoopRunning: () => false,
      show: (notice) => shown.push(notice),
      ...overrides,
    },
  };
}

describe('parseNotifyUserParams', () => {
  it('requires a title and body', () => {
    expect(parseNotifyUserParams({})).toEqual({
      error: 'NotifyUser requires a non-empty title and body.',
    });
  });

  it('defaults level to attention and accepts complete', () => {
    expect(parseNotifyUserParams({ title: 'Done', body: 'Brief is ready.' })).toMatchObject({
      title: 'Done',
      body: 'Brief is ready.',
      level: 'attention',
    });
    expect(
      parseNotifyUserParams({ title: 'Done', body: 'Brief is ready.', level: 'complete' })
    ).toMatchObject({ level: 'complete' });
  });
});

describe('buildCompletionNotice', () => {
  it('uses the session title and the last reply', () => {
    const notice = buildCompletionNotice('Quarterly brief', [assistant('The brief is ready.')]);
    expect(notice).toEqual({
      title: 'Quarterly brief',
      body: 'The brief is ready.',
      level: 'complete',
    });
  });

  it('skips goal ticks that are still in progress', () => {
    expect(
      buildCompletionNotice('Goal', [assistant('Still polling.\nGOAL_STATUS: in_progress')])
    ).toBeNull();
  });

  it('flags errors as attention', () => {
    const notice = buildCompletionNotice('Chat', [assistant('**Error**: Hub timed out')]);
    expect(notice?.level).toBe('attention');
    expect(notice?.title).toBe('Chat needs attention');
  });
});

describe('NotifyUserExtension', () => {
  it('registers the tool', async () => {
    const { host: deps } = host();
    const extension = new NotifyUserExtension(deps);
    const result = await extension.beforeSessionRun({
      session: session(),
      prompt: 'hi',
      existingMessages: [],
      isColdStart: true,
    });
    expect(result.customTools?.[0]?.name).toBe('NotifyUser');
  });

  it('does not show a banner when notifications are off or the user is watching', () => {
    const disabled = host({ isEnabled: () => false });
    const off = new NotifyUserExtension(disabled.host);
    const offResult = off.executeNotify('s1', { title: 'Done', body: 'Ready', level: 'complete' });
    expect(offResult.content[0]?.text).toMatch(/turned off/);
    expect(disabled.shown).toHaveLength(0);

    const watching = host({ isUserWatching: () => true });
    const look = new NotifyUserExtension(watching.host);
    const lookResult = look.executeNotify('s1', { title: 'Done', body: 'Ready' });
    expect(lookResult.content[0]?.text).toMatch(/looking at the app/);
    expect(watching.shown).toHaveLength(0);
  });

  it('sends one notification and does not send another when the turn ends', async () => {
    const { host: deps, shown } = host();
    const extension = new NotifyUserExtension(deps);
    const sent = extension.executeNotify('s1', {
      title: 'Brief ready',
      body: 'Quarterly brief is in chat.',
      level: 'complete',
    });
    expect(sent.content[0]?.text).toMatch(/Notification sent/);
    expect(shown).toEqual([
      {
        sessionId: 's1',
        title: 'Brief ready',
        body: 'Quarterly brief is in chat.',
        level: 'complete',
      },
    ]);

    await extension.afterSessionRun({
      session: session(),
      prompt: 'prep the brief',
      messages: [assistant('Quarterly brief is in chat.')],
    });
    expect(shown).toHaveLength(1);
  });

  it('notifies when a turn finishes and the user is away', async () => {
    const { host: deps, shown } = host();
    const extension = new NotifyUserExtension(deps);
    await extension.afterSessionRun({
      session: session(),
      prompt: 'prep the brief',
      messages: [assistant('The brief is ready.')],
    });
    expect(shown).toEqual([
      {
        sessionId: 's1',
        title: 'Quarterly brief',
        body: 'The brief is ready.',
        level: 'complete',
      },
    ]);
  });

  it('stays quiet for an in-progress goal and for a running loop', async () => {
    const running = host({ isLoopRunning: () => true });
    const extension = new NotifyUserExtension(running.host);
    await extension.afterSessionRun({
      session: session(),
      prompt: 'continue',
      messages: [assistant('Polled preview.\nGOAL_STATUS: in_progress')],
    });
    await extension.afterSessionRun({
      session: session(),
      prompt: 'continue',
      messages: [assistant('Checked the interval loop.')],
    });
    expect(running.shown).toHaveLength(0);

    await extension.afterSessionRun({
      session: session(),
      prompt: 'continue',
      messages: [assistant('Shipped.\nGOAL_STATUS: complete')],
    });
    expect(running.shown).toHaveLength(1);
    expect(running.shown[0]?.body).toBe('Shipped.');
  });

  it('skips the completion notice when the turn was stopped or more work is queued', async () => {
    const { host: deps, shown } = host();
    const extension = new NotifyUserExtension(deps);
    await extension.afterSessionRun({
      session: session(),
      prompt: 'go',
      messages: [assistant('Partial.')],
      suppressCompletionNotice: true,
    });
    expect(shown).toHaveLength(0);
  });
});

describe('isUserWatchingSession', () => {
  it('treats a focused window as watching until the renderer reports, then only the open chat', () => {
    resetForegroundSessionForTests();
    expect(isUserWatchingSession('s1', false)).toBe(false);
    expect(isUserWatchingSession('s1', true)).toBe(true);

    setForegroundSessionId('s1');
    expect(isUserWatchingSession('s1', true)).toBe(true);
    expect(isUserWatchingSession('s2', true)).toBe(false);

    setForegroundSessionId(null);
    expect(isUserWatchingSession('s1', true)).toBe(false);
    resetForegroundSessionForTests();
  });
});

describe('withNotifyUserSkillNote', () => {
  it('appends the notification section once', () => {
    const once = withNotifyUserSkillNote('# Do the work');
    expect(once).toContain('NotifyUser');
    expect(withNotifyUserSkillNote(once)).toBe(once);
  });
});
