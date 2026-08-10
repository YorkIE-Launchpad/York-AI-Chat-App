/**
 * Wiki tools extension — registers wiki_search/read/list when memory is enabled.
 * Session Incognito (memoryEnabled false) skips tool injection.
 */
import type {
  AgentRuntimeExtension,
  BeforeSessionRunResult,
} from '../extensions/agent-runtime-extension';
import type { WikiService } from './wiki-service';
import { createWikiTools } from './wiki-tools';

export class WikiExtension implements AgentRuntimeExtension {
  readonly name = 'wiki';

  constructor(private readonly wikiService: WikiService) {}

  async beforeSessionRun({
    session,
  }: Parameters<NonNullable<AgentRuntimeExtension['beforeSessionRun']>>[0]): Promise<BeforeSessionRunResult | void> {
    // Incognito sessions have memoryEnabled false — no wiki tools / no write paths
    if (session.incognito || session.memoryEnabled === false) {
      return;
    }
    return {
      customTools: createWikiTools(this.wikiService),
    };
  }
}
