/**
 * Summary Tree tools extension — read-only hierarchical memory.
 */
import type {
  AgentRuntimeExtension,
  BeforeSessionRunResult,
} from '../extensions/agent-runtime-extension';
import type { SummaryTreeService } from './summary-tree-service';
import { createSummaryTreeTools } from './summary-tree-tools';

export class SummaryTreeExtension implements AgentRuntimeExtension {
  readonly name = 'summary-tree';

  constructor(private readonly summaryTreeService: SummaryTreeService) {}

  async beforeSessionRun({
    session,
  }: Parameters<NonNullable<AgentRuntimeExtension['beforeSessionRun']>>[0]): Promise<
    BeforeSessionRunResult | void
  > {
    if (session.incognito || session.memoryEnabled === false) {
      return;
    }
    return {
      customTools: createSummaryTreeTools(this.summaryTreeService),
    };
  }
}
