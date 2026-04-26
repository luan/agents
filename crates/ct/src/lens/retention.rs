use serde::{Deserialize, Serialize};

use super::store::LensStore;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetentionPolicy {
    pub max_diagnostics: i64,
    pub max_tool_runs: i64,
    pub max_sessions: i64,
    pub max_patch_drafts: i64,
    pub max_patch_draft_bodies: i64,
}

impl Default for RetentionPolicy {
    fn default() -> Self {
        Self {
            max_diagnostics: 10_000,
            max_tool_runs: 2_000,
            max_sessions: 500,
            max_patch_drafts: 500,
            max_patch_draft_bodies: 100,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PruneReport {
    pub diagnostics_deleted: i64,
    pub tool_runs_deleted: i64,
    pub sessions_deleted: i64,
    pub patch_drafts_deleted: i64,
    pub patch_draft_bodies_deleted: i64,
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
        if !dry_run {
            delete_overflow(conn, "diagnostics", policy.max_diagnostics)?;
            delete_overflow(conn, "tool_runs", policy.max_tool_runs)?;
            delete_overflow(conn, "sessions", policy.max_sessions)?;
            delete_overflow(conn, "patch_drafts", policy.max_patch_drafts)?;
            delete_overflow(conn, "patch_draft_bodies", policy.max_patch_draft_bodies)?;
            conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
        }
        Ok(PruneReport {
            diagnostics_deleted,
            tool_runs_deleted,
            sessions_deleted,
            patch_drafts_deleted,
            patch_draft_bodies_deleted,
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

fn delete_overflow(conn: &rusqlite::Connection, table: &str, max: i64) -> rusqlite::Result<()> {
    conn.execute(
        &format!(
            "DELETE FROM {table} WHERE id IN (SELECT id FROM {table} ORDER BY id ASC LIMIT (SELECT MAX(COUNT(*) - ?1, 0) FROM {table}))"
        ),
        rusqlite::params![max],
    )?;
    Ok(())
}
