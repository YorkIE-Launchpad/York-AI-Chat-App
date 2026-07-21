import { authConfig } from '../../shared/auth-config';

export interface ParsedHubAuth {
  token: string;
  idToken: string;
  accessToken: string;
  refreshToken: string | null;
  user: Record<string, unknown>;
  employeeData: Record<string, unknown> | null;
}

function rewriteHubDocumentPath(url: string): string {
  try {
    const parsed = new URL(url);
    const hubHost = new URL(authConfig.hubApiUrl).host;
    if (parsed.host !== hubHost) return url;
    if (parsed.pathname.startsWith('/documents/')) {
      parsed.pathname = `/api${parsed.pathname}`;
      return parsed.toString();
    }
  } catch {
    // ignore invalid URLs
  }
  return url;
}

export function normalizeProfileImageUrl(url: string): string {
  const trimmed = url.trim();
  let resolved: string;
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('data:') || trimmed.startsWith('blob:')) {
    resolved = trimmed;
  } else {
    const base = authConfig.hubApiUrl.replace(/\/$/, '');
    const path = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    resolved = `${base}${path.startsWith('/documents/') ? `/api${path}` : path}`;
  }
  return rewriteHubDocumentPath(resolved);
}

export function coerceProfileImageUrl(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return (
      coerceProfileImageUrl(record.url) ??
      coerceProfileImageUrl(record.href) ??
      coerceProfileImageUrl(record.src)
    );
  }
  return null;
}

export function parseHubAuthResponse(body: unknown): ParsedHubAuth | null {
  if (!body || typeof body !== 'object') return null;
  const root = body as Record<string, unknown>;
  const d =
    root.data != null && typeof root.data === 'object'
      ? (root.data as Record<string, unknown>)
      : root;

  const idToken = (d.idToken ?? d.id_token ?? root.idToken ?? root.id_token) as string | undefined;
  const accessToken = (d.accessToken ?? d.access_token ?? root.accessToken ?? root.access_token) as
    | string
    | undefined;
  const refreshToken = (d.refreshToken ??
    d.refresh_token ??
    root.refreshToken ??
    root.refresh_token) as string | undefined;
  const launchpadToken = idToken ?? accessToken ?? (d.token as string) ?? (root.token as string);
  if (!launchpadToken) return null;

  const emp =
    d.employeeData && typeof d.employeeData === 'object'
      ? (d.employeeData as Record<string, unknown>)
      : null;
  const nameFromEmp =
    emp?.first_name != null || emp?.last_name != null
      ? [emp.first_name, emp.last_name].filter(Boolean).join(' ').trim()
      : null;
  const imageFromEmp = coerceProfileImageUrl(
    emp?.profile_pic ??
      emp?.profilePic ??
      emp?.profile_picture ??
      emp?.avatar ??
      emp?.avatar_url ??
      emp?.image ??
      d.picture ??
      d.image ??
      root.picture ??
      root.image
  );

  let user = (d.user || d.userProfile || d.profile || root.user) as unknown;
  if (user && typeof user === 'string') {
    try {
      user = JSON.parse(user) as Record<string, unknown>;
    } catch {
      user = null;
    }
  }
  if (!user || typeof user !== 'object') {
    user = {
      id: emp?.employee_id ?? d.id ?? root.id ?? 'user',
      email: emp?.email ?? d.email ?? root.email ?? '',
      name: nameFromEmp ?? d.name ?? d.username ?? root.name ?? 'User',
      image: imageFromEmp,
    };
  } else if (emp) {
    const u = user as Record<string, unknown>;
    user = {
      ...u,
      image: imageFromEmp ?? coerceProfileImageUrl(u.image ?? u.picture),
      name: nameFromEmp || u.name,
      email: emp.email ?? u.email,
    };
  } else {
    const u = user as Record<string, unknown>;
    const image = imageFromEmp ?? coerceProfileImageUrl(u.image ?? u.picture);
    user = image ? { ...u, image } : u;
  }

  return {
    token: launchpadToken,
    idToken: idToken ?? '',
    accessToken: accessToken ?? '',
    refreshToken: refreshToken || null,
    user: user as Record<string, unknown>,
    employeeData: emp,
  };
}

export function getHubProfileEmail(parsed: ParsedHubAuth | null | undefined): string | null {
  if (!parsed) return null;
  const emp = parsed.employeeData;
  const user = parsed.user;
  const candidates = [user?.email, emp?.email, user?.preferred_username, user?.username].filter(
    (v): v is string => typeof v === 'string' && v.includes('@')
  );
  return candidates[0]?.trim() || null;
}

export function getHubProfileName(parsed: ParsedHubAuth | null | undefined): string | null {
  if (!parsed) return null;
  const emp = parsed.employeeData;
  const fromEmp = [emp?.first_name, emp?.last_name].filter(Boolean).join(' ').trim();
  const user = parsed.user;
  if (typeof user?.name === 'string' && user.name.trim()) return user.name.trim();
  if (fromEmp) return fromEmp;
  return null;
}

export function getHubProfileImage(parsed: ParsedHubAuth | null | undefined): string | null {
  if (!parsed) return null;
  const emp = parsed.employeeData;
  const user = parsed.user;
  const raw =
    coerceProfileImageUrl(user?.image ?? user?.picture ?? user?.avatar ?? user?.profile_pic) ??
    coerceProfileImageUrl(
      emp?.profile_pic ??
        emp?.profilePic ??
        emp?.profile_picture ??
        emp?.avatar ??
        emp?.avatar_url ??
        emp?.image
    );
  return raw ? normalizeProfileImageUrl(raw) : null;
}
