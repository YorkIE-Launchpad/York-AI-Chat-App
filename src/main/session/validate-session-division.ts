/**
 * Server-side validation of session division fields against user allocations.
 * Forged IPC payloads are demoted to general rather than rejected outright.
 */
import type { ServerEvent } from '../../renderer/types';
import {
  divisionFieldsMatchCatalog,
  normalizeSessionDivision,
  type DivisionValidationCatalog,
  type SessionDivisionFields,
  type WorkspaceDivisionKind,
} from '../../shared/workspace-division';
import { listUnifiedCompanyProjects } from '../launchpad/unified-projects';
import type { DatabaseInstance } from '../db/database';
import { logWarn } from '../utils/logger';

export type SessionDivisionOptions = {
  division?: WorkspaceDivisionKind;
  hubProjectId?: string | null;
  hubProjectName?: string | null;
  launchpadProjectId?: number | null;
  launchpadProjectName?: string | null;
  folderId?: string | null;
  folderName?: string | null;
  canonicalKey?: string | null;
  clientName?: string | null;
  clientProjectIds?: string | null;
};

export type ValidatedSessionDivisionResult = {
  fields: SessionDivisionFields;
  demoted: boolean;
  reason?: string;
};

let catalogCache: { catalog: DivisionValidationCatalog; fetchedAt: number } | null = null;
const CATALOG_CACHE_TTL_MS = 60_000;

async function loadValidationCatalog(db: DatabaseInstance | null): Promise<DivisionValidationCatalog> {
  const now = Date.now();
  if (catalogCache && now - catalogCache.fetchedAt < CATALOG_CACHE_TTL_MS) {
    return catalogCache.catalog;
  }

  const [{ projects }, folders] = await Promise.all([
    listUnifiedCompanyProjects(),
    Promise.resolve(db?.folders.list() ?? []),
  ]);

  const catalog: DivisionValidationCatalog = {
    projects,
    folderIds: new Set(folders.map((f) => f.id)),
  };
  catalogCache = { catalog, fetchedAt: now };
  return catalog;
}

/** Test helper — clear cached catalog between tests. */
export function clearSessionDivisionValidationCache(): void {
  catalogCache = null;
}

export function validateSessionDivisionAgainstCatalog(
  input: SessionDivisionOptions | null | undefined,
  catalog: DivisionValidationCatalog
): ValidatedSessionDivisionResult {
  const normalized = normalizeSessionDivision(input ?? { division: 'general' });
  if (normalized.division === 'general' || normalized.division === 'hub') {
    return { fields: normalized, demoted: false };
  }

  const match = divisionFieldsMatchCatalog(normalized, catalog);
  if (match.valid) {
    return { fields: normalized, demoted: false };
  }

  logWarn(
    `[SessionDivision] Demoted ${normalized.division} workspace to general — ${match.reason}`,
    {
      division: normalized.division,
      hubProjectId: normalized.hubProjectId,
      launchpadProjectId: normalized.launchpadProjectId,
      clientName: normalized.clientName,
      folderId: normalized.folderId,
    }
  );

  return {
    fields: normalizeSessionDivision({ division: 'general' }),
    demoted: true,
    reason: match.reason,
  };
}

export async function validateSessionDivisionAgainstAllocations(
  input: SessionDivisionOptions | null | undefined,
  db: DatabaseInstance | null
): Promise<ValidatedSessionDivisionResult> {
  const catalog = await loadValidationCatalog(db);
  return validateSessionDivisionAgainstCatalog(input, catalog);
}

export function emitSessionDivisionDemotionNotice(
  sendToRenderer: ((event: ServerEvent) => void) | null | undefined,
  reason?: string
): void {
  if (!sendToRenderer) return;
  sendToRenderer({
    type: 'notice',
    payload: {
      message:
        'Workspace scope could not be verified against your project allocations. This chat was opened in General mode instead.',
      noticeType: 'warning',
      code: 'SESSION_DIVISION_DEMOTED',
      ...(reason ? { detail: reason } : {}),
    },
  });
}

/** Merge validated division fields into session start/create options. */
export async function resolveValidatedSessionDivisionOptions<T extends SessionDivisionOptions>(
  options: T | null | undefined,
  deps: {
    db: DatabaseInstance | null;
    sendToRenderer?: ((event: ServerEvent) => void) | null;
  }
): Promise<T & SessionDivisionFields> {
  const validated = await validateSessionDivisionAgainstAllocations(options, deps.db);
  if (validated.demoted) {
    emitSessionDivisionDemotionNotice(deps.sendToRenderer, validated.reason);
  }
  const { division, ...rest } = validated.fields;
  return {
    ...(options ?? ({} as T)),
    division,
    hubProjectId: rest.hubProjectId,
    hubProjectName: rest.hubProjectName,
    launchpadProjectId: rest.launchpadProjectId,
    launchpadProjectName: rest.launchpadProjectName,
    folderId: rest.folderId,
    folderName: rest.folderName,
    canonicalKey: rest.canonicalKey,
    clientName: rest.clientName,
    clientProjectIds: rest.clientProjectIds,
  } as T & SessionDivisionFields;
}
