import Database, { type Database as DatabaseType } from 'better-sqlite3'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.env.ECTO_DB ?? path.join(__dirname, '..', 'ecto.db')

export const db: DatabaseType = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

// Schema mirrors the Postgres shape described in the spec. Using SQLite for
// zero-setup MVP; the node/edge/event model is DB-agnostic.
db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    root_path_label TEXT,
    entry_node_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS graph_nodes (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    data_json TEXT NOT NULL,
    source_file_path TEXT,
    source_start_line INTEGER,
    source_end_line INTEGER,
    source_start_col INTEGER,
    source_end_col INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_nodes_project ON graph_nodes(project_id);
  CREATE INDEX IF NOT EXISTS idx_nodes_type ON graph_nodes(project_id, type);

  CREATE TABLE IF NOT EXISTS graph_edges (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    from_node_id TEXT NOT NULL,
    to_node_id TEXT NOT NULL,
    type TEXT NOT NULL,
    data_json TEXT,
    edge_order INTEGER,
    created_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_edges_project ON graph_edges(project_id);
  CREATE INDEX IF NOT EXISTS idx_edges_from ON graph_edges(from_node_id);
  CREATE INDEX IF NOT EXISTS idx_edges_to ON graph_edges(to_node_id);
  CREATE INDEX IF NOT EXISTS idx_edges_type ON graph_edges(project_id, type);

  CREATE TABLE IF NOT EXISTS graph_events (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    node_id TEXT,
    edge_id TEXT,
    payload_json TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_events_project ON graph_events(project_id, created_at);

  CREATE TABLE IF NOT EXISTS graph_revisions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    revision_number INTEGER NOT NULL,
    snapshot_json TEXT,
    label TEXT,
    source TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_revisions_project ON graph_revisions(project_id, revision_number);
`)

// Migrate graph_revisions if it exists without the new columns
try {
  db.exec(`ALTER TABLE graph_revisions ADD COLUMN label TEXT`)
} catch { /* column already exists */ }
try {
  db.exec(`ALTER TABLE graph_revisions ADD COLUMN source TEXT`)
} catch { /* column already exists */ }

export function nowIso(): string {
  return new Date().toISOString()
}
