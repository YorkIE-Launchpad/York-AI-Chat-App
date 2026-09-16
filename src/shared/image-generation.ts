import type { BackendModelInfo } from './backend-config';

export const GPT_IMAGE_25_FLARE = 'gpt-image-2.5-flare';
export const GPT_IMAGE_25_SUNBURST = 'gpt-image-2.5-sunburst';

const GPT_IMAGE_25_ID_RE = /^gpt-image-2\.5/i;

export function isGptImage25ModelId(modelId: string): boolean {
  return GPT_IMAGE_25_ID_RE.test(modelId.trim());
}

export function hasGptImage25Access(models: BackendModelInfo[]): boolean {
  return models.some((m) => isGptImage25ModelId(m.id) && m.hasBudget !== false);
}

/**
 * Pick the image model to call: prefer Flare when allowed, else first gpt-image-2.5* grant.
 */
export function resolveGptImage25ModelId(models: BackendModelInfo[]): string | null {
  const eligible = models.filter((m) => isGptImage25ModelId(m.id) && m.hasBudget !== false);
  if (eligible.length === 0) return null;
  const flare = eligible.find((m) => m.id.toLowerCase() === GPT_IMAGE_25_FLARE);
  if (flare) return flare.id;
  const sunburst = eligible.find((m) => m.id.toLowerCase() === GPT_IMAGE_25_SUNBURST);
  if (sunburst) return sunburst.id;
  return eligible[0]?.id ?? null;
}

export type ComposerMode = 'chat' | 'image';
