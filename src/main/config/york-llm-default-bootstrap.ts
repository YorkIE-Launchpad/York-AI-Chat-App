/**
 * One-shot migration / bootstrap: legacy Auto + openrouter/free (and empty model)
 * → York LLM. Does not force-migrate intentional Claude/GPT/Gemini picks.
 */
import {
  shouldMigrateToYorkLlmDefault,
  yorkLlmSelectionPayload,
} from '../../shared/york-llm-config';
import { log, logWarn } from '../utils/logger';
import { configStore } from './config-store';
import { listYorkLlmModels } from './york-llm-api';

let bootstrapStarted = false;

export async function bootstrapYorkLlmDefault(): Promise<void> {
  if (bootstrapStarted) return;
  bootstrapStarted = true;

  const current = configStore.getAll();
  if (!shouldMigrateToYorkLlmDefault(current.model, current.provider)) {
    return;
  }

  try {
    const models = await listYorkLlmModels({ forceRefresh: true });
    const first = models[0];
    if (!first?.id) {
      // Keep York provider/baseUrl with empty model — do not fall back to OpenRouter.
      const yorkShape = yorkLlmSelectionPayload('');
      configStore.update({
        ...yorkShape,
        isConfigured: false,
      });
      logWarn(
        '[Config] York LLM default migration: listing returned no models; kept York shape without model id'
      );
      return;
    }

    const payload = yorkLlmSelectionPayload(first.id);
    configStore.update({
      ...payload,
      isConfigured: true,
    });
    log(`[Config] Migrated default model to York LLM: ${first.id}`);
  } catch (error) {
    const yorkShape = yorkLlmSelectionPayload('');
    configStore.update({
      ...yorkShape,
      isConfigured: false,
    });
    logWarn('[Config] York LLM default migration listing failed; kept York shape:', error);
  }
}
