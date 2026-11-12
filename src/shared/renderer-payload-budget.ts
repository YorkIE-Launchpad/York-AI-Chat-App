import type {
  ContentBlock,
  FileAttachmentContent,
  Message,
  ServerEvent,
  TextContent,
  ThinkingContent,
  ToolResultContent,
  ToolUseContent,
  TraceStep,
} from '../renderer/types';

/**
 * Bounds for payloads that cross into the Electron renderer ("York GrowthOS Helper").
 * The main process keeps the full transcript for the model and for disk. The helper
 * only needs what the chat can show, and unbounded screenshots / tool dumps there
 * are what blow the helper past tens of gigabytes.
 */
export const RENDERER_PAYLOAD_LIMITS = {
  textBlockChars: 1_000_000,
  thinkingChars: 200_000,
  toolResultChars: 100_000,
  toolImageChars: 350_000,
  imagesPerToolResult: 1,
  keptToolImages: 4,
  contentImageChars: 4_000_000,
  keptContentImages: 30,
  inlineFileChars: 200_000,
  toolInputChars: 24_000,
  traceTextChars: 8_000,
  traceSteps: 300,
  partialChars: 1_000_000,
  partialDeltaChars: 1_000_000,
} as const;

const TEXT_TRUNCATION = '…[truncated for chat view]';
const SCREENSHOT_OMITTED = '\n[screenshot omitted from chat view]';
const EARLIER_IMAGE_OMITTED = '[earlier image omitted from chat view]';
const PARTIAL_TRUNCATION = '\n…[stream truncated for chat view]';

function capString(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= TEXT_TRUNCATION.length) return TEXT_TRUNCATION.slice(0, max);
  return value.slice(0, max - TEXT_TRUNCATION.length) + TEXT_TRUNCATION;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function slimUnknown(value: unknown, budget: { left: number }, depth: number): unknown {
  if (depth > 6) return '[nested value omitted]';
  if (typeof value === 'string') {
    if (value.length <= budget.left) {
      budget.left -= value.length;
      return value;
    }
    const sliced = capString(value, Math.max(0, budget.left));
    budget.left = 0;
    return sliced;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) {
    return value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.slice(0, 40).map((item) => {
      const next = slimUnknown(item, budget, depth + 1);
      if (next !== item) changed = true;
      return next;
    });
    if (value.length > 40) changed = true;
    return changed || items.length !== value.length ? items : value;
  }
  if (!isRecord(value)) return String(value);

  let changed = false;
  let keys = 0;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (keys >= 40) {
      out._truncated = true;
      changed = true;
      break;
    }
    keys += 1;
    if (
      (key === 'data' || key === 'base64' || key === 'inlineDataBase64') &&
      typeof nested === 'string' &&
      nested.length > 256
    ) {
      out[key] = `[omitted ${nested.length} chars]`;
      changed = true;
      continue;
    }
    const next = slimUnknown(nested, budget, depth + 1);
    if (next !== nested) changed = true;
    out[key] = next;
  }
  return changed ? out : value;
}

function slimToolInput(input: Record<string, unknown>): Record<string, unknown> {
  const next = slimUnknown(input, { left: RENDERER_PAYLOAD_LIMITS.toolInputChars }, 0);
  return isRecord(next) ? next : { _omitted: 'tool input omitted' };
}

function slimToolResult(block: ToolResultContent): ContentBlock {
  let content = capString(block.content, RENDERER_PAYLOAD_LIMITS.toolResultChars);
  let changed = content !== block.content;
  const images = block.images;
  if (!images?.length) {
    return changed ? { ...block, content } : block;
  }

  const kept: NonNullable<ToolResultContent['images']> = [];
  for (const image of images) {
    if (
      kept.length >= RENDERER_PAYLOAD_LIMITS.imagesPerToolResult ||
      image.data.length > RENDERER_PAYLOAD_LIMITS.toolImageChars
    ) {
      continue;
    }
    kept.push(image);
  }
  if (kept.length !== images.length) {
    changed = true;
    if (!content.includes(SCREENSHOT_OMITTED.trim())) {
      content = `${content}${SCREENSHOT_OMITTED}`;
    }
  }
  if (!changed) return block;
  return {
    ...block,
    content,
    ...(kept.length > 0 ? { images: kept } : { images: undefined }),
  };
}

function slimContentBlock(block: ContentBlock): ContentBlock {
  switch (block.type) {
    case 'text': {
      const text = capString(block.text, RENDERER_PAYLOAD_LIMITS.textBlockChars);
      return text === block.text ? block : ({ ...block, text } satisfies TextContent);
    }
    case 'thinking': {
      const thinking = capString(block.thinking, RENDERER_PAYLOAD_LIMITS.thinkingChars);
      return thinking === block.thinking
        ? block
        : ({ ...block, thinking } satisfies ThinkingContent);
    }
    case 'tool_result':
      return slimToolResult(block);
    case 'tool_use': {
      const input = slimToolInput(block.input);
      return input === block.input ? block : ({ ...block, input } satisfies ToolUseContent);
    }
    case 'image': {
      const data = block.source?.data ?? '';
      if (data.length <= RENDERER_PAYLOAD_LIMITS.contentImageChars) return block;
      return {
        type: 'text',
        text: `[image omitted from chat view: ${Math.round(data.length / 1024)} KB]`,
      } satisfies TextContent;
    }
    case 'file_attachment': {
      const inline = block.inlineDataBase64;
      if (!inline || inline.length <= RENDERER_PAYLOAD_LIMITS.inlineFileChars) return block;
      const { inlineDataBase64: _inline, ...rest } = block;
      return rest satisfies FileAttachmentContent;
    }
    default:
      return block;
  }
}

export function slimMessageForRenderer(message: Message): Message {
  if (!Array.isArray(message.content) || message.content.length === 0) return message;
  let changed = false;
  const content = message.content.map((block) => {
    const next = slimContentBlock(block);
    if (next !== block) changed = true;
    return next;
  });
  return changed ? { ...message, content } : message;
}

function toolImageKey(messageIndex: number, blockIndex: number, imageIndex: number): string {
  return `${messageIndex}:${blockIndex}:${imageIndex}`;
}

function dropToolImages(message: Message, messageIndex: number, drop: Set<string>): Message {
  let changed = false;
  const content = message.content.map((block, blockIndex) => {
    if (block.type !== 'tool_result' || !block.images?.length) return block;
    const images = block.images.filter(
      (_image, imageIndex) => !drop.has(toolImageKey(messageIndex, blockIndex, imageIndex))
    );
    if (images.length === block.images.length) return block;
    changed = true;
    const contentText = block.content.includes(SCREENSHOT_OMITTED.trim())
      ? block.content
      : `${block.content}${SCREENSHOT_OMITTED}`;
    return {
      ...block,
      content: contentText,
      ...(images.length > 0 ? { images } : { images: undefined }),
    };
  });
  return changed ? { ...message, content } : message;
}

function dropContentImages(message: Message, drop: Set<number>): Message {
  let changed = false;
  const content = message.content.map((block, blockIndex) => {
    if (!drop.has(blockIndex) || block.type !== 'image') return block;
    changed = true;
    return { type: 'text', text: EARLIER_IMAGE_OMITTED } satisfies TextContent;
  });
  return changed ? { ...message, content } : message;
}

/**
 * Keep only the newest tool screenshots and chat images. Older base64 stays on
 * disk in the main process; the helper does not need every historical frame.
 */
export function boundMessagesForRenderer(messages: Message[]): Message[] {
  let slimChanged = false;
  const slimmed = messages.map((message) => {
    const next = slimMessageForRenderer(message);
    if (next !== message) slimChanged = true;
    return next;
  });
  const base = slimChanged ? slimmed : messages;

  const toolRefs: Array<{ messageIndex: number; blockIndex: number; imageIndex: number }> = [];
  const contentRefs: Array<{ messageIndex: number; blockIndex: number }> = [];
  base.forEach((message, messageIndex) => {
    message.content.forEach((block, blockIndex) => {
      if (block.type === 'tool_result' && block.images?.length) {
        block.images.forEach((_image, imageIndex) => {
          toolRefs.push({ messageIndex, blockIndex, imageIndex });
        });
      } else if (block.type === 'image' && block.source?.data) {
        contentRefs.push({ messageIndex, blockIndex });
      }
    });
  });

  const dropTool = new Set<string>();
  let keptTools = 0;
  for (let i = toolRefs.length - 1; i >= 0; i -= 1) {
    const ref = toolRefs[i]!;
    if (keptTools < RENDERER_PAYLOAD_LIMITS.keptToolImages) {
      keptTools += 1;
    } else {
      dropTool.add(toolImageKey(ref.messageIndex, ref.blockIndex, ref.imageIndex));
    }
  }

  const dropContent = new Map<number, Set<number>>();
  let keptContent = 0;
  for (let i = contentRefs.length - 1; i >= 0; i -= 1) {
    const ref = contentRefs[i]!;
    if (keptContent < RENDERER_PAYLOAD_LIMITS.keptContentImages) {
      keptContent += 1;
      continue;
    }
    const blocks = dropContent.get(ref.messageIndex) ?? new Set<number>();
    blocks.add(ref.blockIndex);
    dropContent.set(ref.messageIndex, blocks);
  }

  if (dropTool.size === 0 && dropContent.size === 0) return base;

  const toolMessages = new Set<number>();
  for (const key of dropTool) {
    const messageIndex = Number(key.slice(0, key.indexOf(':')));
    if (Number.isInteger(messageIndex)) toolMessages.add(messageIndex);
  }

  return base.map((message, messageIndex) => {
    let next = message;
    if (toolMessages.has(messageIndex)) {
      next = dropToolImages(next, messageIndex, dropTool);
    }
    const contentDrops = dropContent.get(messageIndex);
    if (contentDrops) {
      next = dropContentImages(next, contentDrops);
    }
    return next;
  });
}

function capPartialDelta(delta: string): string {
  return delta.length <= RENDERER_PAYLOAD_LIMITS.partialDeltaChars
    ? delta
    : delta.slice(0, RENDERER_PAYLOAD_LIMITS.partialDeltaChars);
}

export function appendCappedPartial(current: string, delta: string): string {
  const limit = RENDERER_PAYLOAD_LIMITS.partialChars;
  if (current.length >= limit) return current;
  const room = limit - current.length;
  if (delta.length <= room) return current + delta;
  const markerRoom = Math.max(0, room - PARTIAL_TRUNCATION.length);
  return current + delta.slice(0, markerRoom) + PARTIAL_TRUNCATION;
}

export function slimTraceStep(step: TraceStep): TraceStep {
  const title = step.title.length > 2_000 ? capString(step.title, 2_000) : step.title;
  const content =
    step.content && step.content.length > RENDERER_PAYLOAD_LIMITS.traceTextChars
      ? capString(step.content, RENDERER_PAYLOAD_LIMITS.traceTextChars)
      : step.content;
  const toolOutput =
    step.toolOutput && step.toolOutput.length > RENDERER_PAYLOAD_LIMITS.traceTextChars
      ? capString(step.toolOutput, RENDERER_PAYLOAD_LIMITS.traceTextChars)
      : step.toolOutput;
  const toolInput = step.toolInput ? slimToolInput(step.toolInput) : step.toolInput;
  if (
    title === step.title &&
    content === step.content &&
    toolOutput === step.toolOutput &&
    toolInput === step.toolInput
  ) {
    return step;
  }
  return { ...step, title, content, toolOutput, toolInput };
}

export function slimTraceSteps(steps: TraceStep[]): TraceStep[] {
  const sliced =
    steps.length > RENDERER_PAYLOAD_LIMITS.traceSteps
      ? steps.slice(-RENDERER_PAYLOAD_LIMITS.traceSteps)
      : steps;
  let changed = sliced !== steps;
  const next = sliced.map((step) => {
    const slim = slimTraceStep(step);
    if (slim !== step) changed = true;
    return slim;
  });
  return changed ? next : steps;
}

function slimTraceUpdates(updates: Partial<TraceStep>): Partial<TraceStep> {
  const base: TraceStep = {
    id: 'budget',
    type: updates.type ?? 'tool_call',
    status: updates.status ?? 'running',
    title: updates.title ?? '',
    timestamp: updates.timestamp ?? 0,
    ...updates,
  };
  const slim = slimTraceStep(base);
  if (slim === base) return updates;
  const next: Partial<TraceStep> = { ...updates };
  if (updates.title !== undefined) next.title = slim.title;
  if (updates.content !== undefined) next.content = slim.content;
  if (updates.toolOutput !== undefined) next.toolOutput = slim.toolOutput;
  if (updates.toolInput !== undefined) next.toolInput = slim.toolInput;
  return next;
}

export function slimServerEventForRenderer(event: ServerEvent): ServerEvent {
  switch (event.type) {
    case 'stream.message':
    case 'stream.messageUpdate': {
      const message = slimMessageForRenderer(event.payload.message);
      if (message === event.payload.message) return event;
      return { ...event, payload: { ...event.payload, message } };
    }
    case 'stream.partial': {
      const delta = capPartialDelta(event.payload.delta);
      if (delta === event.payload.delta) return event;
      return { ...event, payload: { ...event.payload, delta } };
    }
    case 'stream.thinking': {
      const delta = capPartialDelta(event.payload.delta);
      if (delta === event.payload.delta) return event;
      return { ...event, payload: { ...event.payload, delta } };
    }
    case 'trace.step': {
      const step = slimTraceStep(event.payload.step);
      if (step === event.payload.step) return event;
      return { ...event, payload: { ...event.payload, step } };
    }
    case 'trace.update': {
      const updates = slimTraceUpdates(event.payload.updates);
      if (updates === event.payload.updates) return event;
      return { ...event, payload: { ...event.payload, updates } };
    }
    default:
      return event;
  }
}
