use std::path::Path;

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

const SCHEMA_VERSION: i32 = 1;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    root TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
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
    symbol_end INTEGER,
    candidate_kind TEXT,
    symbol_json TEXT,
    anchors_json TEXT,
    confidence TEXT,
    reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_patch_drafts_project_status ON patch_drafts(project_id, status);
CREATE INDEX IF NOT EXISTS idx_patch_draft_chunks_patch ON patch_draft_chunks(patch_id);
"#;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PatchDraftSummary {
    pub id: String,
    pub status: String,
    pub patch_sha: String,
    pub body_bytes: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PatchDraftChunk {
    pub chunk_index: i64,
    pub file_path: String,
    pub change_type: String,
    pub status: String,
    pub old_start: Option<i64>,
    pub old_end: Option<i64>,
    pub new_start: Option<i64>,
    pub new_end: Option<i64>,
    pub error_kind: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PatchRepairSymbol {
    pub name: String,
    pub kind: String,
    pub start_line: i64,
    pub end_line: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PatchCandidate {
    pub chunk_index: i64,
    pub line: i64,
    pub suggested_anchor: Option<String>,
    pub enclosing_symbol: Option<String>,
    pub enclosing_kind: Option<String>,
    pub symbol_start: Option<i64>,
    pub symbol_end: Option<i64>,
    pub candidate_kind: String,
    pub symbol: Option<PatchRepairSymbol>,
    pub anchors: Vec<String>,
    pub confidence: String,
    pub reason: String,
}

pub struct NewPatchDraft<'a> {
    pub id: &'a str,
    pub cwd: &'a str,
    pub session_id: Option<&'a str>,
    pub status: &'a str,
    pub patch_sha: &'a str,
    pub body: &'a str,
    pub chunks: &'a [PatchDraftChunk],
    pub candidates: &'a [PatchCandidate],
}

pub struct PatchDraftStore {
    conn: Connection,
    project_id: i64,
}

impl PatchDraftStore {
    pub fn open_for_project(root: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        let dir = crate::state::project_state_dir(root)?;
        std::fs::create_dir_all(&dir)?;
        let conn = Connection::open(dir.join("apply-patch-drafts.sqlite"))?;
        Self::init(conn, root)
    }

    fn init(conn: Connection, root: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "busy_timeout", 5000)?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let current: i32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if current > SCHEMA_VERSION {
            return Err(format!(
                "apply-patch draft store schema version {current} is newer than supported {SCHEMA_VERSION}"
            )
            .into());
        }
        conn.execute_batch(SCHEMA)?;
        if current < SCHEMA_VERSION {
            conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        }

        let now = now_ms();
        let root = root.canonicalize()?;
        let root_text = root.to_string_lossy().to_string();
        conn.execute(
            "INSERT INTO projects (root, created_at, updated_at)
             VALUES (?1, ?2, ?2)
             ON CONFLICT(root) DO UPDATE SET updated_at = excluded.updated_at",
            params![root_text, now],
        )?;
        let project_id = conn.query_row(
            "SELECT id FROM projects WHERE root = ?1",
            params![root_text],
            |row| row.get(0),
        )?;
        Ok(Self { conn, project_id })
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
        tx.execute(
            "DELETE FROM patch_draft_candidates WHERE patch_id = ?1",
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
        {
            let mut stmt = tx.prepare(
                "INSERT INTO patch_draft_candidates
                 (patch_id, chunk_index, line, suggested_anchor, enclosing_symbol, enclosing_kind, symbol_start, symbol_end, candidate_kind, symbol_json, anchors_json, confidence, reason)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            )?;
            for candidate in draft.candidates {
                let symbol_json = candidate
                    .symbol
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()
                    .map_err(|error| rusqlite::Error::ToSqlConversionFailure(error.into()))?;
                let anchors_json = serde_json::to_string(&candidate.anchors)
                    .map_err(|error| rusqlite::Error::ToSqlConversionFailure(error.into()))?;
                stmt.execute(params![
                    draft.id,
                    candidate.chunk_index,
                    candidate.line,
                    candidate.suggested_anchor,
                    candidate.enclosing_symbol,
                    candidate.enclosing_kind,
                    candidate.symbol_start,
                    candidate.symbol_end,
                    candidate.candidate_kind,
                    symbol_json,
                    anchors_json,
                    candidate.confidence,
                    candidate.reason,
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

    pub fn patch_draft_candidates(&self, id: &str) -> Result<Vec<PatchCandidate>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT chunk_index, line, suggested_anchor, enclosing_symbol, enclosing_kind, symbol_start, symbol_end,
                    candidate_kind, symbol_json, anchors_json, confidence, reason
             FROM patch_draft_candidates
             WHERE patch_id = ?1
             ORDER BY chunk_index ASC, line ASC",
        )?;
        stmt.query_map(params![id], |row| {
            let symbol_json: Option<String> = row.get(8)?;
            let anchors_json: Option<String> = row.get(9)?;
            Ok(PatchCandidate {
                chunk_index: row.get(0)?,
                line: row.get(1)?,
                suggested_anchor: row.get(2)?,
                enclosing_symbol: row.get(3)?,
                enclosing_kind: row.get(4)?,
                symbol_start: row.get(5)?,
                symbol_end: row.get(6)?,
                candidate_kind: row
                    .get::<_, Option<String>>(7)?
                    .unwrap_or_else(|| "line_anchor".to_string()),
                symbol: symbol_json.and_then(|value| serde_json::from_str(&value).ok()),
                anchors: anchors_json
                    .and_then(|value| serde_json::from_str(&value).ok())
                    .unwrap_or_default(),
                confidence: row
                    .get::<_, Option<String>>(10)?
                    .unwrap_or_else(|| "low".to_string()),
                reason: row.get::<_, Option<String>>(11)?.unwrap_or_default(),
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

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
