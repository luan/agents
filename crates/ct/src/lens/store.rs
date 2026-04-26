use std::path::Path;

use rusqlite::{Connection, params};

use super::paths;
use super::types::{PatchDraftChunk, PatchDraftSummary};

const SCHEMA_VERSION: i32 = 2;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    root TEXT NOT NULL UNIQUE,
    vcs_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    rel_path TEXT NOT NULL,
    language TEXT,
    ignored INTEGER NOT NULL DEFAULT 0,
    hash TEXT,
    mtime_ns INTEGER,
    size_bytes INTEGER,
    line_count INTEGER,
    UNIQUE(project_id, rel_path)
);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    agent TEXT,
    started_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS read_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    file_hash TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS read_ranges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    read_event_id INTEGER NOT NULL REFERENCES read_events(id) ON DELETE CASCADE,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS patch_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    old_hash TEXT,
    new_hash TEXT,
    tool TEXT NOT NULL,
    accepted INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS patch_hunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patch_event_id INTEGER NOT NULL REFERENCES patch_events(id) ON DELETE CASCADE,
    old_start INTEGER,
    old_end INTEGER,
    new_start INTEGER,
    new_end INTEGER
);

CREATE TABLE IF NOT EXISTS patch_drafts (
    id TEXT PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    session_id TEXT,
    cwd TEXT NOT NULL,
    status TEXT NOT NULL,
    patch_sha TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    applied_at INTEGER
);

CREATE TABLE IF NOT EXISTS patch_draft_bodies (
    patch_id TEXT PRIMARY KEY REFERENCES patch_drafts(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    body_bytes INTEGER NOT NULL,
    first_seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS patch_draft_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patch_id TEXT NOT NULL REFERENCES patch_drafts(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    file_path TEXT NOT NULL,
    change_type TEXT NOT NULL,
    status TEXT NOT NULL,
    old_start INTEGER,
    old_end INTEGER,
    new_start INTEGER,
    new_end INTEGER,
    error_kind TEXT,
    error_message TEXT,
    UNIQUE(patch_id, chunk_index)
);

CREATE TABLE IF NOT EXISTS patch_draft_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patch_id TEXT NOT NULL REFERENCES patch_drafts(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    line INTEGER NOT NULL,
    suggested_anchor TEXT,
    enclosing_symbol TEXT,
    enclosing_kind TEXT,
    symbol_start INTEGER,
    symbol_end INTEGER
);

CREATE TABLE IF NOT EXISTS patch_affected_symbols (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patch_event_id INTEGER NOT NULL REFERENCES patch_events(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    symbol_name TEXT,
    symbol_kind TEXT,
    old_start INTEGER,
    old_end INTEGER,
    new_start INTEGER,
    new_end INTEGER
);

CREATE TABLE IF NOT EXISTS diagnostics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    file_id INTEGER REFERENCES files(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    severity TEXT NOT NULL,
    code TEXT,
    message TEXT NOT NULL,
    start_line INTEGER,
    end_line INTEGER,
    fingerprint TEXT NOT NULL,
    content_hash TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE(project_id, source, fingerprint)
);

CREATE TABLE IF NOT EXISTS tool_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    tool TEXT NOT NULL,
    status TEXT NOT NULL,
    file_count INTEGER NOT NULL,
    diagnostic_count INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS retention_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_files_project_rel ON files(project_id, rel_path);
CREATE INDEX IF NOT EXISTS idx_diagnostics_project_file ON diagnostics(project_id, file_id);
CREATE INDEX IF NOT EXISTS idx_read_events_session_file ON read_events(session_id, file_id);
CREATE INDEX IF NOT EXISTS idx_patch_drafts_project_status ON patch_drafts(project_id, status);
CREATE INDEX IF NOT EXISTS idx_patch_draft_chunks_patch ON patch_draft_chunks(patch_id);
"#;

pub struct LensStore {
    conn: Connection,
    project_id: i64,
}

pub struct NewPatchDraft<'a> {
    pub id: &'a str,
    pub cwd: &'a str,
    pub session_id: Option<&'a str>,
    pub status: &'a str,
    pub patch_sha: &'a str,
    pub body: &'a str,
    pub chunks: &'a [PatchDraftChunk],
}

impl LensStore {
    pub fn open_for_project(root: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        let dir = paths::project_state_dir(root)?;
        std::fs::create_dir_all(&dir)?;
        let conn = Connection::open(paths::project_db_path(root)?)?;
        Self::init(conn, root)
    }

    #[cfg(test)]
    pub fn open_in_memory_for_tests(root: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        Self::init(Connection::open_in_memory()?, root)
    }

    fn init(conn: Connection, root: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "busy_timeout", 5000)?;
        let current: i32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if current > SCHEMA_VERSION {
            return Err(format!(
                "lens store schema version {current} is newer than supported {SCHEMA_VERSION}"
            )
            .into());
        }
        if current < SCHEMA_VERSION {
            conn.execute_batch(SCHEMA)?;
            conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        }
        let now = now_ms();
        let root = root.canonicalize()?.to_string_lossy().to_string();
        conn.execute(
            "INSERT INTO projects (root, vcs_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?3)
             ON CONFLICT(root) DO UPDATE SET updated_at = excluded.updated_at",
            params![root, Option::<String>::None, now],
        )?;
        let project_id = conn.query_row(
            "SELECT id FROM projects WHERE root = ?1",
            params![root],
            |row| row.get(0),
        )?;
        Ok(Self { conn, project_id })
    }

    pub fn project_id(&self) -> i64 {
        self.project_id
    }

    pub fn counts(&self) -> Result<StoreCounts, rusqlite::Error> {
        Ok(StoreCounts {
            files: self.count("files")?,
            sessions: self.count("sessions")?,
            diagnostics: self.count("diagnostics")?,
            tool_runs: self.count("tool_runs")?,
            patch_drafts: self.count("patch_drafts")?,
            patch_draft_bodies: self.count("patch_draft_bodies")?,
        })
    }

    fn count(&self, table: &str) -> Result<i64, rusqlite::Error> {
        self.conn
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
    }

    pub fn with_conn<R>(&self, f: impl FnOnce(&Connection) -> R) -> R {
        f(&self.conn)
    }

    pub fn create_patch_draft(
        &mut self,
        draft: NewPatchDraft<'_>,
    ) -> Result<PatchDraftSummary, rusqlite::Error> {
        let now = now_ms();
        let body_bytes = draft.body.len() as i64;
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO patch_drafts (id, project_id, session_id, cwd, status, patch_sha, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
             ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at",
            params![draft.id, self.project_id, draft.session_id, draft.cwd, draft.status, draft.patch_sha, now],
        )?;
        tx.execute(
            "INSERT INTO patch_draft_bodies (patch_id, body, body_bytes, first_seen_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(patch_id) DO UPDATE SET body = excluded.body, body_bytes = excluded.body_bytes",
            params![draft.id, draft.body, body_bytes, now],
        )?;
        tx.execute(
            "DELETE FROM patch_draft_chunks WHERE patch_id = ?1",
            params![draft.id],
        )?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO patch_draft_chunks
                 (patch_id, chunk_index, file_path, change_type, status, old_start, old_end, new_start, new_end, error_kind, error_message)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            )?;
            for chunk in draft.chunks {
                stmt.execute(params![
                    draft.id,
                    chunk.chunk_index,
                    chunk.file_path,
                    chunk.change_type,
                    chunk.status,
                    chunk.old_start,
                    chunk.old_end,
                    chunk.new_start,
                    chunk.new_end,
                    chunk.error_kind,
                    chunk.error_message,
                ])?;
            }
        }
        tx.commit()?;
        Ok(PatchDraftSummary {
            id: draft.id.to_string(),
            status: draft.status.to_string(),
            patch_sha: draft.patch_sha.to_string(),
            body_bytes,
            created_at: now,
            updated_at: now,
        })
    }

    pub fn patch_draft_status(
        &self,
        id: &str,
    ) -> Result<Option<PatchDraftSummary>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT d.id, d.status, d.patch_sha, COALESCE(b.body_bytes, 0), d.created_at, d.updated_at
             FROM patch_drafts d
             LEFT JOIN patch_draft_bodies b ON b.patch_id = d.id
             WHERE d.id = ?1 AND d.project_id = ?2",
        )?;
        let mut rows = stmt.query(params![id, self.project_id])?;
        let Some(row) = rows.next()? else {
            return Ok(None);
        };
        Ok(Some(PatchDraftSummary {
            id: row.get(0)?,
            status: row.get(1)?,
            patch_sha: row.get(2)?,
            body_bytes: row.get(3)?,
            created_at: row.get(4)?,
            updated_at: row.get(5)?,
        }))
    }

    pub fn patch_draft_chunks(&self, id: &str) -> Result<Vec<PatchDraftChunk>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT chunk_index, file_path, change_type, status, old_start, old_end, new_start, new_end, error_kind, error_message
             FROM patch_draft_chunks
             WHERE patch_id = ?1
             ORDER BY chunk_index ASC",
        )?;
        stmt.query_map(params![id], |row| {
            Ok(PatchDraftChunk {
                chunk_index: row.get(0)?,
                file_path: row.get(1)?,
                change_type: row.get(2)?,
                status: row.get(3)?,
                old_start: row.get(4)?,
                old_end: row.get(5)?,
                new_start: row.get(6)?,
                new_end: row.get(7)?,
                error_kind: row.get(8)?,
                error_message: row.get(9)?,
            })
        })?
        .collect()
    }

    pub fn patch_draft_body(&self, id: &str) -> Result<Option<String>, rusqlite::Error> {
        let mut stmt = self
            .conn
            .prepare("SELECT body FROM patch_draft_bodies WHERE patch_id = ?1")?;
        let mut rows = stmt.query(params![id])?;
        let Some(row) = rows.next()? else {
            return Ok(None);
        };
        Ok(Some(row.get(0)?))
    }

    pub fn discard_patch_draft(&self, id: &str) -> Result<bool, rusqlite::Error> {
        Ok(self
            .conn
            .execute("DELETE FROM patch_drafts WHERE id = ?1", params![id])?
            > 0)
    }
}

#[derive(Debug, serde::Serialize)]
pub struct StoreCounts {
    pub files: i64,
    pub sessions: i64,
    pub diagnostics: i64,
    pub tool_runs: i64,
    pub patch_drafts: i64,
    pub patch_draft_bodies: i64,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_schema_in_memory() {
        let temp = tempfile::tempdir().unwrap();
        let store = LensStore::open_in_memory_for_tests(temp.path()).unwrap();
        let counts = store.counts().unwrap();
        assert_eq!(counts.files, 0);
        assert!(store.project_id() > 0);
    }
}
