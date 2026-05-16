import { randomUUID } from 'node:crypto'
import type {
  GraphEdge,
  GraphEvent,
  GraphNode,
  GraphPayload,
  ImportRequest,
  Project,
} from '@ecto/shared'
import { db, nowIso } from './db.js'

interface NodeRow {
  id: string
  project_id: string
  type: string
  name: string
  data_json: string
  source_file_path: string | null
  source_start_line: number | null
  source_end_line: number | null
  source_start_col: number | null
  source_end_col: number | null
  created_at: string
  updated_at: string
}

interface EdgeRow {
  id: string
  project_id: string
  from_node_id: string
  to_node_id: string
  type: string
  data_json: string | null
  edge_order: number | null
  created_at: string
}

interface ProjectRow {
  id: string
  name: string
  root_path_label: string | null
  entry_node_id: string | null
  created_at: string
  updated_at: string
}

function nodeFromRow(row: NodeRow): GraphNode {
  return {
    id: row.id,
    projectId: row.project_id,
    type: row.type as GraphNode['type'],
    name: row.name,
    data: JSON.parse(row.data_json),
    source:
      row.source_file_path || row.source_start_line
        ? {
            filePath: row.source_file_path ?? undefined,
            startLine: row.source_start_line ?? undefined,
            endLine: row.source_end_line ?? undefined,
            startCol: row.source_start_col ?? undefined,
            endCol: row.source_end_col ?? undefined,
          }
        : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function edgeFromRow(row: EdgeRow): GraphEdge {
  return {
    id: row.id,
    projectId: row.project_id,
    fromNodeId: row.from_node_id,
    toNodeId: row.to_node_id,
    type: row.type as GraphEdge['type'],
    data: row.data_json ? JSON.parse(row.data_json) : undefined,
    order: row.edge_order ?? undefined,
    createdAt: row.created_at,
  }
}

function projectFromRow(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    rootPathLabel: row.root_path_label,
    entryNodeId: row.entry_node_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function listProjects(): Project[] {
  const rows = db
    .prepare('SELECT * FROM projects ORDER BY updated_at DESC')
    .all() as ProjectRow[]
  return rows.map(projectFromRow)
}

export function getProject(id: string): Project | null {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
    | ProjectRow
    | undefined
  return row ? projectFromRow(row) : null
}

export function getGraph(projectId: string): GraphPayload {
  const nodes = (
    db.prepare('SELECT * FROM graph_nodes WHERE project_id = ?').all(projectId) as NodeRow[]
  ).map(nodeFromRow)
  const edges = (
    db
      .prepare('SELECT * FROM graph_edges WHERE project_id = ? ORDER BY edge_order, created_at')
      .all(projectId) as EdgeRow[]
  ).map(edgeFromRow)
  return { nodes, edges }
}

export function getNode(projectId: string, nodeId: string): GraphNode | null {
  const row = db
    .prepare('SELECT * FROM graph_nodes WHERE project_id = ? AND id = ?')
    .get(projectId, nodeId) as NodeRow | undefined
  return row ? nodeFromRow(row) : null
}

export function importProject(req: ImportRequest): Project {
  const now = nowIso()
  const projectId = randomUUID()

  const insertProject = db.prepare(
    `INSERT INTO projects (id, name, root_path_label, entry_node_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
  const insertNode = db.prepare(
    `INSERT INTO graph_nodes
     (id, project_id, type, name, data_json,
      source_file_path, source_start_line, source_end_line, source_start_col, source_end_col,
      created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const insertEdge = db.prepare(
    `INSERT INTO graph_edges
     (id, project_id, from_node_id, to_node_id, type, data_json, edge_order, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )

  const tx = db.transaction((r: ImportRequest) => {
    insertProject.run(projectId, r.projectName, r.rootPathLabel, r.entryNodeId, now, now)
    for (const n of r.nodes) {
      insertNode.run(
        n.id,
        projectId,
        n.type,
        n.name,
        JSON.stringify(n.data ?? {}),
        n.source?.filePath ?? null,
        n.source?.startLine ?? null,
        n.source?.endLine ?? null,
        n.source?.startCol ?? null,
        n.source?.endCol ?? null,
        now,
        now,
      )
    }
    for (const e of r.edges) {
      insertEdge.run(
        e.id,
        projectId,
        e.fromNodeId,
        e.toNodeId,
        e.type,
        e.data ? JSON.stringify(e.data) : null,
        e.order ?? null,
        now,
      )
    }
    insertEvent({
      type: 'import_completed',
      projectId,
      nodeCount: r.nodes.length,
      edgeCount: r.edges.length,
    })
  })

  tx(req)
  return getProject(projectId)!
}

export function updateNodeData(
  projectId: string,
  nodeId: string,
  patch: Record<string, any>,
): GraphNode | null {
  const existing = getNode(projectId, nodeId)
  if (!existing) return null
  const merged = { ...existing.data, ...patch }
  const now = nowIso()
  db.prepare(
    `UPDATE graph_nodes SET data_json = ?, updated_at = ? WHERE project_id = ? AND id = ?`,
  ).run(JSON.stringify(merged), now, projectId, nodeId)
  const updated = getNode(projectId, nodeId)!
  insertEvent({ type: 'node_updated', projectId, node: updated })
  return updated
}

export function renameNode(
  projectId: string,
  nodeId: string,
  name: string,
): GraphNode | null {
  const existing = getNode(projectId, nodeId)
  if (!existing) return null
  const now = nowIso()
  db.prepare(
    `UPDATE graph_nodes SET name = ?, updated_at = ? WHERE project_id = ? AND id = ?`,
  ).run(name, now, projectId, nodeId)
  const updated = getNode(projectId, nodeId)!
  insertEvent({ type: 'node_updated', projectId, node: updated })
  return updated
}

export function getEdge(projectId: string, edgeId: string): GraphEdge | null {
  const row = db
    .prepare('SELECT * FROM graph_edges WHERE project_id = ? AND id = ?')
    .get(projectId, edgeId) as EdgeRow | undefined
  return row ? edgeFromRow(row) : null
}

export function updateEdgeOrder(projectId: string, edgeId: string, order: number): GraphEdge | null {
  const row = db
    .prepare('SELECT * FROM graph_edges WHERE project_id = ? AND id = ?')
    .get(projectId, edgeId) as EdgeRow | undefined
  if (!row) return null
  db.prepare(
    'UPDATE graph_edges SET edge_order = ? WHERE project_id = ? AND id = ?',
  ).run(order, projectId, edgeId)
  const updated = db
    .prepare('SELECT * FROM graph_edges WHERE id = ?')
    .get(edgeId) as EdgeRow
  return edgeFromRow(updated)
}

export function insertEvent(event: GraphEvent): void {
  const id = randomUUID()
  const now = nowIso()
  let nodeId: string | null = null
  let edgeId: string | null = null
  if ('node' in event && event.node) nodeId = event.node.id
  if ('edge' in event && event.edge) edgeId = event.edge.id
  db.prepare(
    `INSERT INTO graph_events (id, project_id, event_type, node_id, edge_id, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, event.projectId, event.type, nodeId, edgeId, JSON.stringify(event), now)
}

export function listEvents(projectId: string, limit = 50): Array<{
  id: string
  eventType: string
  payload: any
  createdAt: string
}> {
  const rows = db
    .prepare(
      `SELECT id, event_type, payload_json, created_at
       FROM graph_events WHERE project_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(projectId, limit) as Array<{
    id: string
    event_type: string
    payload_json: string | null
    created_at: string
  }>
  return rows.map((r) => ({
    id: r.id,
    eventType: r.event_type,
    payload: r.payload_json ? JSON.parse(r.payload_json) : null,
    createdAt: r.created_at,
  }))
}

export function insertSingleNode(
  projectId: string,
  node: { id: string; type: string; name: string; data: Record<string, any>; source?: any },
): GraphNode {
  const now = nowIso()
  db.prepare(
    `INSERT INTO graph_nodes
     (id, project_id, type, name, data_json,
      source_file_path, source_start_line, source_end_line, source_start_col, source_end_col,
      created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    node.id,
    projectId,
    node.type,
    node.name,
    JSON.stringify(node.data ?? {}),
    node.source?.filePath ?? null,
    node.source?.startLine ?? null,
    node.source?.endLine ?? null,
    node.source?.startCol ?? null,
    node.source?.endCol ?? null,
    now,
    now,
  )
  return getNode(projectId, node.id)!
}

export function insertSingleEdge(
  projectId: string,
  edge: { id: string; fromNodeId: string; toNodeId: string; type: string; data?: any; order?: number },
): GraphEdge {
  const now = nowIso()
  db.prepare(
    `INSERT INTO graph_edges
     (id, project_id, from_node_id, to_node_id, type, data_json, edge_order, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    edge.id,
    projectId,
    edge.fromNodeId,
    edge.toNodeId,
    edge.type,
    edge.data ? JSON.stringify(edge.data) : null,
    edge.order ?? null,
    now,
  )
  const row = db
    .prepare('SELECT * FROM graph_edges WHERE id = ?')
    .get(edge.id) as EdgeRow
  return edgeFromRow(row)
}

export function deleteSingleNode(projectId: string, nodeId: string): boolean {
  // Delete edges first (referential integrity)
  db.prepare(
    'DELETE FROM graph_edges WHERE project_id = ? AND (from_node_id = ? OR to_node_id = ?)',
  ).run(projectId, nodeId, nodeId)
  const res = db.prepare(
    'DELETE FROM graph_nodes WHERE project_id = ? AND id = ?',
  ).run(projectId, nodeId)
  return res.changes > 0
}

export function deleteSingleEdge(projectId: string, edgeId: string): boolean {
  const res = db.prepare(
    'DELETE FROM graph_edges WHERE project_id = ? AND id = ?',
  ).run(projectId, edgeId)
  return res.changes > 0
}

export function deleteProject(projectId: string): boolean {
  const res = db.prepare('DELETE FROM projects WHERE id = ?').run(projectId)
  return res.changes > 0
}

// ── Timeline / revisions ────────────────────────────────────────────

export function createRevision(
  projectId: string,
  label: string,
  source: 'import' | 'agent' | 'user_edit' | 'system',
): { id: string; revisionNumber: number; label: string; source: string; createdAt: string } {
  const id = randomUUID()
  const now = nowIso()
  const payload = getGraph(projectId)
  const snapshotJson = JSON.stringify(payload)
  const maxRow = db
    .prepare('SELECT MAX(revision_number) as mx FROM graph_revisions WHERE project_id = ?')
    .get(projectId) as { mx: number | null } | undefined
  const revisionNumber = (maxRow?.mx ?? 0) + 1
  db.prepare(
    `INSERT INTO graph_revisions (id, project_id, revision_number, snapshot_json, label, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, projectId, revisionNumber, snapshotJson, label, source, now)
  return { id, revisionNumber, label, source, createdAt: now }
}

export function listRevisions(
  projectId: string,
  limit = 200,
): Array<{ id: string; revisionNumber: number; label: string; source: string; createdAt: string }> {
  const rows = db
    .prepare(
      `SELECT id, revision_number, label, source, created_at
       FROM graph_revisions WHERE project_id = ?
       ORDER BY revision_number ASC LIMIT ?`,
    )
    .all(projectId, limit) as Array<{
    id: string
    revision_number: number
    label: string | null
    source: string | null
    created_at: string
  }>
  return rows.map((r) => ({
    id: r.id,
    revisionNumber: r.revision_number,
    label: r.label ?? '',
    source: r.source ?? 'system',
    createdAt: r.created_at,
  }))
}

export function getRevisionSnapshot(projectId: string, revisionId: string): GraphPayload | null {
  const row = db
    .prepare('SELECT snapshot_json FROM graph_revisions WHERE project_id = ? AND id = ?')
    .get(projectId, revisionId) as { snapshot_json: string | null } | undefined
  if (!row?.snapshot_json) return null
  return JSON.parse(row.snapshot_json) as GraphPayload
}
