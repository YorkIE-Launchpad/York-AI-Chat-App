import { createHash } from 'node:crypto';

export interface PiSessionRuntimeSignatureInput {
  configProvider?: string;
  customProtocol?: string;
  modelProvider?: string;
  modelApi?: string;
  modelBaseUrl?: string;
  effectiveCwd?: string;
  apiKey?: string;
  /** Profile MUST prompts — included so session recreates when they change. */
  profileDosPrompt?: string;
  profileDontsPrompt?: string;
  profileCustomPrompt?: string;
}

function normalizeText(value: string | undefined): string {
  return value?.trim() || '';
}

function fingerprintSecret(value: string | undefined): string {
  const normalized = normalizeText(value);
  if (!normalized) {
    return '';
  }
  return createHash('sha256').update(normalized).digest('hex');
}

export function buildPiSessionRuntimeSignature(input: PiSessionRuntimeSignatureInput): string {
  return JSON.stringify({
    configProvider: normalizeText(input.configProvider),
    customProtocol: normalizeText(input.customProtocol),
    modelProvider: normalizeText(input.modelProvider),
    modelApi: normalizeText(input.modelApi),
    modelBaseUrl: normalizeText(input.modelBaseUrl).replace(/\/+$/, ''),
    effectiveCwd: normalizeText(input.effectiveCwd),
    apiKeyFingerprint: fingerprintSecret(input.apiKey),
    profileDosPrompt: normalizeText(input.profileDosPrompt),
    profileDontsPrompt: normalizeText(input.profileDontsPrompt),
    profileCustomPrompt: normalizeText(input.profileCustomPrompt),
  });
}
