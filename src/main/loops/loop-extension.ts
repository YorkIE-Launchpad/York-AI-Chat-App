/**
 * Registers Loop tools on each chat turn when the Loops service is ready.
 */
import type {
  AgentRuntimeExtension,
  BeforeSessionRunResult,
} from '../extensions/agent-runtime-extension';
import type { LoopService } from './loop-service';
import { createLoopTools } from './loop-tools';

export class LoopExtension implements AgentRuntimeExtension {
  readonly name = 'loops';

  constructor(private readonly getLoopService: () => LoopService | null) {}

  async beforeSessionRun(): Promise<BeforeSessionRunResult | void> {
    const loopService = this.getLoopService();
    if (!loopService) return;
    return {
      customTools: createLoopTools(loopService),
    };
  }
}
