/**
 * Start a brainstorm from the setup form, a slash command, or the home chip.
 */
import type { ClientEvent, Session } from '../types';
import type { BrainstormCreateInput, BrainstormDetail } from '../../shared/brainstorm-types';
import { parseBrainstormCommand } from '../../shared/brainstorm-types';
import { useAppStore } from '../store';

type Invoke = <T>(event: ClientEvent) => Promise<T>;

export async function submitBrainstormCreate(
  invoke: Invoke,
  input: BrainstormCreateInput
): Promise<BrainstormDetail> {
  const result = await invoke<{ detail: BrainstormDetail; session: Session }>({
    type: 'brainstorm.create',
    payload: input,
  });
  const store = useAppStore.getState();
  store.ensureSession(result.session);
  store.upsertBrainstorm(result.detail);
  store.setActiveBrainstormId(result.detail.id);
  store.setShowBrainstorm(true);
  return result.detail;
}

/** Returns true when the composer text was a /brainstorm command and was consumed. */
export async function consumeBrainstormComposerPrompt(
  text: string,
  invoke: Invoke
): Promise<boolean> {
  const topic = parseBrainstormCommand(text);
  if (topic === null) return false;
  if (!topic) {
    const store = useAppStore.getState();
    store.setActiveBrainstormId(null);
    store.setShowBrainstorm(true);
    return true;
  }
  await submitBrainstormCreate(invoke, { topic });
  return true;
}
