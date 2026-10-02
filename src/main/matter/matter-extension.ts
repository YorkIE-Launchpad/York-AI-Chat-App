/**
 * Registers Matter tools on each chat turn when the Matter service is ready.
 */
import type {
  AgentRuntimeExtension,
  BeforeSessionRunResult,
} from '../extensions/agent-runtime-extension';
import type { MatterService } from './matter-service';
import { createMatterTools } from './matter-tools';

export class MatterExtension implements AgentRuntimeExtension {
  readonly name = 'matter';

  constructor(private readonly getMatterService: () => MatterService | null) {}

  async beforeSessionRun(): Promise<BeforeSessionRunResult | void> {
    const matterService = this.getMatterService();
    if (!matterService) return;
    return {
      customTools: createMatterTools(matterService),
    };
  }
}
