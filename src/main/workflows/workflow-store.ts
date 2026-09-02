/**
 * Workflow store — versioned graph definitions in SQLite.
 */
import { v4 as uuidv4 } from 'uuid';
import type { DatabaseInstance } from '../db/database';
import type {
  WorkflowBinding,
  WorkflowDefinition,
  WorkflowDefinitionInput,
  WorkflowGraph,
  WorkflowStatus,
} from '../../shared/workflows';
import {
  WORKFLOW_SCHEMA_VERSION,
  buildWorkflowTitle,
  createEmptyWorkflowGraph,
  normalizeWorkflowBinding,
} from '../../shared/workflows';

export interface WorkflowRow {
  id: string;
  name: string;
  description: string;
  status: string;
  graph_json: string;
  schedule_task_id: string | null;
  division?: string | null;
  hub_project_id?: string | null;
  hub_project_name?: string | null;
  launchpad_project_id?: number | null;
  launchpad_project_name?: string | null;
  folder_id?: string | null;
  folder_name?: string | null;
  project_canonical_key?: string | null;
  created_at: number;
  updated_at: number;
}

function parseGraph(raw: string): WorkflowGraph {
  try {
    const parsed = JSON.parse(raw) as WorkflowGraph;
    if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
      return createEmptyWorkflowGraph();
    }
    return {
      version: WORKFLOW_SCHEMA_VERSION,
      nodes: parsed.nodes,
      edges: parsed.edges,
    };
  } catch {
    return createEmptyWorkflowGraph();
  }
}

function bindingFromRow(row: WorkflowRow): WorkflowBinding {
  return normalizeWorkflowBinding({
    division: (row.division as WorkflowBinding['division']) || 'general',
    hubProjectId: row.hub_project_id ?? null,
    hubProjectName: row.hub_project_name ?? null,
    launchpadProjectId: row.launchpad_project_id ?? null,
    launchpadProjectName: row.launchpad_project_name ?? null,
    folderId: row.folder_id ?? null,
    folderName: row.folder_name ?? null,
    canonicalKey: row.project_canonical_key ?? null,
  });
}

function bindingFromInput(input: Partial<WorkflowDefinitionInput>): WorkflowBinding {
  return normalizeWorkflowBinding({
    division: input.division,
    hubProjectId: input.hubProjectId,
    hubProjectName: input.hubProjectName,
    launchpadProjectId: input.launchpadProjectId,
    launchpadProjectName: input.launchpadProjectName,
    folderId: input.folderId,
    folderName: input.folderName,
    canonicalKey: input.canonicalKey,
  });
}

export function mapWorkflowRow(row: WorkflowRow): WorkflowDefinition {
  const binding = bindingFromRow(row);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status as WorkflowStatus,
    graph: parseGraph(row.graph_json),
    scheduleTaskId: row.schedule_task_id,
    division: binding.division,
    hubProjectId: binding.hubProjectId ?? null,
    hubProjectName: binding.hubProjectName ?? null,
    launchpadProjectId: binding.launchpadProjectId ?? null,
    launchpadProjectName: binding.launchpadProjectName ?? null,
    folderId: binding.folderId ?? null,
    folderName: binding.folderName ?? null,
    canonicalKey: binding.canonicalKey ?? null,
    clientName: binding.clientName ?? null,
    clientProjectIds: binding.clientProjectIds ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type WorkflowUpdateFields = Partial<
  Pick<
    WorkflowDefinition,
    | 'name'
    | 'description'
    | 'status'
    | 'graph'
    | 'scheduleTaskId'
    | 'division'
    | 'hubProjectId'
    | 'hubProjectName'
    | 'launchpadProjectId'
    | 'launchpadProjectName'
    | 'folderId'
    | 'folderName'
    | 'canonicalKey'
  >
>;

export class WorkflowStore {
  constructor(private readonly db: DatabaseInstance) {}

  create(input: WorkflowDefinitionInput): WorkflowDefinition {
    const now = Date.now();
    const id = uuidv4();
    const binding = bindingFromInput(input);
    this.db
      .prepare(
        `INSERT INTO workflows
         (id, name, description, status, graph_json, schedule_task_id,
          division, hub_project_id, hub_project_name, launchpad_project_id, launchpad_project_name,
          folder_id, folder_name, project_canonical_key,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        buildWorkflowTitle(input.name.trim() || 'Untitled workflow'),
        input.description?.trim() || '',
        input.status || 'draft',
        JSON.stringify(input.graph),
        binding.division,
        binding.hubProjectId,
        binding.hubProjectName,
        binding.launchpadProjectId,
        binding.launchpadProjectName,
        binding.folderId,
        binding.folderName,
        binding.canonicalKey,
        now,
        now
      );
    return this.get(id)!;
  }

  get(id: string): WorkflowDefinition | null {
    const row = this.db.prepare(`SELECT * FROM workflows WHERE id = ?`).get(id) as
      | WorkflowRow
      | undefined;
    return row ? mapWorkflowRow(row) : null;
  }

  list(): WorkflowDefinition[] {
    const rows = this.db
      .prepare(`SELECT * FROM workflows ORDER BY updated_at DESC`)
      .all() as WorkflowRow[];
    return rows.map(mapWorkflowRow);
  }

  update(id: string, updates: WorkflowUpdateFields): WorkflowDefinition | null {
    const existing = this.get(id);
    if (!existing) return null;
    const now = Date.now();

    const bindingKeysTouched =
      updates.division !== undefined ||
      updates.hubProjectId !== undefined ||
      updates.hubProjectName !== undefined ||
      updates.launchpadProjectId !== undefined ||
      updates.launchpadProjectName !== undefined ||
      updates.folderId !== undefined ||
      updates.folderName !== undefined ||
      updates.canonicalKey !== undefined;

    const binding = bindingKeysTouched
      ? normalizeWorkflowBinding({
          division: updates.division ?? existing.division,
          hubProjectId:
            updates.hubProjectId !== undefined ? updates.hubProjectId : existing.hubProjectId,
          hubProjectName:
            updates.hubProjectName !== undefined
              ? updates.hubProjectName
              : existing.hubProjectName,
          launchpadProjectId:
            updates.launchpadProjectId !== undefined
              ? updates.launchpadProjectId
              : existing.launchpadProjectId,
          launchpadProjectName:
            updates.launchpadProjectName !== undefined
              ? updates.launchpadProjectName
              : existing.launchpadProjectName,
          folderId: updates.folderId !== undefined ? updates.folderId : existing.folderId,
          folderName:
            updates.folderName !== undefined ? updates.folderName : existing.folderName,
          canonicalKey:
            updates.canonicalKey !== undefined ? updates.canonicalKey : existing.canonicalKey,
        })
      : normalizeWorkflowBinding(existing);

    const name =
      updates.name !== undefined
        ? buildWorkflowTitle(updates.name)
        : existing.name;

    this.db
      .prepare(
        `UPDATE workflows
         SET name = ?, description = ?, status = ?, graph_json = ?, schedule_task_id = ?,
             division = ?, hub_project_id = ?, hub_project_name = ?,
             launchpad_project_id = ?, launchpad_project_name = ?,
             folder_id = ?, folder_name = ?, project_canonical_key = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .run(
        name,
        updates.description ?? existing.description,
        updates.status ?? existing.status,
        JSON.stringify(updates.graph ?? existing.graph),
        updates.scheduleTaskId !== undefined
          ? updates.scheduleTaskId
          : existing.scheduleTaskId,
        binding.division,
        binding.hubProjectId,
        binding.hubProjectName,
        binding.launchpadProjectId,
        binding.launchpadProjectName,
        binding.folderId,
        binding.folderName,
        binding.canonicalKey,
        now,
        id
      );
    return this.get(id);
  }

  delete(id: string): boolean {
    return this.db.prepare(`DELETE FROM workflows WHERE id = ?`).run(id).changes > 0;
  }
}
