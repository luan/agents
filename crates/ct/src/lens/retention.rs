use serde::{Deserialize, Serialize};

use super::store::LensStore;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RetentionPolicy {
    pub max_diagnostics: i64,
    pub max_tool_runs: i64,
    pub max_sessions: i64,
    pub max_patch_drafts: i64,
    pub max_patch_draft_bodies: i64,
    pub max_raw_outputs: i64,
}

impl Default for RetentionPolicy {
    fn default() -> Self {
        Self {
            max_diagnostics: 10_000,
            max_tool_runs: 2_000,
            max_sessions: 500,
            max_patch_drafts: 500,
            max_patch_draft_bodies: 100,
            max_raw_outputs: 1_000,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PruneReport {
    pub diagnostics_deleted: i64,
    pub tool_runs_deleted: i64,
    pub sessions_deleted: i64,
    pub patch_drafts_deleted: i64,
    pub patch_draft_bodies_deleted: i64,
    pub raw_outputs_deleted: i64,
    pub dry_run: bool,
}

pub fn prune(
    store: &LensStore,
    policy: &RetentionPolicy,
    dry_run: bool,
) -> Result<PruneReport, Box<dyn std::error::Error>> {
    store.with_conn(|conn| -> Result<PruneReport, Box<dyn std::error::Error>> {
        let diagnostics_deleted = overflow_count(conn, "diagnostics", policy.max_diagnostics)?;
        let tool_runs_deleted = overflow_count(conn, "tool_runs", policy.max_tool_runs)?;
        let sessions_deleted = overflow_count(conn, "sessions", policy.max_sessions)?;
        let patch_drafts_deleted = overflow_count(conn, "patch_drafts", policy.max_patch_drafts)?;
        let patch_draft_bodies_deleted =
            overflow_count(conn, "patch_draft_bodies", policy.max_patch_draft_bodies)?;
        let raw_output_overflow = overflow_count(conn, "raw_outputs", policy.max_raw_outputs)?;
        let raw_output_expired = expired_count(conn, "raw_outputs")?;
        let raw_outputs_deleted = raw_output_overflow + raw_output_expired;
        if !dry_run {
            delete_overflow(conn, "diagnostics", policy.max_diagnostics)?;
            delete_overflow(conn, "tool_runs", policy.max_tool_runs)?;
            delete_overflow(conn, "sessions", policy.max_sessions)?;
            delete_overflow(conn, "patch_drafts", policy.max_patch_drafts)?;
            delete_overflow(conn, "patch_draft_bodies", policy.max_patch_draft_bodies)?;
            delete_expired(conn, "raw_outputs")?;
            delete_overflow(conn, "raw_outputs", policy.max_raw_outputs)?;
            conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
        }
        Ok(PruneReport {
            diagnostics_deleted,
            tool_runs_deleted,
            sessions_deleted,
            patch_drafts_deleted,
            patch_draft_bodies_deleted,
            raw_outputs_deleted,
            dry_run,
        })
    })
}

fn overflow_count(conn: &rusqlite::Connection, table: &str, max: i64) -> rusqlite::Result<i64> {
    let total: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
        row.get(0)
    })?;
    Ok((total - max).max(0))
}

fn expired_count(conn: &rusqlite::Connection, table: &str) -> rusqlite::Result<i64> {
    conn.query_row(
        &format!("SELECT COUNT(*) FROM {table} WHERE expires_at <= ?1"),
        rusqlite::params![now_ms()],
        |row| row.get(0),
    )
}

fn delete_expired(conn: &rusqlite::Connection, table: &str) -> rusqlite::Result<()> {
    conn.execute(
        &format!("DELETE FROM {table} WHERE expires_at <= ?1"),
        rusqlite::params![now_ms()],
    )?;
    Ok(())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn delete_overflow(conn: &rusqlite::Connection, table: &str, max: i64) -> rusqlite::Result<()> {
    let key = match table {
        "patch_draft_bodies" => "patch_id",
        _ => "id",
    };
    conn.execute(
        &format!(
            "DELETE FROM {table} WHERE {key} IN (SELECT {key} FROM {table} ORDER BY {key} ASC LIMIT (SELECT MAX(COUNT(*) - ?1, 0) FROM {table}))"
        ),
        rusqlite::params![max],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lens::{
        Diagnostic, DiagnosticScope, DiagnosticSeverity, DiagnosticSource, LensStore,
    };

    #[test]
    fn prune_dry_run_reports_without_deleting_state() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("main.rs"), "fn main() {}\n").unwrap();
        let mut store = LensStore::open_in_memory_for_tests(temp.path()).unwrap();
        for index in 0..3 {
            store
                .record_diagnostics(&[Diagnostic {
                    source: DiagnosticSource::Test,
                    scope: DiagnosticScope::file("main.rs"),
                    severity: DiagnosticSeverity::Warning,
                    code: None,
                    message: format!("warning {index}"),
                    rel_path: Some("main.rs".to_string()),
                    start_line: Some(1),
                    end_line: Some(1),
                    fingerprint: format!("warning-{index}"),
                    content_hash: None,
                    raw_output_id: None,
                    snapshot_id: None,
                    first_seen_at: None,
                    last_seen_at: None,
                    resolved_at: None,
                }])
                .unwrap();
        }

        let report = prune(
            &store,
            &RetentionPolicy {
                max_diagnostics: 1,
                ..RetentionPolicy::default()
            },
            true,
        )
        .unwrap();

        assert!(report.dry_run);
        assert_eq!(report.diagnostics_deleted, 2);
        assert_eq!(store.counts().unwrap().diagnostics, 3);
    }
}
