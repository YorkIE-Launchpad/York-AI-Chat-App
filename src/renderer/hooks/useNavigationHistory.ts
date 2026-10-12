import { useEffect } from 'react';
import { create } from 'zustand';
import { useAppStore, type AppState } from '../store';
import { useNavigation } from './useNavigation';

export type NavPage = 'today' | 'chat' | 'followUps' | 'automations' | 'settings';

export interface NavLocation {
  page: NavPage;
  sessionId?: string;
}

interface NavHistoryState {
  entries: NavLocation[];
  index: number;
}

const MAX_ENTRIES = 50;

/** Browser-style page history (Today, chats, Follow-ups, Automations, Settings). */
export const useNavHistory = create<NavHistoryState>(() => ({ entries: [], index: -1 }));

export function locationFromState(state: AppState): NavLocation {
  if (state.showSettings) return { page: 'settings' };
  if (state.showWorkflows) return { page: 'automations' };
  if (state.showLoops) return { page: 'followUps' };
  if (state.activeSessionId) return { page: 'chat', sessionId: state.activeSessionId };
  return { page: 'today' };
}

export function sameLocation(a?: NavLocation, b?: NavLocation): boolean {
  return !!a && !!b && a.page === b.page && a.sessionId === b.sessionId;
}

/** Records a visit: drops forward entries, skips repeats, caps length. */
export function pushLocation(history: NavHistoryState, location: NavLocation): NavHistoryState {
  if (sameLocation(history.entries[history.index], location)) return history;
  const entries = [...history.entries.slice(0, history.index + 1), location].slice(-MAX_ENTRIES);
  return { entries, index: entries.length - 1 };
}

let applyLocation: ((location: NavLocation) => boolean) | null = null;
let stepping = false;
let recordTimer: ReturnType<typeof setTimeout> | null = null;

/** Page moves flip several store flags in a row; record once the update settles. */
function scheduleRecord() {
  if (recordTimer) return;
  recordTimer = setTimeout(() => {
    recordTimer = null;
    const location = locationFromState(useAppStore.getState());
    const history = useNavHistory.getState();
    if (stepping) {
      stepping = false;
      if (!sameLocation(history.entries[history.index], location)) {
        const entries = [...history.entries];
        entries[history.index] = location;
        useNavHistory.setState({ entries });
      }
      return;
    }
    useNavHistory.setState(pushLocation(history, location));
  }, 0);
}

function step(delta: -1 | 1) {
  const { entries, index } = useNavHistory.getState();
  const next = index + delta;
  if (next < 0 || next >= entries.length || !applyLocation) return;
  useNavHistory.setState({ index: next });
  stepping = true;
  if (applyLocation(entries[next])) {
    scheduleRecord();
    return;
  }
  // Deleted chats drop out of history.
  stepping = false;
  useNavHistory.setState({
    entries: entries.filter((_, i) => i !== next),
    index: delta < 0 ? index - 1 : index,
  });
  step(delta);
}

export const goBack = () => step(-1);
export const goForward = () => step(1);

/** Mount once: records page changes and handles ⌘[ / ⌘] and mouse back/forward buttons. */
export function useNavigationHistoryTracker() {
  const nav = useNavigation();

  useEffect(() => {
    applyLocation = (location) => {
      const s = useAppStore.getState();
      switch (location.page) {
        case 'today':
          nav.goToday();
          return true;
        case 'chat':
          if (!location.sessionId || !s.sessions.some((x) => x.id === location.sessionId)) {
            return false;
          }
          void nav.openChat(location.sessionId);
          return true;
        case 'followUps':
          s.setShowSettings(false);
          s.setShowWorkflows(false);
          nav.openFollowUps();
          return true;
        case 'automations':
          s.setShowSettings(false);
          s.setShowLoops(false);
          nav.openAutomations();
          return true;
        case 'settings':
          nav.openSettings();
          return true;
      }
    };
    return () => {
      applyLocation = null;
    };
  }, [nav]);

  useEffect(() => {
    useNavHistory.setState((h) => pushLocation(h, locationFromState(useAppStore.getState())));
    return useAppStore.subscribe((state, prev) => {
      if (
        state.showSettings !== prev.showSettings ||
        state.showWorkflows !== prev.showWorkflows ||
        state.showLoops !== prev.showLoops ||
        state.activeSessionId !== prev.activeSessionId
      ) {
        scheduleRecord();
      }
    });
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod || event.shiftKey || event.altKey) return;
      if (event.key !== '[' && event.key !== ']') return;
      event.preventDefault();
      if (event.key === '[') goBack();
      else goForward();
    };
    const onMouse = (event: MouseEvent) => {
      if (event.button === 3) {
        event.preventDefault();
        goBack();
      } else if (event.button === 4) {
        event.preventDefault();
        goForward();
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mouseup', onMouse);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mouseup', onMouse);
    };
  }, []);
}
