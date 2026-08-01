/**
 * Resolve Zoom RTMS speaker display names.
 * Transcript metadata often has empty userName while userId is set;
 * fall back to a live participant roster / active-speaker events.
 */

export function extractSpeakerFromMetadata(metadata: unknown): {
  user_name?: string;
  user_id?: string | number;
} {
  if (!metadata || typeof metadata !== 'object') return {};
  const meta = metadata as Record<string, unknown>;
  const nested =
    meta.user && typeof meta.user === 'object' ? (meta.user as Record<string, unknown>) : null;

  const nameCandidates = [
    meta.userName,
    meta.user_name,
    meta.speakerName,
    meta.speaker_name,
    meta.speaker,
    nested?.userName,
    nested?.user_name,
    nested?.name,
  ];
  const idCandidates = [
    meta.userId,
    meta.user_id,
    meta.speakerUserId,
    meta.speaker_user_id,
    nested?.userId,
    nested?.user_id,
    nested?.id,
  ];

  let user_name: string | undefined;
  for (const value of nameCandidates) {
    if (typeof value === 'string' && value.trim()) {
      user_name = value.trim();
      break;
    }
  }
  let user_id: string | number | undefined;
  for (const value of idCandidates) {
    if (value != null && String(value).trim()) {
      user_id = value as string | number;
      break;
    }
  }
  return { user_name, user_id };
}

/** Metadata keys present (for diagnostic logs when speaker is unresolved). */
export function metadataKeysPresent(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== 'object') return [];
  return Object.keys(metadata as Record<string, unknown>).sort();
}

function normalizeUserId(userId: string | number | null | undefined): string | null {
  if (userId == null) return null;
  const key = String(userId).trim();
  return key || null;
}

function normalizeName(name: string | null | undefined): string | null {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  return trimmed || null;
}

export class RtmsSpeakerRoster {
  private readonly names = new Map<string, string>();
  private activeSpeakerUserId: string | null = null;
  private activeSpeakerName: string | null = null;

  get size(): number {
    return this.names.size;
  }

  get hasActiveSpeaker(): boolean {
    return !!this.activeSpeakerName;
  }

  set(userId: string | number | null | undefined, name: string | null | undefined): boolean {
    const id = normalizeUserId(userId);
    const display = normalizeName(name);
    if (!id || !display) return false;
    const prev = this.names.get(id);
    this.names.set(id, display);
    return prev !== display;
  }

  resolve(userId: string | number | null | undefined): string | null {
    const id = normalizeUserId(userId);
    if (!id) return null;
    return this.names.get(id) ?? null;
  }

  setActiveSpeaker(
    userId: string | number | null | undefined,
    name: string | null | undefined
  ): boolean {
    const id = normalizeUserId(userId);
    const display = normalizeName(name);
    if (id) this.activeSpeakerUserId = id;
    if (display) this.activeSpeakerName = display;
    if (id && display) {
      return this.set(id, display);
    }
    return false;
  }

  /**
   * Resolve display name for a transcript packet.
   * Order: metadata name → roster by userId → active speaker for that userId.
   */
  resolveForTranscript(input: { userName?: string | null; userId?: string | number | null }): {
    user_name?: string;
    user_id?: string | number;
  } {
    const fromMeta = normalizeName(input.userName ?? undefined);
    const userId = input.userId;
    const idKey = normalizeUserId(userId);

    if (fromMeta) {
      if (idKey) this.set(idKey, fromMeta);
      return { user_name: fromMeta, user_id: userId ?? undefined };
    }

    if (idKey) {
      const fromRoster = this.names.get(idKey);
      if (fromRoster) {
        return { user_name: fromRoster, user_id: userId ?? undefined };
      }
      if (this.activeSpeakerUserId === idKey && this.activeSpeakerName) {
        return { user_name: this.activeSpeakerName, user_id: userId ?? undefined };
      }
    }

    return {
      user_name: undefined,
      user_id: userId ?? undefined,
    };
  }
}
