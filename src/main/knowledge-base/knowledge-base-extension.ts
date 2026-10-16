/**
 * Knowledge base extension — lists chat/folder sources on every turn and
 * registers sources_* tools while the chat has any.
 */
import type {
  AgentRuntimeExtension,
  BeforeSessionRunResult,
} from '../extensions/agent-runtime-extension';
import type { KnowledgeBaseService } from './knowledge-base-service';
import { createKnowledgeBaseTools } from './knowledge-base-tools';

export class KnowledgeBaseExtension implements AgentRuntimeExtension {
  readonly name = 'knowledge-base';

  constructor(private readonly service: KnowledgeBaseService) {}

  async beforeSessionRun({
    session,
  }: Parameters<
    NonNullable<AgentRuntimeExtension['beforeSessionRun']>
  >[0]): Promise<BeforeSessionRunResult | void> {
    if (session.incognito) return;
    const sources = this.service.listForSession(session);
    if (sources.length === 0) return;
    return {
      promptPrefix: this.service.buildPromptPrefix(sources),
      customTools: createKnowledgeBaseTools(this.service, { id: session.id }),
    };
  }

  async onSessionDeleted({ sessionId }: { sessionId: string }): Promise<void> {
    this.service.deleteScope({ scope: 'chat', scopeId: sessionId });
  }
}
