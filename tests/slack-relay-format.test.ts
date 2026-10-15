import { describe, expect, it } from 'vitest';
import { parseSlackTextCommand } from '../src/main/remote/channels/slack/slack-relay-format';

describe('parseSlackTextCommand', () => {
  it('treats a bare help as the help command', () => {
    expect(parseSlackTextCommand('help')).toEqual({ name: 'help' });
    expect(parseSlackTextCommand('  HELP? ')).toEqual({ name: 'help' });
    expect(parseSlackTextCommand('?')).toEqual({ name: 'help' });
  });

  it('parses /growth and /growthos typed as text', () => {
    expect(parseSlackTextCommand('/growth')).toEqual({ name: 'help' });
    expect(parseSlackTextCommand('/growthOS help')).toEqual({ name: 'help' });
    expect(parseSlackTextCommand('/growthos ls')).toEqual({ name: 'chats' });
    expect(parseSlackTextCommand('/growth cancel')).toEqual({ name: 'stop' });
    expect(parseSlackTextCommand('/growth new plan the offsite')).toEqual({
      name: 'new',
      arg: 'plan the offsite',
    });
    expect(parseSlackTextCommand('/growth dance')).toEqual({ name: 'help' });
  });

  it('leaves normal messages for the agent', () => {
    expect(parseSlackTextCommand('help me write a memo')).toBeNull();
    expect(parseSlackTextCommand('what is /growth?')).toBeNull();
    expect(parseSlackTextCommand('/growthhacking ideas')).toBeNull();
  });
});
