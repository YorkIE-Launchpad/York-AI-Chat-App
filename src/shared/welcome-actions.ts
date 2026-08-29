/**
 * Shared types for Hub profile resolution (Matter ranking, welcome copy).
 */

export interface WelcomeProfile {
  email: string;
  name: string;
  title?: string | null;
  functionName?: string | null;
  squad?: string | null;
  department?: string | null;
}

export function formatWelcomeProfileSummary(profile: WelcomeProfile): string {
  const parts = [
    profile.name,
    profile.email,
    profile.title,
    profile.functionName,
    profile.squad,
    profile.department,
  ].filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
  return parts.join(' · ');
}
