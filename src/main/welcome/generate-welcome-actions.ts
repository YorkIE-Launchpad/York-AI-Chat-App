/**
 * Generate / cache / fall back welcome quick-action chips + tagline via OpenRouter free model.
 */

import type { AppConfig } from '../config/config-store';
import { resolveFreeModelForChild } from '../agent/free-model-resolve';
import { runPiAiOneShot } from '../agent/sdk-one-shot';
import { log, logWarn } from '../utils/logger';
import {
  DEFAULT_WELCOME_TAGLINE,
  buildConnectorFingerprint,
  formatWelcomeProfileSummary,
  type WelcomeActionsSource,
  type WelcomeConnectorSnapshot,
  type WelcomeProfile,
  type WelcomeQuickAction,
  type WelcomeQuickActionsResponse,
} from '../../shared/welcome-actions';
import { welcomeActionsStore } from './welcome-actions-store';
import {
  enrichChipsWithConnectorNames,
  extractJsonValue,
  getStaticFallbackChips,
  parseWelcomeGenerationPayload,
} from './welcome-actions-helpers';

export {
  enrichChipsWithConnectorNames,
  getStaticFallbackChips,
  parseAndValidateWelcomeChips,
  parseWelcomeGenerationPayload,
  sanitizeWelcomeTagline,
} from './welcome-actions-helpers';

const SYSTEM_PROMPT = `You generate the welcome screen for York IE VECOS, an internal AI desktop app for York IE (investment + consultancy).

Return ONLY a JSON object. No markdown fences, no commentary.
{
  "tagline": "one short inviting subtitle for the welcome screen (<= 80 chars)",
  "chips": [
    {
      "id": "kebab-case-id",
      "label": "short label <= 28 chars",
      "prompt": "full actionable user message the assistant should receive",
      "icon": one of FileText|BarChart3|FolderOpen|Mail|BookOpen|FileSearch|Users|Briefcase|Rocket|Calendar|ClipboardList|Target|Presentation|Search,
      "requiresConnectorId": "<mcp server id from the connector list, or null>"
    }
  ]
}

Tagline rules:
- One sentence or short phrase; warm, professional, role-aware.
- Reflect the user's title / function / squad when known (e.g. engineering manager, GTM, delivery, IC, ops).
- Do not use the user's name or email in the tagline.
- Example style: "Deal flow, diligence, or portfolio — what's next?"

Chip rules (5 or 6 items):
- Tailor actions to the user's title / function / squad when provided.
- Prefer actions that use ENABLED connectors; set requiresConnectorId only to an id from the provided list.
- Do not invent connectors that are not listed.
- Cover York IE domains where relevant: Hub (timesheets, leave, people), LaunchPad (releases/SDLC), GTM Pulse, deal flow / diligence / portfolio memos, client decks (prefer HTML previewable pages; pptx/docx/xlsx/pdf only when the user would explicitly want Office/PDF).
- Prompts must be concrete and ready to run (not placeholders like [topic]).
- Labels should be title-case short phrases.`;

function buildUserPrompt(
  profile: WelcomeProfile | null,
  connectors: WelcomeConnectorSnapshot[],
  options?: {
    avoidChips?: WelcomeQuickAction[];
    avoidTagline?: string | null;
    shuffleNonce?: string;
  }
): string {
  const profileBlock = profile
    ? JSON.stringify(
        {
          name: profile.name,
          email: profile.email,
          title: profile.title,
          function: profile.functionName,
          squad: profile.squad,
          department: profile.department,
        },
        null,
        2
      )
    : '{"note":"No Hub profile available; use general York IE employee defaults."}';

  const connectorBlock = JSON.stringify(
    connectors.map((c) => ({
      id: c.id,
      name: c.name,
      enabled: c.enabled,
      status: c.status,
      toolCount: c.toolCount,
    })),
    null,
    2
  );

  let avoidBlock = '';
  if (options?.avoidChips?.length || options?.avoidTagline) {
    avoidBlock =
      `\n\nGenerate a FRESH welcome that differs from the previous one (new tagline and chips; do not repeat):\n` +
      JSON.stringify(
        {
          previousTagline: options.avoidTagline || null,
          previousChips: (options.avoidChips || []).map((c) => ({ id: c.id, label: c.label })),
        },
        null,
        2
      );
  }
  if (options?.shuffleNonce) {
    avoidBlock += `\n\nVariation token: ${options.shuffleNonce}`;
  }

  return `User profile:\n${profileBlock}\n\nMCP connectors:\n${connectorBlock}${avoidBlock}\n\nGenerate the JSON object now.`;
}

interface GeneratedWelcome {
  chips: WelcomeQuickAction[];
  tagline: string;
}

async function generateWelcomeWithLlm(
  profile: WelcomeProfile | null,
  connectors: WelcomeConnectorSnapshot[],
  config: AppConfig,
  options?: {
    avoidChips?: WelcomeQuickAction[];
    avoidTagline?: string | null;
    shuffle?: boolean;
  }
): Promise<GeneratedWelcome | null> {
  try {
    const userPrompt = buildUserPrompt(profile, connectors, {
      avoidChips: options?.avoidChips,
      avoidTagline: options?.avoidTagline,
      shuffleNonce: options?.shuffle
        ? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
        : undefined,
    });
    const free = await resolveFreeModelForChild({
      promptText: userPrompt,
      parent: {
        model: config.model,
        provider: config.provider,
        customProtocol: config.customProtocol,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        autoModelPreference: config.autoModelPreference,
      },
    });

    const oneShotConfig: AppConfig = {
      ...config,
      model: free.modelId,
      provider: free.provider as AppConfig['provider'],
      customProtocol: free.customProtocol,
      baseUrl: free.baseUrl || config.baseUrl,
      apiKey: free.apiKey || config.apiKey,
    };

    const result = await runPiAiOneShot(userPrompt, SYSTEM_PROMPT, oneShotConfig, {
      temperature: options?.shuffle ? 0.7 : 0.4,
      maxTokens: 1400,
    });

    const parsed = extractJsonValue(result.text);
    const payload = parseWelcomeGenerationPayload(parsed, connectors, DEFAULT_WELCOME_TAGLINE);
    if (payload.chips.length < 3) {
      logWarn('[WelcomeActions] LLM returned too few valid chips:', payload.chips.length);
      return null;
    }
    log(
      `[WelcomeActions] Generated tagline + ${payload.chips.length} chips via ${free.strategy}/${free.modelId}`
    );
    return payload;
  } catch (error) {
    logWarn('[WelcomeActions] LLM generation failed:', error);
    return null;
  }
}

export interface GetWelcomeQuickActionsOptions {
  profile: WelcomeProfile | null;
  connectors: WelcomeConnectorSnapshot[];
  config: AppConfig;
  forceRegenerate?: boolean;
}

/**
 * Return cached welcome when fingerprint matches; otherwise generate (or fall back).
 */
export async function getWelcomeQuickActions(
  options: GetWelcomeQuickActionsOptions
): Promise<WelcomeQuickActionsResponse> {
  const { profile, connectors, config, forceRegenerate } = options;
  const fingerprint = buildConnectorFingerprint(connectors);
  const email = profile?.email?.trim().toLowerCase() || '';

  const previous = forceRegenerate && email ? welcomeActionsStore.get(email) : null;

  if (!forceRegenerate && email) {
    const cached = welcomeActionsStore.get(email);
    if (cached && cached.connectorFingerprint === fingerprint && cached.chips?.length) {
      return {
        chips: enrichChipsWithConnectorNames(cached.chips, connectors),
        tagline: cached.tagline?.trim() || DEFAULT_WELCOME_TAGLINE,
        source: 'cache',
        profileSummary: formatWelcomeProfileSummary(cached.profile || profile!),
        connectorFingerprint: fingerprint,
      };
    }
  }

  const generated = await generateWelcomeWithLlm(profile, connectors, config, {
    avoidChips: previous?.chips,
    avoidTagline: previous?.tagline,
    shuffle: Boolean(forceRegenerate),
  });
  let source: WelcomeActionsSource = 'generated';
  let chips = generated?.chips ?? null;
  let tagline = generated?.tagline ?? DEFAULT_WELCOME_TAGLINE;

  if (!chips || chips.length === 0) {
    chips = getStaticFallbackChips(connectors);
    tagline = DEFAULT_WELCOME_TAGLINE;
    source = 'fallback';
  }

  if (email) {
    welcomeActionsStore.set({
      email,
      connectorFingerprint: fingerprint,
      chips,
      tagline,
      profile,
      updatedAt: Date.now(),
    });
  }

  return {
    chips,
    tagline,
    source,
    profileSummary: profile ? formatWelcomeProfileSummary(profile) : null,
    connectorFingerprint: fingerprint,
  };
}
