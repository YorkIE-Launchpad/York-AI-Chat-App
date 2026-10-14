/**
 * Voice `set_model` / `get_model`: match a spoken model name against the
 * models the user may pick in the GrowthOS model selector and switch to it.
 */
import { AUTO_MODEL_ID, isAutoModelId } from '../../shared/auto-model';
import {
  applyBackendManagedCredentials,
  BACKEND_PROXY_PLACEHOLDER_KEY,
  type BackendModelInfo,
} from '../../shared/backend-config';
import { isGptImage25ModelId } from '../../shared/image-generation';
import type { VoiceActionResult } from '../../shared/voice-control';
import type { AppConfig } from '../config/config-store';

const FILLER_WORDS = new Set([
  'the',
  'a',
  'model',
  'to',
  'use',
  'switch',
  'change',
  'please',
  'version',
  'point',
]);
const AUTO_WORDS = new Set(['auto', 'automatic', 'default']);
const MAX_OPTIONS = 5;

export interface VoiceModelDeps {
  listModels: () => Promise<BackendModelInfo[]>;
  getConfig: () => AppConfig;
  /** Persist like `config.save` (syncs the runner and the renderer). */
  saveConfig: (partial: Partial<AppConfig>) => Promise<void>;
}

export type VoiceModelMatch =
  | { kind: 'model'; model: BackendModelInfo }
  | { kind: 'auto' }
  | { kind: 'ambiguous'; options: BackendModelInfo[] }
  | { kind: 'none' };

function tokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/(\d)\.(\d)/g, '$1 $2')
    .split(/[^a-z0-9]+/)
    .filter((token) => token && !FILLER_WORDS.has(token));
}

function haystack(model: BackendModelInfo): string {
  return tokens(`${model.name} ${model.id}`).join(' ');
}

/** Every spoken word must appear in the model's name or id; an exact name wins ties. */
export function matchVoiceModel(spoken: string, models: BackendModelInfo[]): VoiceModelMatch {
  const wanted = tokens(spoken);
  if (wanted.length === 0) return { kind: 'none' };
  if (wanted.every((token) => AUTO_WORDS.has(token))) return { kind: 'auto' };

  const matches = models.filter((model) => {
    const words = haystack(model).split(' ');
    return wanted.every((token) => words.some((word) => word.startsWith(token)));
  });
  if (matches.length === 0) return { kind: 'none' };
  if (matches.length === 1) return { kind: 'model', model: matches[0] };

  const spokenKey = wanted.join(' ');
  const exact = matches.filter(
    (model) =>
      tokens(model.name).join(' ') === spokenKey || tokens(model.id).join(' ') === spokenKey
  );
  if (exact.length === 1) return { kind: 'model', model: exact[0] };
  return { kind: 'ambiguous', options: matches.slice(0, MAX_OPTIONS) };
}

/** Models the chat model selector would let this user pick. */
export function selectableVoiceModels(models: BackendModelInfo[]): BackendModelInfo[] {
  return models.filter((model) => !isGptImage25ModelId(model.id) && model.hasBudget !== false);
}

/** Same payload the chat model selector saves for a backend catalog model. */
export function modelSelectionPayload(model: BackendModelInfo): Partial<AppConfig> {
  return applyBackendManagedCredentials<Partial<AppConfig>>({
    provider: model.provider,
    activeProfileKey: model.provider,
    customProtocol:
      model.provider === 'gemini' ? 'gemini' : model.provider === 'openai' ? 'openai' : 'anthropic',
    model: model.id,
    apiKey: BACKEND_PROXY_PLACEHOLDER_KEY,
  });
}

function currentModelLabel(config: AppConfig, models: BackendModelInfo[]): string {
  if (isAutoModelId(config.model)) return 'Auto';
  return models.find((model) => model.id === config.model)?.name ?? config.model ?? 'none';
}

function optionList(models: BackendModelInfo[]): string {
  return models.map((model) => model.name).join(', ');
}

export async function describeVoiceModel(deps: VoiceModelDeps): Promise<VoiceActionResult> {
  const config = deps.getConfig();
  const models = selectableVoiceModels(await deps.listModels());
  return {
    ok: true,
    message: `Using ${currentModelLabel(config, models)}. Available: Auto, ${optionList(models)}.`,
  };
}

export async function switchVoiceModel(
  rawName: unknown,
  deps: VoiceModelDeps
): Promise<VoiceActionResult> {
  const spoken = typeof rawName === 'string' ? rawName.trim() : '';
  if (!spoken) return { ok: false, message: 'Say which model to use.' };
  const config = deps.getConfig();
  const models = selectableVoiceModels(await deps.listModels());
  const match = matchVoiceModel(spoken, models);

  switch (match.kind) {
    case 'auto':
      await deps.saveConfig({ model: AUTO_MODEL_ID });
      return { ok: true, message: 'Switched to Auto.' };
    case 'model':
      if (config.model === match.model.id && config.provider === match.model.provider) {
        return { ok: true, message: `Already using ${match.model.name}.` };
      }
      await deps.saveConfig(modelSelectionPayload(match.model));
      return { ok: true, message: `Switched to ${match.model.name}.` };
    case 'ambiguous':
      return {
        ok: false,
        message: `Several models match "${spoken}": ${optionList(match.options)}. Ask which one.`,
      };
    default:
      return {
        ok: false,
        message: `No available model matches "${spoken}". Available: Auto, ${optionList(models)}.`,
      };
  }
}
