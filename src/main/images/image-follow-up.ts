import type { ContentBlock, ImageContent, TextContent } from '../../renderer/types';

export interface ImageTurnMessage {
  role: string;
  content: ContentBlock[];
}

const MAX_PRIOR_PROMPTS = 8;
const MAX_PROMPT_CHARS = 500;

function isUsableImage(block: ContentBlock): block is ImageContent {
  return block.type === 'image' && block.source?.type === 'base64' && Boolean(block.source.data);
}

function textFromContent(content: ContentBlock[]): string {
  return content
    .filter((block): block is TextContent => block.type === 'text')
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, MAX_PROMPT_CHARS);
}

/** Most recent generated image, so a later turn can edit it instead of starting over. */
export function findLatestAssistantImage(messages: ImageTurnMessage[]): ImageContent | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'assistant') continue;
    for (let j = message.content.length - 1; j >= 0; j--) {
      const block = message.content[j];
      if (isUsableImage(block)) return block;
    }
  }
  return null;
}

function priorUserPrompts(messages: ImageTurnMessage[]): string[] {
  const prompts: string[] = [];
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const text = textFromContent(message.content);
    if (text) prompts.push(text);
  }
  return prompts.slice(-MAX_PRIOR_PROMPTS);
}

function buildEditPrompt(latestPrompt: string, earlierPrompts: string[]): string {
  const history =
    earlierPrompts.length > 0
      ? `Earlier requests:\n${earlierPrompts.map((prompt, index) => `${index + 1}. ${prompt}`).join('\n')}\n\n`
      : '';
  return `Edit the attached image. Continue that same image; do not create a new image from scratch.\n\n${history}Apply this change:\n${latestPrompt}`;
}

/**
 * When the user follows up without attaching a new image, edit the last generated
 * image and keep earlier requests in the prompt. A turn that already includes an
 * image is left unchanged so that attachment is the edit source.
 */
export function prepareImageFollowUp(input: {
  prompt: string;
  content: ContentBlock[];
  priorMessages: ImageTurnMessage[];
}): { prompt: string; content: ContentBlock[] } {
  const prompt = input.prompt.trim();
  if (input.content.some(isUsableImage)) {
    return { prompt, content: input.content };
  }

  const priorImage = findLatestAssistantImage(input.priorMessages);
  if (!priorImage) {
    return { prompt, content: input.content };
  }

  return {
    prompt: buildEditPrompt(prompt, priorUserPrompts(input.priorMessages)),
    content: [priorImage, ...input.content],
  };
}
