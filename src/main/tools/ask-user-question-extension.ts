/**
 * @module main/tools/ask-user-question-extension
 *
 * Native AskUserQuestion tool: pauses the agent for Cursor-style A/B/C/D
 * clarifying questions (one Recommended), with a hard cap of 2 asks per run.
 */
import { Type } from '@sinclair/typebox';
import { v4 as uuidv4 } from 'uuid';
import type {
  AgentRuntimeExtension,
  BeforeSessionRunContext,
  BeforeSessionRunResult,
  AgentRuntimeCustomTool,
} from '../extensions/agent-runtime-extension';
import type {
  QuestionItem,
  QuestionOption,
  ServerEvent,
  UserQuestionRequest,
} from '../../renderer/types';
import { log, logWarn } from '../utils/logger';

export const ASK_USER_QUESTION_MAX_PER_RUN = 2;
export const ASK_USER_QUESTION_TIMEOUT_MS = 5 * 60 * 1000;

const INVALID_ROOT_KEYS = new Set(['type', 'header', 'multiSelect']);

type PendingQuestion = {
  questionId: string;
  sessionId: string;
  toolUseId: string;
  resolve: (result: AskResult) => void;
  timeout: NodeJS.Timeout;
};

type AskResult =
  | { kind: 'answered'; answersJson: string }
  | { kind: 'cancelled'; reason: string }
  | { kind: 'timeout' };

export type AskUserQuestionSendEvent = (event: ServerEvent) => void;

function optionSchema() {
  return Type.Object({
    label: Type.String({ description: 'Short option label shown to the user.' }),
    description: Type.Optional(
      Type.String({ description: 'Optional one-line explanation of the option.' })
    ),
    recommended: Type.Optional(
      Type.Boolean({
        description: 'Mark exactly one option as recommended (preselected in the UI).',
      })
    ),
  });
}

function questionSchema() {
  return Type.Object({
    question: Type.String({ description: 'The clarifying question to ask.' }),
    header: Type.Optional(Type.String({ description: 'Short category label for the question.' })),
    multiSelect: Type.Optional(
      Type.Boolean({ description: 'When true, the user may select multiple options.' })
    ),
    options: Type.Optional(
      Type.Array(optionSchema(), {
        description: '2–4 choices (A/B/C/D). Prefer options over free-text when possible.',
        minItems: 0,
        maxItems: 6,
      })
    ),
  });
}

export function getInvalidAskUserQuestionRootKeys(input: unknown): string[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return [];
  }
  return Object.keys(input as Record<string, unknown>).filter((key) => INVALID_ROOT_KEYS.has(key));
}

export function sanitizeAskUserQuestions(input: unknown): QuestionItem[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return [];
  }
  const root = input as Record<string, unknown>;
  const rawQuestions = root.questions;
  if (!Array.isArray(rawQuestions)) {
    return [];
  }

  const questions: QuestionItem[] = [];
  for (const raw of rawQuestions) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      continue;
    }
    const q = raw as Record<string, unknown>;
    const questionText = typeof q.question === 'string' ? q.question.trim() : '';
    if (!questionText) {
      continue;
    }

    const options: QuestionOption[] = [];
    if (Array.isArray(q.options)) {
      for (const rawOpt of q.options) {
        if (!rawOpt || typeof rawOpt !== 'object' || Array.isArray(rawOpt)) {
          continue;
        }
        const opt = rawOpt as Record<string, unknown>;
        const label = typeof opt.label === 'string' ? opt.label.trim() : '';
        if (!label) {
          continue;
        }
        options.push({
          label,
          description:
            typeof opt.description === 'string' && opt.description.trim()
              ? opt.description.trim()
              : undefined,
          recommended: opt.recommended === true ? true : undefined,
        });
      }
    }

    // Ensure at most one recommended when options exist
    let seenRecommended = false;
    for (const opt of options) {
      if (opt.recommended) {
        if (seenRecommended) {
          opt.recommended = undefined;
        } else {
          seenRecommended = true;
        }
      }
    }
    if (options.length > 0 && !seenRecommended) {
      options[0].recommended = true;
    }

    questions.push({
      question: questionText,
      header: typeof q.header === 'string' && q.header.trim() ? q.header.trim() : undefined,
      multiSelect: q.multiSelect === true,
      options: options.length > 0 ? options : undefined,
    });
  }

  return questions;
}

export function normalizeAskUserAnswers(
  answersJson: string,
  questions: QuestionItem[]
): Record<string, string[]> {
  if (!answersJson.trim()) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(answersJson);
  } catch {
    return {};
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }

  const rawAnswers = parsed as Record<string, unknown>;
  const normalized: Record<string, string[]> = {};

  for (const [rawKey, rawValue] of Object.entries(rawAnswers)) {
    const index = Number(rawKey);
    if (!Number.isInteger(index) || index < 0 || index >= questions.length) {
      continue;
    }

    let values: string[] = [];
    if (typeof rawValue === 'string' && rawValue.trim()) {
      values = [rawValue.trim()];
    } else if (Array.isArray(rawValue)) {
      values = rawValue
        .filter((v): v is string => typeof v === 'string')
        .map((v) => v.trim())
        .filter(Boolean);
    }

    if (values.length === 0) {
      continue;
    }

    const question = questions[index];
    if (question.options && question.options.length > 0 && !question.multiSelect) {
      values = [values[0]];
    }

    normalized[String(index)] = values;
  }

  return normalized;
}

function createAskUserQuestionTool(
  extension: AskUserQuestionExtension,
  sessionId: string
): AgentRuntimeCustomTool {
  return {
    name: 'AskUserQuestion',
    label: 'AskUserQuestion',
    description:
      'Ask the user a clarifying multiple-choice question when a critical detail is missing and ' +
      'would change the next action. Prefer reasonable assumptions when safe. ' +
      'Provide 2–4 options (A/B/C/D) and mark exactly one with recommended: true. ' +
      'Ask at most once per turn (twice max if the first answer still leaves a critical fork). ' +
      'Bundle related decisions into one multi-question call. After answers, proceed — do not re-ask.',
    parameters: Type.Object({
      questions: Type.Array(questionSchema(), {
        description: 'One or more clarifying questions (prefer a single bundled form).',
        minItems: 1,
        maxItems: 4,
      }),
    }),
    async execute(toolCallId: string, params: unknown) {
      return extension.executeAsk(sessionId, toolCallId, params);
    },
  };
}

export class AskUserQuestionExtension implements AgentRuntimeExtension {
  readonly name = 'ask-user-question';

  private readonly pending = new Map<string, PendingQuestion>();
  private readonly asksThisRun = new Map<string, number>();

  constructor(private readonly sendToRenderer: AskUserQuestionSendEvent) {}

  async beforeSessionRun(context: BeforeSessionRunContext): Promise<BeforeSessionRunResult> {
    this.asksThisRun.set(context.session.id, 0);
    return {
      customTools: [createAskUserQuestionTool(this, context.session.id)],
    };
  }

  async executeAsk(
    sessionId: string,
    toolCallId: string,
    params: unknown
  ): Promise<{ content: Array<{ type: 'text'; text: string }>; details: unknown }> {
    const askCount = this.asksThisRun.get(sessionId) ?? 0;
    if (askCount >= ASK_USER_QUESTION_MAX_PER_RUN) {
      logWarn(
        `[AskUserQuestion] Ask budget exhausted for session ${sessionId} (count=${askCount})`
      );
      return {
        content: [
          {
            type: 'text',
            text:
              'Error: Ask budget exhausted (max 2 AskUserQuestion calls per turn). ' +
              'Proceed with your recommended assumptions; do not ask again.',
          },
        ],
        details: undefined,
      };
    }

    const invalidRoot = getInvalidAskUserQuestionRootKeys(params);
    if (invalidRoot.length > 0) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: Invalid AskUserQuestion root keys: ${invalidRoot.join(', ')}. Put header/multiSelect inside each question item.`,
          },
        ],
        details: undefined,
      };
    }

    const questions = sanitizeAskUserQuestions(params);
    if (questions.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'Error: AskUserQuestion requires a non-empty questions array with valid question text.',
          },
        ],
        details: undefined,
      };
    }

    this.asksThisRun.set(sessionId, askCount + 1);

    const questionId = uuidv4();
    const toolUseId = toolCallId || questionId;

    const request: UserQuestionRequest = {
      questionId,
      sessionId,
      toolUseId,
      questions,
    };

    const result = await new Promise<AskResult>((resolve) => {
      const timeout = setTimeout(() => {
        const pending = this.pending.get(questionId);
        if (!pending) {
          return;
        }
        this.pending.delete(questionId);
        this.sendToRenderer({
          type: 'question.dismiss',
          payload: { questionId, sessionId },
        });
        resolve({ kind: 'timeout' });
      }, ASK_USER_QUESTION_TIMEOUT_MS);

      this.pending.set(questionId, {
        questionId,
        sessionId,
        toolUseId,
        resolve,
        timeout,
      });

      this.sendToRenderer({
        type: 'question.request',
        payload: request,
      });

      log(`[AskUserQuestion] Waiting for answer: ${questionId} (session=${sessionId})`);
    });

    if (result.kind === 'answered') {
      const normalized = normalizeAskUserAnswers(result.answersJson, questions);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ answers: normalized, questions }, null, 2),
          },
        ],
        details: undefined,
      };
    }

    if (result.kind === 'timeout') {
      return {
        content: [
          {
            type: 'text',
            text:
              'Error: AskUserQuestion timed out waiting for the user. ' +
              'Proceed with your recommended assumptions; do not ask again.',
          },
        ],
        details: undefined,
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: `Error: AskUserQuestion cancelled (${result.reason}). Proceed with recommended assumptions if still actionable; do not ask again.`,
        },
      ],
      details: undefined,
    };
  }

  handleQuestionResponse(questionId: string, answer: string): boolean {
    const pending = this.pending.get(questionId);
    if (!pending) {
      logWarn(`[AskUserQuestion] No pending question for ID: ${questionId}`);
      return false;
    }
    clearTimeout(pending.timeout);
    this.pending.delete(questionId);
    pending.resolve({ kind: 'answered', answersJson: answer });
    return true;
  }

  /** Cancel a single pending question (remote send failure, etc.). */
  cancelQuestion(questionId: string, reason: string): boolean {
    const pending = this.pending.get(questionId);
    if (!pending) {
      return false;
    }
    clearTimeout(pending.timeout);
    this.pending.delete(questionId);
    this.sendToRenderer({
      type: 'question.dismiss',
      payload: { questionId, sessionId: pending.sessionId },
    });
    pending.resolve({ kind: 'cancelled', reason });
    return true;
  }

  dismissSessionQuestions(sessionId: string, reason = 'session stopped'): void {
    for (const [questionId, pending] of [...this.pending.entries()]) {
      if (pending.sessionId !== sessionId) {
        continue;
      }
      clearTimeout(pending.timeout);
      this.pending.delete(questionId);
      this.sendToRenderer({
        type: 'question.dismiss',
        payload: { questionId, sessionId },
      });
      pending.resolve({ kind: 'cancelled', reason });
    }
    this.asksThisRun.delete(sessionId);
  }
}
