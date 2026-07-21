import { authConfig } from '../../shared/auth-config';
import { coerceProfileImageUrl, normalizeProfileImageUrl } from './hub-parse';

const HUB_PROFILE_PATHS = ['/api/auth/me', '/api/users/me', '/api/employees/me'] as const;

function collectImageCandidates(record: Record<string, unknown> | null): unknown[] {
  if (!record) return [];
  return [
    record.profile_pic,
    record.profilePic,
    record.profile_picture,
    record.profilePicture,
    record.avatar,
    record.avatar_url,
    record.avatarUrl,
    record.photo,
    record.photo_url,
    record.photoUrl,
    record.image,
    record.picture,
    record.picture_url,
    record.pictureUrl,
  ];
}

export function extractProfileImageFromBody(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const root = body as Record<string, unknown>;
  const data =
    root.data != null && typeof root.data === 'object'
      ? (root.data as Record<string, unknown>)
      : root;

  const emp =
    data.employeeData != null && typeof data.employeeData === 'object'
      ? (data.employeeData as Record<string, unknown>)
      : null;
  const user =
    data.user != null && typeof data.user === 'object'
      ? (data.user as Record<string, unknown>)
      : null;
  const profile =
    data.profile != null && typeof data.profile === 'object'
      ? (data.profile as Record<string, unknown>)
      : null;

  const candidates = [
    ...collectImageCandidates(data),
    ...collectImageCandidates(emp),
    ...collectImageCandidates(user),
    ...collectImageCandidates(profile),
    ...collectImageCandidates(root),
  ];

  for (const candidate of candidates) {
    const raw = coerceProfileImageUrl(candidate);
    if (raw) return normalizeProfileImageUrl(raw);
  }
  return null;
}

export async function fetchHubProfileImage(accessToken: string): Promise<string | null> {
  const token = accessToken.trim();
  if (!token) return null;

  for (const path of HUB_PROFILE_PATHS) {
    try {
      const res = await fetch(`${authConfig.hubApiUrl}${path}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      });
      if (!res.ok) continue;
      const body = (await res.json()) as unknown;
      const image = extractProfileImageFromBody(body);
      if (image) return image;
    } catch {
      // try next endpoint
    }
  }
  return null;
}
