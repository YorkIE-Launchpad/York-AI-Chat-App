/**
 * Workflow store — versioned graph definitions in SQLite.
 */
import { v4 as uuidv4 } from 'uuid';
import type { DatabaseInstance } from '../db/database';
import type {
  WorkflowDefinition,
  WorkflowDefinitionInput,
  WorkflowGraph,
  WorkflowStatus,
} from '../../shared/workflows';
import { WORKFLOW_SCHEMA_VERSION, createEmptyWorkflowGraph } from '../../shared/workflows';

export interface WorkflowRow {
  id: string;
  name: string;
  description: string;
  status: string;
  graph_json: string;
  schedule_task_id: string | null;
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

export function mapWorkflowRow(row: WorkflowRow): WorkflowDefinition {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status as WorkflowStatus,
    graph: parseGraph(row.graph_json),
    scheduleTaskId: row.schedule_task_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class WorkflowStore {
  constructor(private readonly db: DatabaseInstance) {}

  create(input: WorkflowDefinitionInput): WorkflowDefinition {
    const now = Date.now();
    const id = uuidv4();
    this.db
      .prepare(
        `INSERT INTO workflows
         (id, name, description, status, graph_json, schedule_task_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`
      )
      .run(
        id,
        input.name.trim() || 'Untitled workflow',
        input.description?.trim() || '',
        input.status || 'draft',
        JSON.stringify(input.graph),
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

  update(
    id: string,
    updates: Partial<
      Pick<WorkflowDefinition, 'name' | 'description' | 'status' | 'graph' | 'scheduleTaskId'>
    >
  ): WorkflowDefinition | null {
    const existing = this.get(id);
    if (!existing) return null;
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE workflows
         SET name = ?, description = ?, status = ?, graph_json = ?, schedule_task_id = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        updates.name ?? existing.name,
        updates.description ?? existing.description,
        updates.status ?? existing.status,
        JSON.stringify(updates.graph ?? existing.graph),
        updates.scheduleTaskId !== undefined
          ? updates.scheduleTaskId
          : existing.scheduleTaskId,
        now,
        id
      );
    return this.get(id);
  }

  delete(id: string): boolean {
    return this.db.prepare(`DELETE FROM workflows WHERE id = ?`).run(id).changes > 0;
  }
}
