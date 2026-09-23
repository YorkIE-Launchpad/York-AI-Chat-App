import {
  buildTitlePrompt,
  isAutomaticSessionTitle,
  isEchoTitle,
  normalizeGeneratedTitle,
  shouldGenerateTitle,
  succinctTitleFromPrompt,
} from './session-title-utils';

type TitleFlowDeps = {
  sessionId: string;
  prompt: string;
  userMessageCount: number;
  currentTitle: string;
  hasAttempted: boolean;
  generateTitle: (titlePrompt: string) => Promise<string | null>;
  updateTitle: (title: string) => Promise<boolean> | boolean;
  getLatestTitle: () => string | null;
  markAttempt: () => void;
  shouldAbort?: () => boolean;
  log: (message: string, ...args: unknown[]) => void;
};

function localSuccinctTitle(prompt: string, currentTitle: string): string | null {
  const fallback = succinctTitleFromPrompt(prompt);
  if (!fallback || fallback === currentTitle) return null;
  return fallback;
}

export async function maybeGenerateSessionTitle(deps: TitleFlowDeps): Promise<void> {
  if (deps.shouldAbort?.()) {
    deps.log('[SessionTitle] Skip: title flow aborted before start', deps.sessionId);
    return;
  }
  const shouldGenerate = shouldGenerateTitle({
    userMessageCount: deps.userMessageCount,
    currentTitle: deps.currentTitle,
    prompt: deps.prompt,
    hasAttempted: deps.hasAttempted,
  });

  if (!shouldGenerate) {
    if (deps.hasAttempted) {
      deps.log('[SessionTitle] Skip: already attempted', deps.sessionId);
      return;
    }
    if (deps.userMessageCount !== 1) {
      deps.log('[SessionTitle] Skip: not first user message', deps.sessionId);
      return;
    }
    deps.log('[SessionTitle] Skip: title already customized', deps.sessionId);
    return;
  }

  deps.log('[SessionTitle] Generating title...', deps.sessionId);

  const titlePrompt = buildTitlePrompt(deps.prompt);
  let generatedTitle: string | null = null;
  try {
    generatedTitle = normalizeGeneratedTitle(await deps.generateTitle(titlePrompt), deps.prompt);
  } catch (error) {
    deps.log('[SessionTitle] Generation failed', deps.sessionId, error);
    generatedTitle = null;
  }

  if (deps.shouldAbort?.()) {
    deps.log('[SessionTitle] Skip: title flow aborted after generation', deps.sessionId);
    return;
  }

  if (generatedTitle && isEchoTitle(deps.prompt, generatedTitle)) {
    deps.log('[SessionTitle] Rejected echo of the user message', deps.sessionId, generatedTitle);
    generatedTitle = null;
  }

  if (!generatedTitle) {
    const fallback = localSuccinctTitle(deps.prompt, deps.currentTitle);
    if (!fallback) {
      deps.log('[SessionTitle] No title generated', deps.sessionId);
      return;
    }
    generatedTitle = fallback;
    deps.log('[SessionTitle] Using local succinct title', deps.sessionId, generatedTitle);
  }

  const latestTitle = deps.getLatestTitle();
  if (
    latestTitle &&
    latestTitle !== deps.currentTitle &&
    !isAutomaticSessionTitle(latestTitle, deps.prompt)
  ) {
    deps.log('[SessionTitle] Skip: title changed before update', deps.sessionId);
    return;
  }

  const updated = await deps.updateTitle(generatedTitle);
  if (updated) {
    deps.markAttempt();
    deps.log('[SessionTitle] Title updated', deps.sessionId, generatedTitle);
  } else {
    deps.log('[SessionTitle] Title update no-op (session may have been deleted)', deps.sessionId);
  }
}
