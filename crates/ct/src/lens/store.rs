use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::UNIX_EPOCH;

use rusqlite::{Connection, OptionalExtension, params};
use sha1::{Digest, Sha1};

use super::paths;
use super::raw_output;
use super::types::{
    Diagnostic, DiagnosticDeltaSet, DiagnosticDeltaStatus, DiagnosticListData, DiagnosticRelevance,
    DiagnosticScope, DiagnosticSeverity, DiagnosticSnapshotInput, DiagnosticSnapshotResult,
    DiagnosticSource, LensToolEventPhase, LensTouchedFile, LensTouchedFileSource, LensTurnEvent,
    PatchCandidate, PatchDraftChunk, PatchDraftSummary, RawOutputRef,
};

const SCHEMA_VERSION: i32 = 9;

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
    symbol_end INTEGER,
    candidate_kind TEXT,
    symbol_json TEXT,
    anchors_json TEXT,
    confidence TEXT,
    reason TEXT
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

CREATE TABLE IF NOT EXISTS raw_outputs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    scope_kind TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    body TEXT NOT NULL,
    original_bytes INTEGER NOT NULL,
    retained_bytes INTEGER NOT NULL,
    truncated INTEGER NOT NULL,
    redacted INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS diagnostic_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    scope_kind TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    raw_output_id INTEGER REFERENCES raw_outputs(id) ON DELETE SET NULL,
    metadata_json TEXT NOT NULL,
    diagnostic_count INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS diagnostics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    file_id INTEGER REFERENCES files(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    scope_kind TEXT NOT NULL DEFAULT 'workspace',
    scope_key TEXT NOT NULL DEFAULT '',
    severity TEXT NOT NULL,
    code TEXT,
    message TEXT NOT NULL,
    start_line INTEGER,
    end_line INTEGER,
    fingerprint TEXT NOT NULL,
    content_hash TEXT,
    raw_output_id INTEGER REFERENCES raw_outputs(id) ON DELETE SET NULL,
    snapshot_id INTEGER REFERENCES diagnostic_snapshots(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    resolved_at INTEGER,
    resolved_snapshot_id INTEGER REFERENCES diagnostic_snapshots(id) ON DELETE SET NULL,
    UNIQUE(project_id, source, scope_kind, scope_key, fingerprint)
);

CREATE TABLE IF NOT EXISTS diagnostic_snapshot_deltas (
    snapshot_id INTEGER NOT NULL REFERENCES diagnostic_snapshots(id) ON DELETE CASCADE,
    diagnostic_id INTEGER NOT NULL REFERENCES diagnostics(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    PRIMARY KEY(snapshot_id, diagnostic_id, status)
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



CREATE TABLE IF NOT EXISTS turns (
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    host TEXT NOT NULL,
    cwd TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    PRIMARY KEY(project_id, session_id, turn_id)
);

CREATE TABLE IF NOT EXISTS turn_tool_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    host TEXT NOT NULL,
    cwd TEXT NOT NULL,
    tool TEXT NOT NULL,
    phase TEXT NOT NULL,
    status TEXT,
    policy_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS turn_touched_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    rel_path TEXT NOT NULL,
    tool TEXT NOT NULL,
    operation TEXT NOT NULL,
    source TEXT NOT NULL,
    explicit INTEGER NOT NULL,
    ignored INTEGER NOT NULL,
    generated INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(project_id, session_id, turn_id, rel_path, source, tool, operation)
);

CREATE TABLE IF NOT EXISTS retention_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_files_project_rel ON files(project_id, rel_path);
CREATE INDEX IF NOT EXISTS idx_diagnostics_project_file ON diagnostics(project_id, file_id);
CREATE INDEX IF NOT EXISTS idx_diagnostics_project_scope ON diagnostics(project_id, source, scope_kind, scope_key, resolved_at);
CREATE INDEX IF NOT EXISTS idx_diagnostic_snapshots_project_scope ON diagnostic_snapshots(project_id, source, scope_kind, scope_key, created_at);
CREATE INDEX IF NOT EXISTS idx_raw_outputs_project_expires ON raw_outputs(project_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_patch_drafts_project_status ON patch_drafts(project_id, status);
CREATE INDEX IF NOT EXISTS idx_patch_draft_chunks_patch ON patch_draft_chunks(patch_id);
CREATE INDEX IF NOT EXISTS idx_turns_project_session_turn ON turns(project_id, session_id, turn_id);
CREATE INDEX IF NOT EXISTS idx_turn_touched_project_session_turn ON turn_touched_files(project_id, session_id, turn_id);
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
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let current: i32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if current > SCHEMA_VERSION {
            return Err(format!(
                "lens store schema version {current} is newer than supported {SCHEMA_VERSION}"
            )
            .into());
        }
        if current < SCHEMA_VERSION {
            if current > 0 && current < 9 {
                reset_schema_for_v9(&conn)?;
            }
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
            raw_outputs: self.count("raw_outputs")?,
            diagnostic_snapshots: self.count("diagnostic_snapshots")?,
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

    pub fn record_applied_changes(
        &mut self,
        session_id: Option<&str>,
        tool: &str,
        changes: &[crate::apply_patch::FileChange],
    ) -> Result<(), Box<dyn std::error::Error>> {
        for change in changes {
            if matches!(change.kind, crate::apply_patch::ChangeType::Delete) {
                continue;
            }
            let new_path = change.move_path.as_deref().unwrap_or(&change.path);
            self.record_patch_event(session_id, Path::new(new_path), tool, change)?;
        }
        Ok(())
    }

    pub fn record_turn_event(
        &mut self,
        event: &LensTurnEvent,
        files: &[LensTouchedFile],
    ) -> Result<(), Box<dyn std::error::Error>> {
        let now = now_ms();
        let policy_json = serde_json::to_string(&event.policy)?;
        let tx = self.conn.transaction()?;
        upsert_session_tx(&tx, self.project_id, &event.session, now)?;
        let turn_status = if matches!(event.event, super::types::LensTurnEventKind::TurnEnd) {
            "completed"
        } else {
            "active"
        };
        tx.execute(
            "INSERT INTO turns(project_id, session_id, turn_id, host, cwd, started_at, last_seen_at, status)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7)
             ON CONFLICT(project_id, session_id, turn_id) DO UPDATE SET
                host=excluded.host,
                cwd=excluded.cwd,
                last_seen_at=excluded.last_seen_at,
                status=excluded.status",
            params![
                self.project_id,
                event.session,
                event.turn,
                event.host,
                event.cwd,
                now,
                turn_status
            ],
        )?;
        tx.execute(
            "INSERT INTO turn_tool_events(project_id, session_id, turn_id, host, cwd, tool, phase, status, policy_json, created_at)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                self.project_id,
                event.session,
                event.turn,
                event.host,
                event.cwd,
                event.tool,
                tool_phase(&event.phase),
                event.status,
                policy_json,
                now
            ],
        )?;
        for file in files {
            tx.execute(
                "INSERT INTO turn_touched_files(project_id, session_id, turn_id, rel_path, tool, operation, source, explicit, ignored, generated, created_at)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                 ON CONFLICT(project_id, session_id, turn_id, rel_path, source, tool, operation) DO UPDATE SET
                    explicit=MAX(turn_touched_files.explicit, excluded.explicit),
                    ignored=excluded.ignored,
                    generated=MAX(turn_touched_files.generated, excluded.generated),
                    created_at=excluded.created_at",
                params![
                    self.project_id,
                    event.session,
                    event.turn,
                    file.path,
                    file.tool,
                    file.operation,
                    touched_source(&file.source),
                    file.explicit,
                    file.ignored,
                    file.generated,
                    now
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn turn_status(
        &self,
        session: &str,
        turn: &str,
    ) -> Result<Option<String>, Box<dyn std::error::Error>> {
        self.conn
            .query_row(
                "SELECT status FROM turns WHERE project_id=?1 AND session_id=?2 AND turn_id=?3",
                params![self.project_id, session, turn],
                |row| row.get(0),
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn list_touched_files(
        &self,
        session: &str,
        turn: &str,
    ) -> Result<Vec<LensTouchedFile>, Box<dyn std::error::Error>> {
        let mut stmt = self.conn.prepare(
            "SELECT rel_path, operation, tool, source, explicit, ignored, generated
             FROM turn_touched_files
             WHERE project_id=?1 AND session_id=?2 AND turn_id=?3
             ORDER BY rel_path, source, tool, operation",
        )?;
        let rows = stmt.query_map(params![self.project_id, session, turn], |row| {
            Ok(LensTouchedFile {
                path: row.get(0)?,
                operation: row.get(1)?,
                start_line: None,
                end_line: None,
                tool: row.get(2)?,
                source: parse_touched_source(row.get::<_, String>(3)?.as_str()),
                explicit: row.get(4)?,
                ignored: row.get(5)?,
                generated: row.get(6)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn list_session_touched_files(
        &self,
        session: &str,
    ) -> Result<Vec<LensTouchedFile>, Box<dyn std::error::Error>> {
        let mut stmt = self.conn.prepare(
            "SELECT rel_path, operation, tool, source, explicit, ignored, generated
             FROM turn_touched_files
             WHERE project_id=?1 AND session_id=?2
             ORDER BY rel_path, source, tool, operation",
        )?;
        let rows = stmt.query_map(params![self.project_id, session], |row| {
            Ok(LensTouchedFile {
                path: row.get(0)?,
                operation: row.get(1)?,
                start_line: None,
                end_line: None,
                tool: row.get(2)?,
                source: parse_touched_source(row.get::<_, String>(3)?.as_str()),
                explicit: row.get(4)?,
                ignored: row.get(5)?,
                generated: row.get(6)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn record_diagnostics(
        &mut self,
        diagnostics: &[Diagnostic],
    ) -> Result<(), Box<dyn std::error::Error>> {
        for diagnostic in diagnostics {
            let now = now_ms();
            let file_id = match diagnostic.rel_path.as_deref() {
                Some(path) => Some(self.ensure_file_row(Path::new(path))?),
                None => None,
            };
            let fingerprint = normalized_fingerprint(diagnostic);
            self.conn.execute(
                "INSERT INTO diagnostics(project_id, file_id, source, scope_kind, scope_key, severity, code, message, start_line, end_line, fingerprint, content_hash, raw_output_id, snapshot_id, created_at, first_seen_at, last_seen_at, resolved_at)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15, ?15, NULL)
                 ON CONFLICT(project_id, source, scope_kind, scope_key, fingerprint) DO UPDATE SET
                    file_id=excluded.file_id,
                    severity=excluded.severity,
                    code=excluded.code,
                    message=excluded.message,
                    start_line=excluded.start_line,
                    end_line=excluded.end_line,
                    content_hash=excluded.content_hash,
                    raw_output_id=COALESCE(excluded.raw_output_id, diagnostics.raw_output_id),
                    snapshot_id=COALESCE(excluded.snapshot_id, diagnostics.snapshot_id),
                    created_at=excluded.created_at,
                    last_seen_at=excluded.last_seen_at,
                    resolved_at=NULL",
                params![
                    self.project_id,
                    file_id,
                    diagnostic_source(&diagnostic.source),
                    diagnostic.scope.kind,
                    diagnostic.scope.key,
                    diagnostic_severity(&diagnostic.severity),
                    diagnostic.code,
                    diagnostic.message,
                    diagnostic.start_line,
                    diagnostic.end_line,
                    fingerprint,
                    diagnostic.content_hash,
                    diagnostic.raw_output_id,
                    diagnostic.snapshot_id,
                    now
                ],
            )?;
        }
        Ok(())
    }

    pub fn record_diagnostic_snapshot(
        &mut self,
        snapshot: DiagnosticSnapshotInput,
    ) -> Result<DiagnosticSnapshotResult, Box<dyn std::error::Error>> {
        let now = now_ms();
        let source_text = diagnostic_source(&snapshot.source);
        let metadata_json = serde_json::to_string(&snapshot.metadata)?;
        let raw_output = match snapshot.raw_output.as_deref() {
            Some(raw) => Some(
                self.insert_raw_output(
                    &snapshot.source,
                    &snapshot.scope,
                    raw,
                    now,
                    snapshot
                        .raw_output_max_bytes
                        .unwrap_or(raw_output::DEFAULT_RAW_OUTPUT_MAX_BYTES),
                )?,
            ),
            None => None,
        };
        let raw_output_id = raw_output.as_ref().map(|raw| raw.id);
        self.conn.execute(
            "INSERT INTO diagnostic_snapshots(project_id, source, scope_kind, scope_key, raw_output_id, metadata_json, diagnostic_count, created_at)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                self.project_id,
                source_text,
                snapshot.scope.kind,
                snapshot.scope.key,
                raw_output_id,
                metadata_json,
                snapshot.diagnostics.len() as i64,
                now
            ],
        )?;
        let snapshot_id = self.conn.last_insert_rowid();
        let previous = self.active_diagnostic_ids(&snapshot.source, &snapshot.scope)?;
        let mut seen = BTreeSet::new();
        let mut deltas = DiagnosticDeltaSet::empty();

        for input in &snapshot.diagnostics {
            let mut diagnostic = input.clone();
            diagnostic.source = snapshot.source.clone();
            diagnostic.scope = snapshot.scope.clone();
            diagnostic.raw_output_id = raw_output_id;
            diagnostic.snapshot_id = Some(snapshot_id);
            let fingerprint = normalized_fingerprint(&diagnostic);
            seen.insert(fingerprint.clone());
            let status = if previous.contains_key(&fingerprint) {
                DiagnosticDeltaStatus::Unchanged
            } else {
                DiagnosticDeltaStatus::New
            };
            let id = self.upsert_snapshot_diagnostic(
                &diagnostic,
                &fingerprint,
                snapshot_id,
                raw_output_id,
                now,
            )?;
            self.record_snapshot_delta(snapshot_id, id, &status)?;
            let stored = self.diagnostic_by_id(id)?;
            match status {
                DiagnosticDeltaStatus::New => deltas.new.push(stored),
                DiagnosticDeltaStatus::Unchanged => deltas.unchanged.push(stored),
                DiagnosticDeltaStatus::Resolved => unreachable!(),
            }
        }

        for (fingerprint, id) in previous {
            if seen.contains(&fingerprint) {
                continue;
            }
            self.conn.execute(
                "UPDATE diagnostics SET resolved_at=?1, resolved_snapshot_id=?2, last_seen_at=?1 WHERE id=?3",
                params![now, snapshot_id, id],
            )?;
            self.record_snapshot_delta(snapshot_id, id, &DiagnosticDeltaStatus::Resolved)?;
            deltas.resolved.push(self.diagnostic_by_id(id)?);
        }

        Ok(DiagnosticSnapshotResult {
            project_id: self.project_id,
            snapshot_id,
            source: snapshot.source,
            scope: snapshot.scope,
            raw_output,
            diagnostic_count: snapshot.diagnostics.len(),
            deltas,
        })
    }

    pub fn list_diagnostics(
        &self,
        rel_path: Option<&str>,
    ) -> Result<Vec<Diagnostic>, Box<dyn std::error::Error>> {
        let mut stmt = self.conn.prepare(
            "SELECT d.id, d.source, d.scope_kind, d.scope_key, d.severity, d.code, d.message, f.rel_path, d.start_line, d.end_line, d.fingerprint, d.content_hash, d.raw_output_id, d.snapshot_id, d.first_seen_at, d.last_seen_at, d.resolved_at
             FROM diagnostics d
             LEFT JOIN files f ON f.id = d.file_id
             WHERE d.project_id=?1 AND d.resolved_at IS NULL AND (?2 IS NULL OR f.rel_path=?2)
             ORDER BY f.rel_path, d.start_line, d.severity, d.message",
        )?;
        let rows = stmt.query_map(params![self.project_id, rel_path], diagnostic_from_row)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn list_diagnostics_data(
        &self,
        rel_path: Option<&str>,
        all: bool,
    ) -> Result<DiagnosticListData, Box<dyn std::error::Error>> {
        let changed_files = self.relevant_file_set()?;
        let active = self.query_diagnostics(rel_path, false)?;
        let latest_snapshot_id = self.latest_snapshot_id()?;
        let mut deltas = match latest_snapshot_id {
            Some(snapshot_id) => self.snapshot_deltas(snapshot_id, rel_path)?,
            None => DiagnosticDeltaSet::empty(),
        };
        let diagnostics = if all || rel_path.is_some() {
            active
        } else {
            active
                .into_iter()
                .filter(|diagnostic| {
                    if self.diagnostic_path_ignored(diagnostic) {
                        return false;
                    }
                    deltas.new.iter().any(|new| {
                        new.fingerprint == diagnostic.fingerprint
                            && new.scope == diagnostic.scope
                            && new.source == diagnostic.source
                    }) || diagnostic
                        .rel_path
                        .as_ref()
                        .is_some_and(|path| changed_files.contains(path))
                })
                .collect()
        };
        if !all && rel_path.is_none() {
            filter_delta_set(&mut deltas, &changed_files);
            deltas
                .new
                .retain(|diagnostic| !self.diagnostic_path_ignored(diagnostic));
            deltas
                .resolved
                .retain(|diagnostic| !self.diagnostic_path_ignored(diagnostic));
            deltas
                .unchanged
                .retain(|diagnostic| !self.diagnostic_path_ignored(diagnostic));
        }
        Ok(DiagnosticListData {
            project_id: self.project_id,
            path: rel_path.map(str::to_string),
            diagnostic_count: diagnostics.len(),
            diagnostics,
            delta_count: deltas.count(),
            deltas,
            relevance: DiagnosticRelevance {
                changed_files: changed_files.into_iter().collect(),
                all,
            },
        })
    }

    fn insert_raw_output(
        &self,
        source: &DiagnosticSource,
        scope: &DiagnosticScope,
        raw: &str,
        now: i64,
        max_bytes: usize,
    ) -> Result<RawOutputRef, Box<dyn std::error::Error>> {
        let sanitized = raw_output::sanitize(raw, max_bytes);
        let expires_at = raw_output::expires_at(now, raw_output::DEFAULT_RAW_OUTPUT_TTL_DAYS);
        self.conn.execute(
            "INSERT INTO raw_outputs(project_id, source, scope_kind, scope_key, body, original_bytes, retained_bytes, truncated, redacted, created_at, expires_at)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                self.project_id,
                diagnostic_source(source),
                scope.kind,
                scope.key,
                sanitized.body,
                sanitized.original_bytes,
                sanitized.retained_bytes,
                sanitized.truncated,
                sanitized.redacted,
                now,
                expires_at
            ],
        )?;
        Ok(raw_output::ref_from_row(
            self.conn.last_insert_rowid(),
            sanitized.original_bytes,
            sanitized.retained_bytes,
            sanitized.truncated,
            sanitized.redacted,
            expires_at,
        ))
    }

    fn active_diagnostic_ids(
        &self,
        source: &DiagnosticSource,
        scope: &DiagnosticScope,
    ) -> Result<BTreeMap<String, i64>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT fingerprint, id FROM diagnostics
             WHERE project_id=?1 AND source=?2 AND scope_kind=?3 AND scope_key=?4 AND resolved_at IS NULL",
        )?;
        let rows = stmt.query_map(
            params![
                self.project_id,
                diagnostic_source(source),
                scope.kind,
                scope.key
            ],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )?;
        rows.collect()
    }

    fn upsert_snapshot_diagnostic(
        &mut self,
        diagnostic: &Diagnostic,
        fingerprint: &str,
        snapshot_id: i64,
        raw_output_id: Option<i64>,
        now: i64,
    ) -> Result<i64, Box<dyn std::error::Error>> {
        let file_id = match diagnostic.rel_path.as_deref() {
            Some(path) => Some(self.ensure_file_row(Path::new(path))?),
            None => None,
        };
        self.conn.execute(
            "INSERT INTO diagnostics(project_id, file_id, source, scope_kind, scope_key, severity, code, message, start_line, end_line, fingerprint, content_hash, raw_output_id, snapshot_id, created_at, first_seen_at, last_seen_at, resolved_at, resolved_snapshot_id)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15, ?15, NULL, NULL)
             ON CONFLICT(project_id, source, scope_kind, scope_key, fingerprint) DO UPDATE SET
                file_id=excluded.file_id,
                severity=excluded.severity,
                code=excluded.code,
                message=excluded.message,
                start_line=excluded.start_line,
                end_line=excluded.end_line,
                content_hash=excluded.content_hash,
                raw_output_id=excluded.raw_output_id,
                snapshot_id=excluded.snapshot_id,
                created_at=excluded.created_at,
                last_seen_at=excluded.last_seen_at,
                resolved_at=NULL,
                resolved_snapshot_id=NULL",
            params![
                self.project_id,
                file_id,
                diagnostic_source(&diagnostic.source),
                diagnostic.scope.kind,
                diagnostic.scope.key,
                diagnostic_severity(&diagnostic.severity),
                diagnostic.code,
                diagnostic.message,
                diagnostic.start_line,
                diagnostic.end_line,
                fingerprint,
                diagnostic.content_hash,
                raw_output_id,
                snapshot_id,
                now
            ],
        )?;
        Ok(self.conn.query_row(
            "SELECT id FROM diagnostics WHERE project_id=?1 AND source=?2 AND scope_kind=?3 AND scope_key=?4 AND fingerprint=?5",
            params![
                self.project_id,
                diagnostic_source(&diagnostic.source),
                diagnostic.scope.kind,
                diagnostic.scope.key,
                fingerprint
            ],
            |row| row.get(0),
        )?)
    }

    fn record_snapshot_delta(
        &self,
        snapshot_id: i64,
        diagnostic_id: i64,
        status: &DiagnosticDeltaStatus,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT OR IGNORE INTO diagnostic_snapshot_deltas(snapshot_id, diagnostic_id, status) VALUES(?1, ?2, ?3)",
            params![snapshot_id, diagnostic_id, delta_status(status)],
        )?;
        Ok(())
    }

    fn diagnostic_by_id(&self, id: i64) -> Result<Diagnostic, rusqlite::Error> {
        self.conn.query_row(
            "SELECT d.id, d.source, d.scope_kind, d.scope_key, d.severity, d.code, d.message, f.rel_path, d.start_line, d.end_line, d.fingerprint, d.content_hash, d.raw_output_id, d.snapshot_id, d.first_seen_at, d.last_seen_at, d.resolved_at
             FROM diagnostics d
             LEFT JOIN files f ON f.id = d.file_id
             WHERE d.id=?1",
            params![id],
            diagnostic_from_row,
        )
    }

    fn latest_snapshot_id(&self) -> Result<Option<i64>, rusqlite::Error> {
        self.conn
            .query_row(
                "SELECT id FROM diagnostic_snapshots WHERE project_id=?1 ORDER BY created_at DESC, id DESC LIMIT 1",
                params![self.project_id],
                |row| row.get(0),
            )
            .optional()
    }

    fn query_diagnostics(
        &self,
        rel_path: Option<&str>,
        include_resolved: bool,
    ) -> Result<Vec<Diagnostic>, Box<dyn std::error::Error>> {
        let resolved_filter = if include_resolved {
            ""
        } else {
            "AND d.resolved_at IS NULL"
        };
        let sql = format!(
            "SELECT d.id, d.source, d.scope_kind, d.scope_key, d.severity, d.code, d.message, f.rel_path, d.start_line, d.end_line, d.fingerprint, d.content_hash, d.raw_output_id, d.snapshot_id, d.first_seen_at, d.last_seen_at, d.resolved_at
             FROM diagnostics d
             LEFT JOIN files f ON f.id = d.file_id
             WHERE d.project_id=?1 {resolved_filter} AND (?2 IS NULL OR f.rel_path=?2)
             ORDER BY f.rel_path, d.start_line, d.severity, d.message"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params![self.project_id, rel_path], diagnostic_from_row)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    fn snapshot_deltas(
        &self,
        snapshot_id: i64,
        rel_path: Option<&str>,
    ) -> Result<DiagnosticDeltaSet, Box<dyn std::error::Error>> {
        let mut stmt = self.conn.prepare(
            "SELECT sd.status, d.id, d.source, d.scope_kind, d.scope_key, d.severity, d.code, d.message, f.rel_path, d.start_line, d.end_line, d.fingerprint, d.content_hash, d.raw_output_id, d.snapshot_id, d.first_seen_at, d.last_seen_at, d.resolved_at
             FROM diagnostic_snapshot_deltas sd
             JOIN diagnostics d ON d.id = sd.diagnostic_id
             LEFT JOIN files f ON f.id = d.file_id
             WHERE sd.snapshot_id=?1 AND (?2 IS NULL OR f.rel_path=?2)
             ORDER BY sd.status, f.rel_path, d.start_line, d.message",
        )?;
        let rows = stmt.query_map(params![snapshot_id, rel_path], |row| {
            Ok((
                row.get::<_, String>(0)?,
                diagnostic_from_row_offset(row, 1)?,
            ))
        })?;
        let mut out = DiagnosticDeltaSet::empty();
        for row in rows {
            let (status, diagnostic) = row?;
            match status.as_str() {
                "new" => out.new.push(diagnostic),
                "resolved" => out.resolved.push(diagnostic),
                _ => out.unchanged.push(diagnostic),
            }
        }
        Ok(out)
    }

    fn relevant_file_set(&self) -> Result<BTreeSet<String>, rusqlite::Error> {
        let mut changed = BTreeSet::new();
        let mut touched = self.conn.prepare(
            "SELECT DISTINCT rel_path FROM turn_touched_files
             WHERE project_id=?1 AND ignored=0 AND generated=0
             ORDER BY rel_path",
        )?;
        for row in touched.query_map(params![self.project_id], |row| row.get::<_, String>(0))? {
            changed.insert(row?);
        }

        let mut patched = self.conn.prepare(
            "SELECT DISTINCT f.rel_path
             FROM patch_events pe
             JOIN files f ON f.id = pe.file_id
             WHERE f.project_id=?1 AND pe.accepted=1
             ORDER BY f.rel_path",
        )?;
        for row in patched.query_map(params![self.project_id], |row| row.get::<_, String>(0))? {
            changed.insert(row?);
        }
        Ok(changed)
    }

    fn diagnostic_path_ignored(&self, diagnostic: &Diagnostic) -> bool {
        let Some(path) = diagnostic.rel_path.as_deref() else {
            return false;
        };
        self.conn
            .query_row(
                "SELECT ignored FROM files WHERE project_id=?1 AND rel_path=?2",
                params![self.project_id, path],
                |row| row.get::<_, bool>(0),
            )
            .unwrap_or(false)
    }

    fn record_patch_event(
        &mut self,
        session_id: Option<&str>,
        path: &Path,
        tool: &str,
        change: &crate::apply_patch::FileChange,
    ) -> Result<(), Box<dyn std::error::Error>> {
        if matches!(change.kind, crate::apply_patch::ChangeType::Delete) {
            return Ok(());
        }
        let snapshot = self.file_snapshot(path)?;
        let Some(new_hash) = snapshot.hash else {
            return Ok(());
        };
        self.conn.execute(
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
                new_hash,
                snapshot.mtime_ns,
                snapshot.size_bytes,
                snapshot.line_count
            ],
        )?;
        let file_id: i64 = self.conn.query_row(
            "SELECT id FROM files WHERE project_id=?1 AND rel_path=?2",
            params![self.project_id, snapshot.rel_path],
            |row| row.get(0),
        )?;
        self.conn.execute(
            "INSERT INTO patch_events(session_id, file_id, old_hash, new_hash, tool, accepted, created_at)
             VALUES(?1, ?2, ?3, ?4, ?5, 1, ?6)",
            params![session_id, file_id, change.old_hash.as_deref(), new_hash, tool, now_ms()],
        )?;
        let patch_event_id = self.conn.last_insert_rowid();
        for line_change in &change.line_changes {
            self.conn.execute(
                "INSERT INTO patch_hunks(patch_event_id, old_start, old_end, new_start, new_end)
                 VALUES(?1, ?2, ?3, ?4, ?5)",
                params![
                    patch_event_id,
                    line_change.old_start.map(|value| value as i64),
                    line_change.old_end.map(|value| value as i64),
                    line_change.new_start.map(|value| value as i64),
                    line_change.new_end.map(|value| value as i64)
                ],
            )?;
        }
        Ok(())
    }

    fn ensure_file_row(&mut self, path: &Path) -> Result<i64, Box<dyn std::error::Error>> {
        let rel_path = self.rel_path(path);
        let ignored = self.is_ignored_path(&rel_path);
        let snapshot = self.file_snapshot(path).ok();
        let language = snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.language.clone())
            .or_else(|| {
                Path::new(&rel_path)
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .map(str::to_string)
            });
        let hash = snapshot.as_ref().and_then(|snapshot| snapshot.hash.clone());
        let mtime_ns = snapshot.as_ref().and_then(|snapshot| snapshot.mtime_ns);
        let size_bytes = snapshot.as_ref().and_then(|snapshot| snapshot.size_bytes);
        let line_count = snapshot.as_ref().and_then(|snapshot| snapshot.line_count);
        self.conn.execute(
            "INSERT INTO files(project_id, rel_path, language, ignored, hash, mtime_ns, size_bytes, line_count)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(project_id, rel_path) DO UPDATE SET
                language=COALESCE(excluded.language, files.language),
                ignored=excluded.ignored,
                hash=COALESCE(excluded.hash, files.hash),
                mtime_ns=COALESCE(excluded.mtime_ns, files.mtime_ns),
                size_bytes=COALESCE(excluded.size_bytes, files.size_bytes),
                line_count=COALESCE(excluded.line_count, files.line_count)",
            params![
                self.project_id,
                rel_path,
                language,
                ignored,
                hash,
                mtime_ns,
                size_bytes,
                line_count
            ],
        )?;
        Ok(self.conn.query_row(
            "SELECT id FROM files WHERE project_id=?1 AND rel_path=?2",
            params![self.project_id, rel_path],
            |row| row.get(0),
        )?)
    }

    fn is_ignored_path(&self, rel_path: &str) -> bool {
        let output = Command::new("git")
            .arg("-C")
            .arg(&self.root)
            .args(["check-ignore", "-q", "--"])
            .arg(rel_path)
            .output();
        matches!(output, Ok(output) if output.status.code() == Some(0))
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

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct StoreCounts {
    pub files: i64,
    pub sessions: i64,
    pub diagnostics: i64,
    pub tool_runs: i64,
    pub raw_outputs: i64,
    pub diagnostic_snapshots: i64,
    pub patch_drafts: i64,
    pub patch_draft_bodies: i64,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn upsert_session_tx(
    tx: &rusqlite::Transaction<'_>,
    project_id: i64,
    session_id: &str,
    now: i64,
) -> Result<(), rusqlite::Error> {
    tx.execute(
        "INSERT INTO sessions(id, project_id, agent, started_at, last_seen_at, status)
         VALUES(?1, ?2, NULL, ?3, ?3, 'active')
         ON CONFLICT(id) DO UPDATE SET last_seen_at=excluded.last_seen_at, status='active'",
        params![session_id, project_id, now],
    )?;
    Ok(())
}

fn tool_phase(phase: &LensToolEventPhase) -> &'static str {
    match phase {
        LensToolEventPhase::PreTool => "pre_tool",
        LensToolEventPhase::PostTool => "post_tool",
    }
}

fn touched_source(source: &LensTouchedFileSource) -> &'static str {
    match source {
        LensTouchedFileSource::StructuredEvent => "structured_event",
    }
}

fn parse_touched_source(_source: &str) -> LensTouchedFileSource {
    LensTouchedFileSource::StructuredEvent
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

fn diagnostic_source(source: &DiagnosticSource) -> String {
    match source {
        DiagnosticSource::Lsp => "lsp".to_string(),
        DiagnosticSource::AstGrep => "ast_grep".to_string(),
        DiagnosticSource::TreeSitter => "tree_sitter".to_string(),
        DiagnosticSource::Secrets => "secrets".to_string(),
        DiagnosticSource::Security => "security".to_string(),
        DiagnosticSource::Formatter => "formatter".to_string(),
        DiagnosticSource::Autofix => "autofix".to_string(),
        DiagnosticSource::Test => "test".to_string(),
        DiagnosticSource::Other(value) => value.clone(),
    }
}

fn diagnostic_severity(severity: &DiagnosticSeverity) -> &'static str {
    match severity {
        DiagnosticSeverity::Error => "error",
        DiagnosticSeverity::Warning => "warning",
        DiagnosticSeverity::Info => "info",
        DiagnosticSeverity::Hint => "hint",
    }
}

fn parse_diagnostic_source(source: &str) -> DiagnosticSource {
    match source {
        "lsp" => DiagnosticSource::Lsp,
        "ast_grep" => DiagnosticSource::AstGrep,
        "tree_sitter" => DiagnosticSource::TreeSitter,
        "secrets" => DiagnosticSource::Secrets,
        "security" => DiagnosticSource::Security,
        "formatter" => DiagnosticSource::Formatter,
        "autofix" => DiagnosticSource::Autofix,
        "test" => DiagnosticSource::Test,
        other => DiagnosticSource::Other(other.to_string()),
    }
}

fn parse_diagnostic_severity(severity: &str) -> DiagnosticSeverity {
    match severity {
        "error" => DiagnosticSeverity::Error,
        "warning" => DiagnosticSeverity::Warning,
        "info" => DiagnosticSeverity::Info,
        "hint" => DiagnosticSeverity::Hint,
        _ => DiagnosticSeverity::Warning,
    }
}

fn diagnostic_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Diagnostic> {
    diagnostic_from_row_offset(row, 0)
}

fn diagnostic_from_row_offset(
    row: &rusqlite::Row<'_>,
    offset: usize,
) -> rusqlite::Result<Diagnostic> {
    Ok(Diagnostic {
        source: parse_diagnostic_source(row.get::<_, String>(offset + 1)?.as_str()),
        scope: DiagnosticScope {
            kind: row.get(offset + 2)?,
            key: row.get(offset + 3)?,
        },
        severity: parse_diagnostic_severity(row.get::<_, String>(offset + 4)?.as_str()),
        code: row.get(offset + 5)?,
        message: row.get(offset + 6)?,
        rel_path: row.get(offset + 7)?,
        start_line: row.get(offset + 8)?,
        end_line: row.get(offset + 9)?,
        fingerprint: row.get(offset + 10)?,
        content_hash: row.get(offset + 11)?,
        raw_output_id: row.get(offset + 12)?,
        snapshot_id: row.get(offset + 13)?,
        first_seen_at: row.get(offset + 14)?,
        last_seen_at: row.get(offset + 15)?,
        resolved_at: row.get(offset + 16)?,
    })
}

fn normalized_fingerprint(diagnostic: &Diagnostic) -> String {
    if !diagnostic.fingerprint.trim().is_empty() {
        return diagnostic.fingerprint.clone();
    }
    crate::apply_patch::sha1_hex(
        format!(
            "{}:{}:{}:{:?}:{:?}:{:?}:{}",
            diagnostic_source(&diagnostic.source),
            diagnostic.scope.kind,
            diagnostic.scope.key,
            diagnostic.rel_path,
            diagnostic.start_line,
            diagnostic.code,
            diagnostic.message
        )
        .as_bytes(),
    )
}

fn delta_status(status: &DiagnosticDeltaStatus) -> &'static str {
    match status {
        DiagnosticDeltaStatus::New => "new",
        DiagnosticDeltaStatus::Resolved => "resolved",
        DiagnosticDeltaStatus::Unchanged => "unchanged",
    }
}

fn filter_delta_set(deltas: &mut DiagnosticDeltaSet, relevant: &BTreeSet<String>) {
    let relevant_path = |diagnostic: &Diagnostic| {
        diagnostic
            .rel_path
            .as_ref()
            .is_some_and(|path| relevant.contains(path))
    };
    deltas.resolved = deltas
        .resolved
        .iter()
        .filter(|diagnostic| relevant_path(diagnostic))
        .cloned()
        .collect();
    deltas.unchanged = deltas
        .unchanged
        .iter()
        .filter(|diagnostic| relevant_path(diagnostic))
        .cloned()
        .collect();
}

fn reset_schema_for_v9(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        r#"
        DROP INDEX IF EXISTS idx_lens_ack_project_session_turn;
        DROP INDEX IF EXISTS idx_turn_touched_project_session_turn;
        DROP INDEX IF EXISTS idx_turns_project_session_turn;
        DROP INDEX IF EXISTS idx_patch_draft_chunks_patch;
        DROP INDEX IF EXISTS idx_patch_drafts_project_status;
        DROP INDEX IF EXISTS idx_guard_overrides_project_session_path;
        DROP INDEX IF EXISTS idx_read_events_session_file;
        DROP INDEX IF EXISTS idx_raw_outputs_project_expires;
        DROP INDEX IF EXISTS idx_diagnostic_snapshots_project_scope;
        DROP INDEX IF EXISTS idx_diagnostics_project_scope;
        DROP INDEX IF EXISTS idx_diagnostics_project_file;
        DROP INDEX IF EXISTS idx_files_project_rel;

        DROP TABLE IF EXISTS retention_metadata;
        DROP TABLE IF EXISTS lens_action_acknowledgements;
        DROP TABLE IF EXISTS turn_touched_files;
        DROP TABLE IF EXISTS turn_tool_events;
        DROP TABLE IF EXISTS turns;
        DROP TABLE IF EXISTS tool_runs;
        DROP TABLE IF EXISTS diagnostic_snapshot_deltas;
        DROP TABLE IF EXISTS diagnostics;
        DROP TABLE IF EXISTS diagnostic_snapshots;
        DROP TABLE IF EXISTS raw_outputs;
        DROP TABLE IF EXISTS patch_affected_symbols;
        DROP TABLE IF EXISTS patch_draft_candidates;
        DROP TABLE IF EXISTS patch_draft_chunks;
        DROP TABLE IF EXISTS patch_draft_bodies;
        DROP TABLE IF EXISTS patch_drafts;
        DROP TABLE IF EXISTS patch_hunks;
        DROP TABLE IF EXISTS patch_events;
        DROP TABLE IF EXISTS guard_overrides;
        DROP TABLE IF EXISTS read_ranges;
        DROP TABLE IF EXISTS read_events;
        DROP TABLE IF EXISTS sessions;
        DROP TABLE IF EXISTS files;
        DROP TABLE IF EXISTS projects;
        "#,
    )
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

    #[test]
    fn v9_reset_drops_read_and_guard_state() {
        let temp = tempfile::tempdir().unwrap();
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, root TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
             CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, rel_path TEXT NOT NULL);
             CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id INTEGER NOT NULL, started_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, status TEXT NOT NULL);
             CREATE TABLE read_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, file_id INTEGER NOT NULL, file_hash TEXT NOT NULL, source TEXT NOT NULL, created_at INTEGER NOT NULL);
             CREATE TABLE read_ranges (id INTEGER PRIMARY KEY AUTOINCREMENT, read_event_id INTEGER NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL);
             CREATE TABLE guard_overrides (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, session_id TEXT, rel_path TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
             INSERT INTO projects(id, root, created_at, updated_at) VALUES(1, 'old', 1, 1);
             INSERT INTO files(id, project_id, rel_path) VALUES(1, 1, 'main.rs');
             INSERT INTO sessions(id, project_id, started_at, last_seen_at, status) VALUES('s', 1, 1, 1, 'active');
             INSERT INTO read_events(id, session_id, file_id, file_hash, source, created_at) VALUES(1, 's', 1, 'hash', 'test', 1);
             INSERT INTO read_ranges(read_event_id, start_line, end_line) VALUES(1, 1, 1);
             INSERT INTO guard_overrides(project_id, session_id, rel_path, created_at) VALUES(1, 's', 'main.rs', 1);
             PRAGMA user_version = 8;",
        )
        .unwrap();

        let store = LensStore::init(conn, temp.path()).unwrap();

        let user_version: i32 = store
            .with_conn(|conn| conn.query_row("PRAGMA user_version", [], |row| row.get(0)))
            .unwrap();
        assert_eq!(user_version, 9);
        for table in ["read_events", "read_ranges", "guard_overrides"] {
            let exists: Option<String> = store
                .with_conn(|conn| {
                    conn.query_row(
                        "SELECT name FROM sqlite_master WHERE type='table' AND name=?1",
                        params![table],
                        |row| row.get(0),
                    )
                    .optional()
                })
                .unwrap();
            assert!(exists.is_none(), "{table} should be dropped by v9 reset");
        }
        assert_eq!(store.counts().unwrap().diagnostics, 0);
    }

    #[test]
    fn records_and_lists_diagnostics() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("main.rs"), "fn main() {}\n").unwrap();
        let mut store = LensStore::open_in_memory_for_tests(temp.path()).unwrap();
        store
            .record_diagnostics(&[Diagnostic {
                source: DiagnosticSource::Lsp,
                scope: DiagnosticScope::file("main.rs"),
                severity: DiagnosticSeverity::Error,
                code: Some("E000".to_string()),
                message: "broken".to_string(),
                rel_path: Some("main.rs".to_string()),
                start_line: Some(1),
                end_line: Some(1),
                fingerprint: "diag-1".to_string(),
                content_hash: None,
                raw_output_id: None,
                snapshot_id: None,
                first_seen_at: None,
                last_seen_at: None,
                resolved_at: None,
            }])
            .unwrap();

        let diagnostics = store.list_diagnostics(Some("main.rs")).unwrap();
        assert_eq!(diagnostics.len(), 1);
        assert_eq!(diagnostics[0].message, "broken");
        assert_eq!(diagnostics[0].severity, DiagnosticSeverity::Error);
    }

    fn diagnostic(path: &str, fingerprint: &str, message: &str) -> Diagnostic {
        Diagnostic {
            source: DiagnosticSource::Lsp,
            scope: DiagnosticScope::file(path),
            severity: DiagnosticSeverity::Error,
            code: None,
            message: message.to_string(),
            rel_path: Some(path.to_string()),
            start_line: Some(1),
            end_line: Some(1),
            fingerprint: fingerprint.to_string(),
            content_hash: None,
            raw_output_id: None,
            snapshot_id: None,
            first_seen_at: None,
            last_seen_at: None,
            resolved_at: None,
        }
    }

    fn snapshot(path: &str, diagnostics: Vec<Diagnostic>) -> DiagnosticSnapshotInput {
        DiagnosticSnapshotInput {
            source: DiagnosticSource::Lsp,
            scope: DiagnosticScope::file(path),
            diagnostics,
            raw_output: None,
            raw_output_max_bytes: None,
            metadata: Default::default(),
        }
    }

    #[test]
    fn snapshots_replace_by_source_scope_and_report_deltas() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("main.rs"), "fn main() {}\n").unwrap();
        std::fs::write(temp.path().join("other.rs"), "fn other() {}\n").unwrap();
        let mut store = LensStore::open_in_memory_for_tests(temp.path()).unwrap();

        let first = store
            .record_diagnostic_snapshot(snapshot(
                "main.rs",
                vec![
                    diagnostic("main.rs", "same", "kept"),
                    diagnostic("main.rs", "gone", "gone"),
                ],
            ))
            .unwrap();
        assert_eq!(first.deltas.new.len(), 2);

        let second = store
            .record_diagnostic_snapshot(snapshot(
                "main.rs",
                vec![
                    diagnostic("main.rs", "same", "kept"),
                    diagnostic("main.rs", "new", "new"),
                ],
            ))
            .unwrap();
        assert_eq!(second.deltas.new.len(), 1);
        assert_eq!(second.deltas.resolved.len(), 1);
        assert_eq!(second.deltas.unchanged.len(), 1);

        store
            .record_diagnostic_snapshot(snapshot(
                "other.rs",
                vec![diagnostic("other.rs", "same", "other")],
            ))
            .unwrap();

        let main = store.list_diagnostics(Some("main.rs")).unwrap();
        assert_eq!(main.len(), 2);
        assert!(
            main.iter()
                .all(|diagnostic| diagnostic.fingerprint != "gone")
        );
        let all = store.list_diagnostics(None).unwrap();
        assert_eq!(
            all.iter()
                .filter(|diagnostic| diagnostic.fingerprint == "same")
                .count(),
            2
        );
    }

    #[test]
    fn default_listing_filters_to_changed_and_new_findings() {
        let temp = tempfile::tempdir().unwrap();
        for path in ["changed.rs", "unrelated.rs", "untouched.rs"] {
            std::fs::write(temp.path().join(path), "fn main() {}\n").unwrap();
        }
        let mut store = LensStore::open_in_memory_for_tests(temp.path()).unwrap();
        let event = LensTurnEvent {
            schema_version: super::super::types::LENS_TURN_EVENT_SCHEMA_VERSION.to_string(),
            session: "s".to_string(),
            turn: "t".to_string(),
            host: "test".to_string(),
            cwd: temp.path().display().to_string(),
            event: super::super::types::LensTurnEventKind::ToolEnd,
            tool: "edit".to_string(),
            phase: LensToolEventPhase::PostTool,
            status: Some("success".to_string()),
            files: Vec::new(),
            policy: Default::default(),
        };
        store
            .record_turn_event(
                &event,
                &[LensTouchedFile {
                    path: "changed.rs".to_string(),
                    operation: "modify".to_string(),
                    start_line: None,
                    end_line: None,
                    tool: "edit".to_string(),
                    source: LensTouchedFileSource::StructuredEvent,
                    explicit: true,
                    ignored: false,
                    generated: false,
                }],
            )
            .unwrap();
        let baseline = vec![
            diagnostic("changed.rs", "changed", "changed"),
            diagnostic("untouched.rs", "untouched", "untouched"),
        ];
        store
            .record_diagnostic_snapshot(DiagnosticSnapshotInput {
                source: DiagnosticSource::Lsp,
                scope: DiagnosticScope::workspace(),
                diagnostics: baseline,
                raw_output: None,
                raw_output_max_bytes: None,
                metadata: Default::default(),
            })
            .unwrap();
        let diagnostics = vec![
            diagnostic("changed.rs", "changed", "changed"),
            diagnostic("unrelated.rs", "unrelated", "unrelated"),
            diagnostic("untouched.rs", "untouched", "untouched"),
        ];
        store
            .record_diagnostic_snapshot(DiagnosticSnapshotInput {
                source: DiagnosticSource::Lsp,
                scope: DiagnosticScope::workspace(),
                diagnostics,
                raw_output: None,
                raw_output_max_bytes: None,
                metadata: Default::default(),
            })
            .unwrap();

        let relevant = store.list_diagnostics_data(None, false).unwrap();
        let paths: BTreeSet<_> = relevant
            .diagnostics
            .iter()
            .filter_map(|diagnostic| diagnostic.rel_path.as_deref())
            .collect();
        assert_eq!(paths, BTreeSet::from(["changed.rs", "unrelated.rs"]));
        assert_eq!(relevant.deltas.new.len(), 1);
        assert_eq!(relevant.deltas.unchanged.len(), 1);

        let all = store.list_diagnostics_data(None, true).unwrap();
        assert_eq!(all.diagnostic_count, 3);
    }

    #[test]
    fn default_listing_ignores_git_ignored_paths_but_all_includes_them() {
        let temp = tempfile::tempdir().unwrap();
        std::process::Command::new("git")
            .current_dir(temp.path())
            .args(["init", "--initial-branch=main"])
            .status()
            .unwrap();
        std::fs::write(temp.path().join(".gitignore"), "ignored.log\n").unwrap();
        std::fs::write(temp.path().join("ignored.log"), "noise\n").unwrap();
        let mut store = LensStore::open_in_memory_for_tests(temp.path()).unwrap();
        store
            .record_diagnostic_snapshot(DiagnosticSnapshotInput {
                source: DiagnosticSource::Test,
                scope: DiagnosticScope::command("test"),
                diagnostics: vec![Diagnostic {
                    source: DiagnosticSource::Test,
                    scope: DiagnosticScope::command("test"),
                    ..diagnostic("ignored.log", "ignored", "ignored")
                }],
                raw_output: None,
                raw_output_max_bytes: None,
                metadata: Default::default(),
            })
            .unwrap();

        assert_eq!(
            store
                .list_diagnostics_data(None, false)
                .unwrap()
                .diagnostic_count,
            0
        );
        assert_eq!(
            store
                .list_diagnostics_data(None, true)
                .unwrap()
                .diagnostic_count,
            1
        );
    }

    #[test]
    fn raw_outputs_are_capped_redacted_and_pruned_without_dropping_diagnostics() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("main.rs"), "fn main() {}\n").unwrap();
        let mut store = LensStore::open_in_memory_for_tests(temp.path()).unwrap();
        let raw = format!(
            "token=super-secret\n{}",
            "x".repeat(raw_output::DEFAULT_RAW_OUTPUT_MAX_BYTES + 10)
        );
        let result = store
            .record_diagnostic_snapshot(DiagnosticSnapshotInput {
                source: DiagnosticSource::Test,
                scope: DiagnosticScope::command("cargo test"),
                diagnostics: vec![Diagnostic {
                    source: DiagnosticSource::Test,
                    scope: DiagnosticScope::command("cargo test"),
                    ..diagnostic("main.rs", "raw", "raw")
                }],
                raw_output: Some(raw),
                raw_output_max_bytes: None,
                metadata: Default::default(),
            })
            .unwrap();
        let raw_ref = result.raw_output.unwrap();
        assert!(raw_ref.truncated);
        assert!(raw_ref.redacted);
        store.with_conn(|conn| {
            let body: String = conn
                .query_row(
                    "SELECT body FROM raw_outputs WHERE id=?1",
                    params![raw_ref.id],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(!body.contains("super-secret"));
            assert!(body.len() <= raw_output::DEFAULT_RAW_OUTPUT_MAX_BYTES);
            conn.execute(
                "UPDATE raw_outputs SET expires_at=0 WHERE id=?1",
                params![raw_ref.id],
            )
            .unwrap();
        });
        let report = super::super::retention::prune(&store, &Default::default(), false).unwrap();
        assert_eq!(report.raw_outputs_deleted, 1);
        assert_eq!(store.counts().unwrap().raw_outputs, 0);
        assert_eq!(store.list_diagnostics(None).unwrap().len(), 1);
    }
}
