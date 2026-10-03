import { describe, expect, it } from 'vitest';
import { prepareImageFollowUp } from '../../main/images/image-follow-up';
import type { ContentBlock } from '../../renderer/types';

function image(data: string): ContentBlock {
  return {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data },
  };
}

describe('prepareImageFollowUp', () => {
  it('leaves the first prompt unchanged when there is no prior image', () => {
    const content: ContentBlock[] = [{ type: 'text', text: 'A red apple' }];
    expect(
      prepareImageFollowUp({
        prompt: 'A red apple',
        content,
        priorMessages: [],
      })
    ).toEqual({ prompt: 'A red apple', content });
  });

  it('edits the last generated image and keeps earlier requests', () => {
    const priorImage = image('previous-png');
    const content: ContentBlock[] = [{ type: 'text', text: 'make the background white' }];

    const prepared = prepareImageFollowUp({
      prompt: 'make the background white',
      content,
      priorMessages: [
        { role: 'user', content: [{ type: 'text', text: 'A blue bird logo' }] },
        { role: 'assistant', content: [priorImage] },
      ],
    });

    expect(prepared.content[0]).toEqual(priorImage);
    expect(prepared.content).toHaveLength(2);
    expect(prepared.prompt).toContain('do not create a new image');
    expect(prepared.prompt).toContain('A blue bird logo');
    expect(prepared.prompt).toContain('make the background white');
  });

  it('uses a newly attached image instead of the previous result', () => {
    const attached = image('attached');
    const content: ContentBlock[] = [attached, { type: 'text', text: 'crop tighter' }];

    const prepared = prepareImageFollowUp({
      prompt: 'crop tighter',
      content,
      priorMessages: [{ role: 'assistant', content: [image('previous')] }],
    });

    expect(prepared.prompt).toBe('crop tighter');
    expect(prepared.content).toEqual(content);
  });

  it('uses the newest assistant image when several turns exist', () => {
    const newest = image('newest');
    const prepared = prepareImageFollowUp({
      prompt: 'add a hat',
      content: [{ type: 'text', text: 'add a hat' }],
      priorMessages: [
        { role: 'assistant', content: [image('oldest')] },
        { role: 'user', content: [{ type: 'text', text: 'brighter' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'done' }, newest] },
      ],
    });

    expect(prepared.content[0]).toEqual(newest);
    expect(prepared.prompt).toContain('brighter');
  });
});
