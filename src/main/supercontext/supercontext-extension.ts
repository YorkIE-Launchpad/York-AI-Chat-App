/**
 * SuperContextExtension — injects pre-turn scout prefix via beforeSessionRun.
 * Fully disabled for Incognito sessions.
 */
import type {
  AgentRuntimeExtension,
  BeforeSessionRunResult,
} from '../extensions/agent-runtime-extension';
import type { SuperContextDependencies } from './scout';
import { buildSuperContextPrefix } from './scout';

export class SuperContextExtension implements AgentRuntimeExtension {
  readonly name = 'supercontext';

  constructor(private readonly getDeps: () => SuperContextDependencies) {}

  async beforeSessionRun({
    session,
    prompt,
    isColdStart,
  }: Parameters<NonNullable<AgentRuntimeExtension['beforeSessionRun']>>[0]): Promise<BeforeSessionRunResult | void> {
    if (session.incognito || session.memoryEnabled === false) {
      return;
    }
    const promptPrefix = await buildSuperContextPrefix(
      { prompt, isColdStart },
      this.getDeps()
    );
    if (!promptPrefix) return;
    return { promptPrefix };
  }
}
