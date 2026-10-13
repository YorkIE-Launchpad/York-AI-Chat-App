/**
 * `do_on_screen`: reach a goal described in plain words ("change the project
 * to Hub", "search for invoices") by looking at the screen and taking one
 * pointer/keyboard step at a time until the vision model says it is done.
 */
import type { ScreenSnapImage } from '../../shared/screen-snap';
import type { VoiceActionResult } from '../../shared/voice-control';
import { pasteText } from '../snap/paste-into-app';
import { log } from '../utils/logger';
import {
  captureVoiceScreenshot,
  clickAtPoint,
  formatHistory,
  imagePointToScreen,
  LOCATE_MAX_EDGE,
  screenPermissionBlock,
  scrollAtPoint,
  str,
  type VoiceScreenDeps,
} from './screen-context';

export const MAX_AGENT_STEPS = 8;
/** Lets menus open, pages load, and lists filter before the next screenshot. */
const SETTLE_MS: Record<'click' | 'type' | 'key' | 'scroll', number> = {
  click: 700,
  type: 350,
  key: 500,
  scroll: 400,
};
const STUCK_REPEATS = 3;
const STUCK_RADIUS = 12;

export type AgentStep =
  | { action: 'click'; x: number; y: number; element: string; risky: boolean }
  | { action: 'type'; text: string; element: string }
  | { action: 'key'; keys: string; risky: boolean }
  | { action: 'scroll'; direction: 'up' | 'down'; x: number; y: number }
  | { action: 'done'; summary: string }
  | { action: 'fail'; reason: string };

export function agentSystemPrompt(
  image: Pick<ScreenSnapImage, 'width' | 'height'>,
  goal: string,
  history: string[],
  steps: string[]
): string {
  return [
    "You operate the user's Mac by looking at a screenshot and choosing the single next step toward the goal.",
    `The screenshot is ${image.width}x${image.height} pixels, origin top-left. Coordinates are image pixels.`,
    '',
    `Goal: ${goal}`,
    '',
    'Earlier in this voice session (use it to understand references like "this", "that one", "the other project"):',
    formatHistory(history),
    '',
    'Steps already taken for this goal:',
    steps.length > 0
      ? steps.map((step, index) => `${index + 1}. ${step}`).join('\n')
      : '(none yet)',
    '',
    'Reply with exactly one JSON object and nothing else:',
    '{"action":"click","x":<int>,"y":<int>,"element":"<what you click>","risky":<bool>}',
    '{"action":"type","text":"<text>","element":"<field>"}  (types into the focused field; click the field first if it is not focused)',
    '{"action":"key","keys":"<e.g. enter, escape, tab, down, cmd+a>","risky":<bool>}',
    '{"action":"scroll","direction":"up|down","x":<int>,"y":<int>}  (x,y inside the area to scroll)',
    '{"action":"done","summary":"<what was achieved, under 10 words>"}',
    '{"action":"fail","reason":"<why the goal cannot be reached from this screen>"}',
    '',
    'Rules:',
    '- Dropdowns, pickers and menus: click to open them, then click the option in the next screenshot. If a list has a filter box, type to narrow it.',
    '- Click the centre of the element. Prefer visible controls over keyboard shortcuts.',
    '- Reply done as soon as the screenshot shows the goal is reached. Do nothing beyond the goal.',
    '- risky=true when the step sends or posts a message, submits a form, deletes, buys, closes, or signs out.',
    '- Pressing enter to run a search or pick a highlighted option is not risky.',
    '- If the same step did not change anything, try something different or fail.',
  ].join('\n');
}

function num(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function inImage(x: number, y: number, image: Pick<ScreenSnapImage, 'width' | 'height'>) {
  return x >= 0 && y >= 0 && x <= image.width && y <= image.height;
}

/** Parses the model reply; tolerates code fences or prose around the JSON. */
export function parseAgentStep(
  text: string,
  image: Pick<ScreenSnapImage, 'width' | 'height'>
): AgentStep {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { action: 'fail', reason: 'The model did not choose a step.' };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return { action: 'fail', reason: 'The model returned an unreadable step.' };
  }
  const action = str(parsed.action);
  const x = num(parsed.x);
  const y = num(parsed.y);
  switch (action) {
    case 'click':
      if (x === null || y === null || !inImage(x, y, image)) {
        return { action: 'fail', reason: 'The model pointed outside the screen.' };
      }
      return {
        action,
        x,
        y,
        element: str(parsed.element) || 'element',
        risky: parsed.risky === true,
      };
    case 'type': {
      const textValue = typeof parsed.text === 'string' ? parsed.text : '';
      if (!textValue) return { action: 'fail', reason: 'The model chose to type nothing.' };
      return { action, text: textValue, element: str(parsed.element) || 'field' };
    }
    case 'key': {
      const keys = str(parsed.keys);
      if (!keys) return { action: 'fail', reason: 'The model chose no keys.' };
      return { action, keys, risky: parsed.risky === true };
    }
    case 'scroll': {
      const direction = parsed.direction === 'up' ? 'up' : 'down';
      return {
        action,
        direction,
        x: x !== null && inImage(x, y ?? 0, image) ? x : image.width / 2,
        y: y !== null && inImage(x ?? 0, y, image) ? y : image.height / 2,
      };
    }
    case 'done':
      return { action, summary: str(parsed.summary) || 'Done.' };
    case 'fail':
      return { action, reason: str(parsed.reason) || 'Could not do that on this screen.' };
    default:
      return { action: 'fail', reason: `Unknown step "${action}".` };
  }
}

function describeStep(step: AgentStep): string {
  switch (step.action) {
    case 'click':
      return `clicked ${step.element}`;
    case 'type':
      return `typed "${step.text}" into ${step.element}`;
    case 'key':
      return `pressed ${step.keys}`;
    case 'scroll':
      return `scrolled ${step.direction}`;
    case 'done':
      return step.summary;
    case 'fail':
      return step.reason;
  }
}

function progressFor(step: AgentStep): string {
  switch (step.action) {
    case 'click':
      return `Clicking ${step.element}…`;
    case 'type':
      return `Typing into ${step.element}…`;
    case 'key':
      return `Pressing ${step.keys}…`;
    case 'scroll':
      return `Scrolling ${step.direction}…`;
    default:
      return 'Finishing…';
  }
}

function sameClick(a: AgentStep | undefined, b: AgentStep): boolean {
  return (
    a?.action === 'click' &&
    b.action === 'click' &&
    Math.abs(a.x - b.x) <= STUCK_RADIUS &&
    Math.abs(a.y - b.y) <= STUCK_RADIUS
  );
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function doOnScreen(
  rawArgs: Record<string, unknown>,
  deps: VoiceScreenDeps
): Promise<VoiceActionResult> {
  const goal = str(rawArgs.goal);
  if (!goal) return { ok: false, message: 'Say what to do on screen.' };
  const blocked = screenPermissionBlock(deps);
  if (blocked) return blocked;

  const confirmed = rawArgs.confirmed === true;
  const capture = deps.capture ?? ((edge: number) => captureVoiceScreenshot(edge));
  const click = deps.click ?? ((x: number, y: number) => clickAtPoint(x, y).then(() => undefined));
  const scroll =
    deps.scroll ??
    ((x: number, y: number, direction: 'up' | 'down') =>
      scrollAtPoint(x, y, direction).then(() => undefined));
  const paste = deps.pasteText ?? ((text: string) => pasteText(text));
  const sleep = deps.sleep ?? defaultSleep;
  const history = deps.getHistory?.() ?? [];
  const taken: string[] = [];
  const recentClicks: AgentStep[] = [];

  const summarySoFar = () => (taken.length > 0 ? ` So far: ${taken.join(', ')}.` : '');

  deps.onProgress?.('Looking at the screen…');
  for (let index = 0; index < MAX_AGENT_STEPS; index += 1) {
    const shot = await capture(LOCATE_MAX_EDGE);
    const reply = await deps.ask(
      'Choose the next step.',
      agentSystemPrompt(shot.image, goal, history, taken),
      shot.image,
      300
    );
    const step = parseAgentStep(reply, shot.image);
    log('[Voice] Screen step', index + 1, step.action, describeStep(step));

    if (step.action === 'done') return { ok: true, message: step.summary };
    if (step.action === 'fail') {
      return { ok: false, message: `${step.reason}${summarySoFar()}` };
    }

    const dangerous = step.action === 'key' && deps.isDangerousKeys?.(step.keys) === true;
    if ((('risky' in step && step.risky) || dangerous) && !confirmed) {
      return {
        ok: false,
        needsConfirmation: true,
        message: `Next step would be: ${describeStep(step)}.${summarySoFar()} Ask the user to say "confirm".`,
      };
    }

    if (step.action === 'click') {
      if (
        recentClicks.length >= STUCK_REPEATS - 1 &&
        recentClicks.slice(-(STUCK_REPEATS - 1)).every((prev) => sameClick(prev, step))
      ) {
        return {
          ok: false,
          message: `Clicking ${step.element} is not changing anything.${summarySoFar()}`,
        };
      }
      recentClicks.push(step);
    }

    deps.onProgress?.(progressFor(step));
    switch (step.action) {
      case 'click': {
        const point = imagePointToScreen(step, shot.image, shot.frame);
        await click(point.x, point.y);
        break;
      }
      case 'type': {
        const pasted = await paste(step.text);
        if (!pasted.success) {
          return { ok: false, message: `Could not type into ${step.element}.${summarySoFar()}` };
        }
        break;
      }
      case 'key':
        if (!deps.pressKeys) return { ok: false, message: 'Key presses are unavailable.' };
        await deps.pressKeys(step.keys);
        break;
      case 'scroll': {
        const point = imagePointToScreen(step, shot.image, shot.frame);
        await scroll(point.x, point.y, step.direction);
        break;
      }
    }
    taken.push(describeStep(step));
    await sleep(SETTLE_MS[step.action]);
  }
  return { ok: false, message: `Ran out of steps before finishing.${summarySoFar()}` };
}
