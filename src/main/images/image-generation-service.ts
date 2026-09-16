import OpenAI, { toFile } from 'openai';
import type { ContentBlock, ImageContent } from '../../renderer/types';
import { BACKEND_PROXY_PLACEHOLDER_KEY, getBackendProxyBaseUrl } from '../../shared/backend-config';
import { appVersionHeaders } from '../../shared/client-version';
import { extractVisionApiUsage } from '../../shared/hub-governance-usage';
import { isGptImage25ModelId } from '../../shared/image-generation';
import { getClientAppVersion, resolveBackendClientApiKey } from '../config/backend-auth';
import { reportHubGovernanceUsageFromCompletion } from '../hub/hub-ai-governance';
import { logWarn } from '../utils/logger';

export interface ImageGenerationInputImage {
  mediaType: string;
  base64: string;
}

export interface ImageGenerationResult {
  base64: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
}

export type ImageGenerationClient = Pick<OpenAI['images'], 'generate' | 'edit'>;

function extractInputImages(content: ContentBlock[]): ImageGenerationInputImage[] {
  const images: ImageGenerationInputImage[] = [];
  for (const block of content) {
    if (block.type !== 'image') continue;
    const image = block as ImageContent;
    if (image.source?.type !== 'base64' || !image.source.data) continue;
    images.push({
      mediaType: image.source.media_type,
      base64: image.source.data,
    });
  }
  return images;
}

function outputFormatFromMediaType(
  mediaType: string
): 'png' | 'jpeg' | 'webp' | undefined {
  if (mediaType === 'image/png') return 'png';
  if (mediaType === 'image/jpeg') return 'jpeg';
  if (mediaType === 'image/webp') return 'webp';
  return undefined;
}

function mediaTypeFromOutputFormat(format: string | undefined): ImageGenerationResult['mediaType'] {
  if (format === 'jpeg') return 'image/jpeg';
  if (format === 'webp') return 'image/webp';
  return 'image/png';
}

async function createOpenAIImageClient(): Promise<OpenAI> {
  const baseUrl = getBackendProxyBaseUrl('openai');
  const apiKey = await resolveBackendClientApiKey({
    provider: 'openai',
    apiKey: BACKEND_PROXY_PLACEHOLDER_KEY,
  });
  return new OpenAI({
    apiKey,
    baseURL: baseUrl,
    defaultHeaders: appVersionHeaders(getClientAppVersion()),
  });
}

export async function runGptImageGeneration(options: {
  modelId: string;
  prompt: string;
  content?: ContentBlock[];
  sessionId: string;
  signal?: AbortSignal;
  client?: ImageGenerationClient;
}): Promise<ImageGenerationResult> {
  const modelId = options.modelId.trim();
  if (!isGptImage25ModelId(modelId)) {
    throw new Error(`Unsupported image model: ${modelId}`);
  }

  const prompt = options.prompt.trim();
  if (!prompt) {
    throw new Error('Image prompt is required');
  }

  const inputImages = extractInputImages(options.content ?? []);
  const startedAt = Date.now();
  const client = options.client ?? (await createOpenAIImageClient()).images;

  try {
    let b64: string | undefined;
    let outputFormat: string | undefined;
    let usage: unknown;

    if (inputImages.length === 0) {
      const response = await client.generate(
        {
          model: modelId,
          prompt,
          output_format: 'png',
        },
        options.signal ? { signal: options.signal } : undefined
      );
      b64 = response.data?.[0]?.b64_json;
      outputFormat = 'png';
      usage = (response as { usage?: unknown }).usage;
    } else {
      const files = await Promise.all(
        inputImages.map(async (img, index) => {
          const buffer = Buffer.from(img.base64, 'base64');
          const format = outputFormatFromMediaType(img.mediaType) ?? 'png';
          return toFile(buffer, `input-${index}.${format}`, { type: img.mediaType });
        })
      );
      const response = await client.edit(
        {
          model: modelId,
          image: files.length === 1 ? files[0] : files,
          prompt,
          output_format: 'png',
        },
        options.signal ? { signal: options.signal } : undefined
      );
      b64 = response.data?.[0]?.b64_json;
      outputFormat = 'png';
      usage = (response as { usage?: unknown }).usage;
    }

    if (!b64) {
      throw new Error('Image API returned no image data');
    }

    const normalizedUsage = extractVisionApiUsage(usage) ?? usage;
    reportHubGovernanceUsageFromCompletion({
      modelId,
      provider: 'openai',
      sessionId: options.sessionId,
      feature: 'image_generation',
      usage: normalizedUsage,
      latencyMs: Date.now() - startedAt,
      status: 'ok',
    });

    return {
      base64: b64,
      mediaType: mediaTypeFromOutputFormat(outputFormat),
    };
  } catch (error) {
    reportHubGovernanceUsageFromCompletion({
      modelId,
      provider: 'openai',
      sessionId: options.sessionId,
      feature: 'image_generation',
      usage: {},
      latencyMs: Date.now() - startedAt,
      status: 'error',
      errorCode: error instanceof Error ? error.name : 'image_generation_error',
    });
    if (error instanceof Error && error.name === 'AbortError') {
      throw error;
    }
    logWarn('[ImageGeneration] request failed:', error);
    throw error instanceof Error ? error : new Error(String(error));
  }
}
