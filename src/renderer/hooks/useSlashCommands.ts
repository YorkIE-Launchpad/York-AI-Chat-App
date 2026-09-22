import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Skill } from '../types';
import { useAppStore } from '../store';
import {
  getSkillComposerTrigger,
  type SkillComposerTrigger,
  type SkillTriggerMode,
} from '../../shared/skill-composer-trigger';

const isElectron = typeof window !== 'undefined' && window.electronAPI !== undefined;

export const MEETING_SLASH_SKILL_ID = '__builtin_meeting';
export const LOOP_SLASH_SKILL_ID = '__builtin_loop';
export const GOAL_SLASH_SKILL_ID = '__builtin_goal';
export const LOOP_STOP_SLASH_SKILL_ID = '__builtin_loop_stop';

export const MEETING_SLASH_SKILL: Skill = {
  id: MEETING_SLASH_SKILL_ID,
  name: 'meeting',
  description: 'Attach a saved meeting to this message',
  type: 'builtin',
  enabled: true,
  userInvocable: true,
  createdAt: 0,
};

export const LOOP_SLASH_SKILL: Skill = {
  id: LOOP_SLASH_SKILL_ID,
  name: 'loop',
  description: 'Repeat a prompt in this session on a set interval (/loop 5m …)',
  type: 'builtin',
  enabled: true,
  userInvocable: true,
  argumentHint: '<interval> <prompt>',
  createdAt: 0,
};

export const GOAL_SLASH_SKILL: Skill = {
  id: GOAL_SLASH_SKILL_ID,
  name: 'goal',
  description:
    'Keep working until a goal is met (/goal …; interval optional default 2m; max ticks optional default 20)',
  type: 'builtin',
  enabled: true,
  userInvocable: true,
  argumentHint: '[interval] [max N] <goal>',
  createdAt: 0,
};

export const LOOP_STOP_SLASH_SKILL: Skill = {
  id: LOOP_STOP_SLASH_SKILL_ID,
  name: 'loop stop',
  description: 'Stop the active loop or goal for this session',
  type: 'builtin',
  enabled: true,
  userInvocable: true,
  createdAt: 0,
};

export const GOAL_STOP_SLASH_SKILL_ID = '__builtin_goal_stop';

export const GOAL_STOP_SLASH_SKILL: Skill = {
  id: GOAL_STOP_SLASH_SKILL_ID,
  name: 'goal stop',
  description: 'Stop the active loop or goal for this session',
  type: 'builtin',
  enabled: true,
  userInvocable: true,
  createdAt: 0,
};

export function isMeetingSlashSkill(skill: Skill | null | undefined): boolean {
  return Boolean(skill && skill.id === MEETING_SLASH_SKILL_ID);
}

export function isLoopBuiltinSkill(skill: Skill | null | undefined): boolean {
  return Boolean(
    skill &&
    (skill.id === LOOP_SLASH_SKILL_ID ||
      skill.id === GOAL_SLASH_SKILL_ID ||
      skill.id === LOOP_STOP_SLASH_SKILL_ID ||
      skill.id === GOAL_STOP_SLASH_SKILL_ID)
  );
}

export function isLoopStopBuiltinSkill(skill: Skill | null | undefined): boolean {
  return Boolean(
    skill && (skill.id === LOOP_STOP_SLASH_SKILL_ID || skill.id === GOAL_STOP_SLASH_SKILL_ID)
  );
}

export function isSlashCommandInput(value: string): boolean {
  return /^\/[^\n]*$/.test(value);
}

export function getSlashQuery(value: string): string {
  if (!isSlashCommandInput(value)) return '';
  return value.slice(1).trim().toLowerCase();
}

export type { SkillComposerTrigger, SkillTriggerMode };

export function useSlashCommands(prompt: string, cursorIndex: number = prompt.length) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [meetingsReferenceAllowed, setMeetingsReferenceAllowed] = useState(false);
  const [rankedNames, setRankedNames] = useState<string[]>([]);
  const skillsStorageChangedAt = useAppStore((state) => state.skillsStorageChangedAt);
  const appConfig = useAppStore((state) => state.appConfig);

  const trigger = useMemo(
    () => getSkillComposerTrigger(prompt, cursorIndex),
    [prompt, cursorIndex]
  );

  const isOpen = (manualOpen || Boolean(trigger)) && !dismissed;

  const reloadSkills = useCallback(() => {
    if (!isElectron) {
      setSkills([]);
      return;
    }
    void window.electronAPI.skills
      .getAll()
      .then((items) => {
        setSkills(items.filter((s) => s.enabled && s.userInvocable !== false));
      })
      .catch(() => {
        setSkills([]);
      });
  }, []);

  useEffect(() => {
    reloadSkills();
  }, [reloadSkills, skillsStorageChangedAt]);

  useEffect(() => {
    let cancelled = false;
    const meetingsEnabled = appConfig?.meetingsEnabled !== false;
    const allowRef = appConfig?.meetingsRuntime?.allowChatReference !== false;
    if (!isElectron || !meetingsEnabled || !allowRef) {
      setMeetingsReferenceAllowed(false);
      return;
    }
    void window.electronAPI.meetings
      .getOverview()
      .then((overview) => {
        if (!cancelled) {
          setMeetingsReferenceAllowed(overview.enabled && overview.allowChatReference);
        }
      })
      .catch(() => {
        if (!cancelled) setMeetingsReferenceAllowed(false);
      });
    return () => {
      cancelled = true;
    };
  }, [appConfig?.meetingsEnabled, appConfig?.meetingsRuntime?.allowChatReference]);

  // Reset dismiss when the trigger goes away; clear manual open when user clears @/
  useEffect(() => {
    if (!trigger && !manualOpen) {
      setDismissed(false);
    }
    if (trigger) {
      setManualOpen(false);
    }
  }, [trigger, manualOpen]);

  const filteredSkills = useMemo(() => {
    if (!isOpen) return [];

    const mode: SkillTriggerMode | 'manual' = trigger?.mode ?? (manualOpen ? 'manual' : 'slash');
    const query = (trigger?.query ?? '').trim().toLowerCase();

    // Built-ins only apply to `/` (not pure @ mentions or + picker)
    const includeBuiltins = mode === 'slash';
    const builtin = includeBuiltins
      ? [
          ...(meetingsReferenceAllowed
            ? [
                {
                  ...MEETING_SLASH_SKILL,
                  description: MEETING_SLASH_SKILL.description,
                },
              ]
            : []),
          LOOP_SLASH_SKILL,
          GOAL_SLASH_SKILL,
          LOOP_STOP_SLASH_SKILL,
          GOAL_STOP_SLASH_SKILL,
        ]
      : [];

    if (!query) return [...builtin, ...skills];

    // Lexical filter first (sync). Jev reorders catalog portion via rankedNames.
    const catalogFiltered = skills.filter((skill) => {
      const name = skill.name.toLowerCase();
      const description = (skill.description ?? '').toLowerCase();
      return name.includes(query) || description.includes(query);
    });

    const builtinFiltered = builtin.filter((skill) => {
      const name = skill.name.toLowerCase();
      const description = (skill.description ?? '').toLowerCase();
      return name.includes(query) || description.includes(query);
    });

    if (rankedNames.length === 0) {
      return [...builtinFiltered, ...catalogFiltered];
    }

    const byName = new Map(catalogFiltered.map((s) => [s.name.toLowerCase(), s]));
    const ordered: Skill[] = [];
    const seen = new Set<string>();
    for (const name of rankedNames) {
      const skill = byName.get(name.toLowerCase());
      if (skill && !seen.has(skill.id)) {
        ordered.push(skill);
        seen.add(skill.id);
      }
    }
    for (const skill of catalogFiltered) {
      if (!seen.has(skill.id)) ordered.push(skill);
    }
    return [...builtinFiltered, ...ordered];
  }, [isOpen, trigger, manualOpen, skills, meetingsReferenceAllowed, rankedNames]);

  // Debounced Jev rank for catalog skills when the query changes.
  useEffect(() => {
    if (!isOpen || !isElectron) {
      setRankedNames([]);
      return;
    }
    const query = (trigger?.query ?? '').trim();
    if (!query || skills.length === 0) {
      setRankedNames([]);
      return;
    }

    let cancelled = false;
    const handle = window.setTimeout(() => {
      void window.electronAPI.skills
        .rankForQuery({
          query,
          skills: skills.map((s) => ({
            name: s.name,
            description: s.description,
          })),
        })
        .then((result) => {
          if (!cancelled) setRankedNames(result.names);
        })
        .catch(() => {
          if (!cancelled) setRankedNames([]);
        });
    }, 200);

    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [isOpen, trigger?.query, skills]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [prompt, filteredSkills.length, trigger?.start, manualOpen]);

  useEffect(() => {
    if (selectedIndex >= filteredSkills.length) {
      setSelectedIndex(Math.max(0, filteredSkills.length - 1));
    }
  }, [filteredSkills.length, selectedIndex]);

  const moveSelection = useCallback(
    (delta: number) => {
      if (filteredSkills.length === 0) return;
      setSelectedIndex((prev) => {
        const next = (prev + delta + filteredSkills.length) % filteredSkills.length;
        return next;
      });
    },
    [filteredSkills.length]
  );

  const close = useCallback(() => {
    setDismissed(true);
    setManualOpen(false);
  }, []);

  /** Open the skill picker from the + menu (or shortcut). */
  const openSkillPicker = useCallback(() => {
    setManualOpen(true);
    setDismissed(false);
  }, []);

  const selectedSkill = filteredSkills[selectedIndex] ?? null;

  return {
    isOpen,
    filteredSkills,
    selectedIndex,
    selectedSkill,
    setSelectedIndex,
    moveSelection,
    close,
    openSkillPicker,
    meetingsReferenceAllowed,
    trigger,
    triggerMode: trigger?.mode ?? (manualOpen ? ('at' as const) : null),
  };
}
