/**
 * Attaches the brainstorm playbook and board tools only on brainstorm sessions.
 */
import type {
  AgentRuntimeExtension,
  BeforeSessionRunContext,
  BeforeSessionRunResult,
  SessionDeletedContext,
} from '../extensions/agent-runtime-extension';
import type { BrainstormService } from './brainstorm-service';
import { buildBrainstormPlaybook, type ConnectedToolRef } from './brainstorm-prompt';
import { createBrainstormTools } from './brainstorm-tools';

export class BrainstormExtension implements AgentRuntimeExtension {
  readonly name = 'brainstorm';

  constructor(
    private readonly getService: () => BrainstormService | null,
    private readonly listConnectedTools: () => ConnectedToolRef[] = () => []
  ) {}

  async beforeSessionRun(context: BeforeSessionRunContext): Promise<BeforeSessionRunResult | void> {
    if (context.session.kind !== 'brainstorm') return;
    const service = this.getService();
    if (!service) return;
    const detail = service.getBySessionId(context.session.id);
    if (!detail) return;
    return {
      promptPrefix: buildBrainstormPlaybook(detail, this.listConnectedTools()),
      customTools: createBrainstormTools(service, context.session.id),
    };
  }

  async onSessionDeleted(context: SessionDeletedContext): Promise<void> {
    if (context.session?.kind !== 'brainstorm') return;
    this.getService()?.forgetSession(context.sessionId);
  }
}
