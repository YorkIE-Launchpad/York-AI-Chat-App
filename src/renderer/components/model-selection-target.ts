/**
 * A brainstorm pins its model on the session. Everywhere else the picker
 * writes the global config.
 */
export function persistModelPick(input: {
  sessionId?: string;
  brainstormId?: string;
  model?: string;
  provider?: string;
}):
  | { type: 'brainstorm.setModel'; payload: { id: string; model: string; provider: string } }
  | { type: 'config' } {
  const model = input.model?.trim();
  const provider = input.provider?.trim() || 'anthropic';
  if (input.sessionId && input.brainstormId && model) {
    return {
      type: 'brainstorm.setModel',
      payload: { id: input.brainstormId, model, provider },
    };
  }
  return { type: 'config' };
}
