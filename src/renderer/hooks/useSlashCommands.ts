import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Skill } from '../types';
import { useAppStore } from '../store';

const isElectron = typeof window !== 'undefined' && window.electronAPI !== undefined;

export function isSlashCommandInput(value: string): boolean {
  return /^\/[^\n]*$/.test(value);
}

export function getSlashQuery(value: string): string {
  if (!isSlashCommandInput(value)) return '';
  return value.slice(1).trim().toLowerCase();
}

export function useSlashCommands(prompt: string) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const skillsStorageChangedAt = useAppStore((state) => state.skillsStorageChangedAt);

  const matchesSlash = isSlashCommandInput(prompt);
  // Once the user has a completed `/name ` (trailing space), keep the menu closed
  // so they can add args or send without the picker staying open.
  const hasCompletedCommand = /^\/\S+\s/.test(prompt);
  const isOpen = matchesSlash && !dismissed && !hasCompletedCommand;

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
    if (!matchesSlash) {
      setDismissed(false);
    }
  }, [matchesSlash]);

  const filteredSkills = useMemo(() => {
    if (!matchesSlash) return [];
    const query = getSlashQuery(prompt);
    if (!query) return skills;
    return skills.filter((skill) => {
      const name = skill.name.toLowerCase();
      const description = (skill.description ?? '').toLowerCase();
      return name.includes(query) || description.includes(query);
    });
  }, [matchesSlash, prompt, skills]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [prompt, filteredSkills.length]);

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
  };
}
