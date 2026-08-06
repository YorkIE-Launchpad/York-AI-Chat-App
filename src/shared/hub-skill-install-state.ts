/**
 * Helpers for mapping Hub catalog skills ↔ locally installed skills.
 * Hub `title`/`slug` often differ from SKILL.md `name`, so we match by
 * hub skill id (when known) and fuzzy identity, not exact title equality.
 */

export function normalizeSkillIdentity(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

export function hubSkillIdFromSkill(skill: {
  hubSkillId?: string | null;
  config?: Record<string, unknown> | null;
}): string | null {
  if (typeof skill.hubSkillId === 'string' && skill.hubSkillId.trim()) {
    return skill.hubSkillId.trim();
  }
  const fromConfig = skill.config?.hubSkillId;
  if (typeof fromConfig === 'string' && fromConfig.trim()) {
    return fromConfig.trim();
  }
  return null;
}

export function localSkillIdentityCandidates(skill: { name: string; id?: string }): string[] {
  const values = new Set<string>();
  const add = (raw: string | undefined) => {
    if (!raw?.trim()) return;
    const normalized = normalizeSkillIdentity(raw);
    if (normalized) values.add(normalized);
  };

  add(skill.name);
  if (skill.id) {
    add(skill.id);
    add(skill.id.replace(/^(global|custom|project|builtin)-/i, ''));
  }
  return [...values];
}

export function hubSkillIdentityCandidates(hubSkill: {
  id: string;
  title: string;
  slug?: string;
}): string[] {
  const values = new Set<string>();
  for (const raw of [hubSkill.title, hubSkill.slug]) {
    if (!raw?.trim()) continue;
    const normalized = normalizeSkillIdentity(raw);
    if (normalized) values.add(normalized);
  }
  return [...values];
}

/**
 * Whether a Hub catalog entry is already installed locally.
 * Prefer hubSkillId provenance; fall back to normalized name/title/slug identity.
 */
export function isHubSkillInstalled(
  hubSkill: { id: string; title: string; slug?: string },
  localSkills: Array<{
    name: string;
    id?: string;
    hubSkillId?: string | null;
    config?: Record<string, unknown> | null;
  }>,
  installedHubIds?: Iterable<string>
): boolean {
  const hubId = hubSkill.id?.trim();
  if (hubId && installedHubIds) {
    for (const id of installedHubIds) {
      if (id === hubId) return true;
    }
  }

  if (hubId) {
    for (const skill of localSkills) {
      if (hubSkillIdFromSkill(skill) === hubId) return true;
    }
  }

  const candidates = hubSkillIdentityCandidates(hubSkill);
  if (candidates.length === 0) return false;

  return localSkills.some((skill) => {
    const identities = localSkillIdentityCandidates(skill);
    return identities.some((identity) => candidates.includes(identity));
  });
}
