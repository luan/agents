use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use rusqlite::{Connection, params};
use sha1::{Digest, Sha1};

use super::paths;
use super::types::{
    GuardAction, GuardDecision, GuardReason, PatchCandidate, PatchDraftChunk, PatchDraftSummary,
    ReadCoverageRange,
};

const SCHEMA_VERSION: i32 = 3;

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

CREATE TABLE IF NOT EXISTS guard_overrides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    session_id TEXT,
    rel_path TEXT NOT NULL,
    consumed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    consumed_at INTEGER
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
CREATE INDEX IF NOT EXISTS idx_guard_overrides_project_session_path ON guard_overrides(project_id, session_id, rel_path, consumed);
CREATE INDEX IF NOT EXISTS idx_patch_drafts_project_status ON patch_drafts(project_id, status);
CREATE INDEX IF NOT EXISTS idx_patch_draft_chunks_patch ON patch_draft_chunks(patch_id);
"#;

pub struct LensStore {
    conn: Connection,
    project_id: i64,
    root: PathBuf,
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
        let root = root.canonicalize()?;
        let root_text = root.to_string_lossy().to_string();
        conn.execute(
            "INSERT INTO projects (root, vcs_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?3)
             ON CONFLICT(root) DO UPDATE SET updated_at = excluded.updated_at",
            params![root_text, Option::<String>::None, now],
        )?;
        let project_id = conn.query_row(
            "SELECT id FROM projects WHERE root = ?1",
            params![root_text],
            |row| row.get(0),
        )?;
        Ok(Self {
            conn,
            project_id,
            root,
        })
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

    pub fn record_read(
        &mut self,
        session_id: Option<&str>,
        path: &Path,
        start_line: i64,
        end_line: i64,
    ) -> Result<ReadCoverageRange, Box<dyn std::error::Error>> {
        let range = normalize_range(start_line, end_line)?;
        let snapshot = self.file_snapshot(path)?;
        let session_id = session_id.unwrap_or("default");
        let now = now_ms();
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO sessions(id, project_id, agent, started_at, last_seen_at, status)
             VALUES(?1, ?2, NULL, ?3, ?3, 'active')
             ON CONFLICT(id) DO UPDATE SET last_seen_at=excluded.last_seen_at, status='active'",
            params![session_id, self.project_id, now],
        )?;
        tx.execute(
            "INSERT INTO files(project_id, rel_path, language, ignored, hash, mtime_ns, size_bytes, line_count)
             VALUES(?1, ?2, ?3, 0, ?4, ?5, ?6, ?7)
             ON CONFLICT(project_id, rel_path) DO UPDATE SET
                language=excluded.language,
                hash=excluded.hash,
                mtime_ns=excluded.mtime_ns,
                size_bytes=excluded.size_bytes,
                line_count=excluded.line_count",
            params![
                self.project_id,
                snapshot.rel_path,
                snapshot.language,
                snapshot.hash,
                snapshot.mtime_ns,
                snapshot.size_bytes,
                snapshot.line_count
            ],
        )?;
        let file_id: i64 = tx.query_row(
            "SELECT id FROM files WHERE project_id=?1 AND rel_path=?2",
            params![self.project_id, snapshot.rel_path],
            |row| row.get(0),
        )?;
        tx.execute(
            "INSERT INTO read_events(session_id, file_id, file_hash, source, created_at)
             VALUES(?1, ?2, ?3, 'ct_lens_read', ?4)",
            params![session_id, file_id, snapshot.hash.unwrap_or_default(), now],
        )?;
        let read_event_id = tx.last_insert_rowid();
        tx.execute(
            "INSERT INTO read_ranges(read_event_id, start_line, end_line) VALUES(?1, ?2, ?3)",
            params![read_event_id, range.start_line, range.end_line],
        )?;
        tx.commit()?;
        Ok(range)
    }

    pub fn check_guard(
        &mut self,
        session_id: Option<&str>,
        path: &Path,
        start_line: i64,
        end_line: i64,
        requested_action: GuardAction,
    ) -> Result<GuardDecision, Box<dyn std::error::Error>> {
        let required = normalize_range(start_line, end_line)?;
        let rel_path = self.rel_path(path);
        if matches!(requested_action, GuardAction::Allow) {
            return Ok(decision(
                GuardAction::Allow,
                GuardReason::ExplicitOverride,
                rel_path,
                required,
                Vec::new(),
            ));
        }
        if !self.root.join(&rel_path).exists() {
            return Ok(decision(
                GuardAction::Allow,
                GuardReason::NewFile,
                rel_path,
                required,
                Vec::new(),
            ));
        }
        if self.consume_guard_override(session_id, &rel_path)? {
            return Ok(decision(
                GuardAction::Allow,
                GuardReason::ExplicitOverride,
                rel_path,
                required,
                Vec::new(),
            ));
        }
        let snapshot = self.file_snapshot(path)?;
        let current_hash = snapshot.hash.unwrap_or_default();
        let covered = self.covered_ranges(session_id, &rel_path, &current_hash)?;
        if range_covered(required, &covered) {
            return Ok(decision(
                GuardAction::Allow,
                GuardReason::Covered,
                rel_path,
                required,
                covered,
            ));
        }
        let reason = if self.has_any_read(session_id, &rel_path)? {
            GuardReason::StaleRead
        } else {
            GuardReason::ZeroRead
        };
        Ok(decision(
            requested_action,
            reason,
            rel_path,
            required,
            covered,
        ))
    }

    pub fn allow_once(
        &self,
        session_id: Option<&str>,
        path: &Path,
    ) -> Result<(), Box<dyn std::error::Error>> {
        self.conn.execute(
            "INSERT INTO guard_overrides(project_id, session_id, rel_path, consumed, created_at)
             VALUES(?1, ?2, ?3, 0, ?4)",
            params![self.project_id, session_id, self.rel_path(path), now_ms()],
        )?;
        Ok(())
    }

    fn covered_ranges(
        &self,
        session_id: Option<&str>,
        rel_path: &str,
        current_hash: &str,
    ) -> Result<Vec<ReadCoverageRange>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT rr.start_line, rr.end_line
             FROM read_ranges rr
             JOIN read_events re ON re.id = rr.read_event_id
             JOIN files f ON f.id = re.file_id
             WHERE f.project_id=?1
               AND f.rel_path=?2
               AND re.file_hash=?3
               AND (?4 IS NULL OR re.session_id=?4)
             ORDER BY rr.start_line, rr.end_line",
        )?;
        let rows = stmt.query_map(
            params![self.project_id, rel_path, current_hash, session_id],
            |row| {
                Ok(ReadCoverageRange {
                    start_line: row.get(0)?,
                    end_line: row.get(1)?,
                })
            },
        )?;
        rows.collect()
    }

    fn has_any_read(
        &self,
        session_id: Option<&str>,
        rel_path: &str,
    ) -> Result<bool, rusqlite::Error> {
        self.conn.query_row(
            "SELECT EXISTS(
                SELECT 1
                FROM read_events re
                JOIN files f ON f.id = re.file_id
                WHERE f.project_id=?1
                  AND f.rel_path=?2
                  AND (?3 IS NULL OR re.session_id=?3)
             )",
            params![self.project_id, rel_path, session_id],
            |row| row.get(0),
        )
    }

    fn consume_guard_override(
        &self,
        session_id: Option<&str>,
        rel_path: &str,
    ) -> Result<bool, rusqlite::Error> {
        let id = self.conn.query_row(
            "SELECT id FROM guard_overrides
             WHERE project_id=?1
               AND rel_path=?2
               AND consumed=0
               AND (session_id IS NULL OR session_id=?3)
             ORDER BY created_at ASC
             LIMIT 1",
            params![self.project_id, rel_path, session_id],
            |row| row.get::<_, i64>(0),
        );
        let Ok(id) = id else {
            return Ok(false);
        };
        self.conn.execute(
            "UPDATE guard_overrides SET consumed=1, consumed_at=?1 WHERE id=?2",
            params![now_ms(), id],
        )?;
        Ok(true)
    }

    fn file_snapshot(
        &self,
        path: &Path,
    ) -> Result<super::types::FileSnapshot, Box<dyn std::error::Error>> {
        let full_path = if path.is_absolute() {
            path.to_path_buf()
        } else {
            self.root.join(path)
        };
        let content = std::fs::read(&full_path)?;
        let metadata = std::fs::metadata(&full_path)?;
        let text = String::from_utf8_lossy(&content);
        Ok(super::types::FileSnapshot {
            rel_path: self.rel_path(path),
            language: full_path
                .extension()
                .and_then(|ext| ext.to_str())
                .map(str::to_string),
            hash: Some(sha1_hex(&content)),
            mtime_ns: metadata
                .modified()
                .ok()
                .and_then(|mtime| mtime.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_nanos() as i64),
            size_bytes: Some(metadata.len() as i64),
            line_count: Some(text.lines().count() as i64),
        })
    }

    fn rel_path(&self, path: &Path) -> String {
        let absolute = if path.is_absolute() {
            path.to_path_buf()
        } else {
            self.root.join(path)
        };
        absolute
            .strip_prefix(&self.root)
            .unwrap_or(&absolute)
            .to_string_lossy()
            .to_string()
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
                 (patch_id, chunk_index, line, suggested_anchor, enclosing_symbol, enclosing_kind, symbol_start, symbol_end)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            )?;
            for candidate in draft.candidates {
                stmt.execute(params![
                    draft.id,
                    candidate.chunk_index,
                    candidate.line,
                    candidate.suggested_anchor,
                    candidate.enclosing_symbol,
                    candidate.enclosing_kind,
                    candidate.symbol_start,
                    candidate.symbol_end,
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
            "SELECT chunk_index, line, suggested_anchor, enclosing_symbol, enclosing_kind, symbol_start, symbol_end
             FROM patch_draft_candidates
             WHERE patch_id = ?1
             ORDER BY chunk_index ASC, line ASC",
        )?;
        stmt.query_map(params![id], |row| {
            Ok(PatchCandidate {
                chunk_index: row.get(0)?,
                line: row.get(1)?,
                suggested_anchor: row.get(2)?,
                enclosing_symbol: row.get(3)?,
                enclosing_kind: row.get(4)?,
                symbol_start: row.get(5)?,
                symbol_end: row.get(6)?,
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

fn normalize_range(
    start_line: i64,
    end_line: i64,
) -> Result<ReadCoverageRange, Box<dyn std::error::Error>> {
    if start_line < 1 || end_line < 1 || end_line < start_line {
        return Err(format!("invalid line range {start_line}-{end_line}").into());
    }
    Ok(ReadCoverageRange {
        start_line,
        end_line,
    })
}

fn decision(
    decision: GuardAction,
    reason: GuardReason,
    file: String,
    required: ReadCoverageRange,
    covered_ranges: Vec<ReadCoverageRange>,
) -> GuardDecision {
    GuardDecision {
        decision,
        reason,
        file,
        required_ranges: vec![required],
        covered_ranges,
    }
}

fn range_covered(required: ReadCoverageRange, covered: &[ReadCoverageRange]) -> bool {
    let mut cursor = required.start_line;
    for range in covered {
        if range.end_line < cursor {
            continue;
        }
        if range.start_line > cursor {
            return false;
        }
        cursor = cursor.max(range.end_line + 1);
        if cursor > required.end_line {
            return true;
        }
    }
    false
}

fn sha1_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha1::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write;
        write!(&mut out, "{byte:02x}").expect("writing to String never fails");
    }
    out
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
