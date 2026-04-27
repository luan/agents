use std::path::Path;

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use super::contract::LensEnvelope;
use super::store::LensStore;
use super::types::{DiagnosticScope, RawOutputRef};

pub const DEFAULT_RAW_OUTPUT_MAX_BYTES: usize = 64 * 1024;
pub const DEFAULT_RAW_OUTPUT_TTL_DAYS: i64 = 7;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawOutputListData {
    pub project_id: i64,
    pub outputs: Vec<RawOutputSummary>,
    pub output_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawOutputSummary {
    pub id: i64,
    pub source: String,
    pub scope: DiagnosticScope,
    pub original_bytes: i64,
    pub retained_bytes: i64,
    pub truncated: bool,
    pub redacted: bool,
    pub created_at: i64,
    pub expires_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawOutputShowData {
    pub project_id: i64,
    pub output: RawOutputBody,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawOutputBody {
    #[serde(flatten)]
    pub summary: RawOutputSummary,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SanitizedRawOutput {
    pub body: String,
    pub original_bytes: i64,
    pub retained_bytes: i64,
    pub truncated: bool,
    pub redacted: bool,
}

pub fn list_envelope(
    root: &Path,
    limit: usize,
) -> Result<LensEnvelope<RawOutputListData>, Box<dyn std::error::Error>> {
    let store = LensStore::open_for_project(root)?;
    Ok(LensEnvelope::ok(list_with_store(&store, limit)?))
}

pub fn show_envelope(
    root: &Path,
    id: i64,
) -> Result<LensEnvelope<RawOutputShowData>, Box<dyn std::error::Error>> {
    let store = LensStore::open_for_project(root)?;
    Ok(LensEnvelope::ok(show_with_store(&store, id)?))
}

pub fn list_with_store(
    store: &LensStore,
    limit: usize,
) -> Result<RawOutputListData, Box<dyn std::error::Error>> {
    let outputs = store.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, source, scope_kind, scope_key, original_bytes, retained_bytes, truncated, redacted, created_at, expires_at
             FROM raw_outputs
             WHERE project_id=?1
             ORDER BY created_at DESC, id DESC
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![store.project_id(), limit as i64], summary_from_row)?;
        rows.collect::<Result<Vec<_>, _>>()
    })?;
    Ok(RawOutputListData {
        project_id: store.project_id(),
        output_count: outputs.len(),
        outputs,
    })
}

pub fn show_with_store(
    store: &LensStore,
    id: i64,
) -> Result<RawOutputShowData, Box<dyn std::error::Error>> {
    let output = store.with_conn(|conn| {
        conn.query_row(
            "SELECT id, source, scope_kind, scope_key, body, original_bytes, retained_bytes, truncated, redacted, created_at, expires_at
             FROM raw_outputs
             WHERE project_id=?1 AND id=?2",
            params![store.project_id(), id],
            |row| {
                Ok(RawOutputBody {
                    summary: RawOutputSummary {
                        id: row.get(0)?,
                        source: row.get(1)?,
                        scope: DiagnosticScope {
                            kind: row.get(2)?,
                            key: row.get(3)?,
                        },
                        original_bytes: row.get(5)?,
                        retained_bytes: row.get(6)?,
                        truncated: row.get(7)?,
                        redacted: row.get(8)?,
                        created_at: row.get(9)?,
                        expires_at: row.get(10)?,
                    },
                    body: row.get(4)?,
                })
            },
        )
        .optional()
    })?;
    let Some(output) = output else {
        return Err(format!("raw output not found: {id}").into());
    };
    Ok(RawOutputShowData {
        project_id: store.project_id(),
        output,
    })
}

pub fn sanitize(raw: &str, max_bytes: usize) -> SanitizedRawOutput {
    let redacted_body = redact(raw);
    let redacted = redacted_body != raw;
    let original_bytes = raw.len() as i64;
    let (body, truncated) = truncate_utf8(&redacted_body, max_bytes);
    let retained_bytes = body.len() as i64;
    SanitizedRawOutput {
        body,
        original_bytes,
        retained_bytes,
        truncated,
        redacted,
    }
}

pub fn expires_at(created_at: i64, ttl_days: i64) -> i64 {
    created_at + ttl_days.max(0) * 24 * 60 * 60 * 1000
}

pub fn ref_from_row(
    id: i64,
    original_bytes: i64,
    retained_bytes: i64,
    truncated: bool,
    redacted: bool,
    expires_at: i64,
) -> RawOutputRef {
    RawOutputRef {
        id,
        original_bytes,
        retained_bytes,
        truncated,
        redacted,
        expires_at,
    }
}

fn truncate_utf8(value: &str, max_bytes: usize) -> (String, bool) {
    if value.len() <= max_bytes {
        return (value.to_string(), false);
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    (value[..end].to_string(), true)
}

fn redact(raw: &str) -> String {
    raw.lines().map(redact_line).collect::<Vec<_>>().join("\n")
}

fn redact_line(line: &str) -> String {
    let lower = line.to_ascii_lowercase();
    for marker in [
        "authorization: bearer ",
        "authorization=bearer ",
        "api_key=",
        "api-key=",
        "token=",
        "password=",
        "secret=",
    ] {
        if let Some(index) = lower.find(marker) {
            let value_start = index + marker.len();
            return format!("{}[REDACTED]", &line[..value_start]);
        }
    }
    for marker in ["api_key:", "api-key:", "token:", "password:", "secret:"] {
        if let Some(index) = lower.find(marker) {
            let value_start = index + marker.len();
            return format!("{} [REDACTED]", line[..value_start].trim_end());
        }
    }
    line.to_string()
}

fn summary_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawOutputSummary> {
    Ok(RawOutputSummary {
        id: row.get(0)?,
        source: row.get(1)?,
        scope: DiagnosticScope {
            kind: row.get(2)?,
            key: row.get(3)?,
        },
        original_bytes: row.get(4)?,
        retained_bytes: row.get(5)?,
        truncated: row.get(6)?,
        redacted: row.get(7)?,
        created_at: row.get(8)?,
        expires_at: row.get(9)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_output_is_capped_and_redacted() {
        let sanitized = sanitize("token=abc123\nhello world", 14);
        assert!(sanitized.redacted);
        assert!(sanitized.truncated);
        assert!(!sanitized.body.contains("abc123"));
        assert!(sanitized.body.len() <= 14);
    }

    #[test]
    fn raw_output_expiry_uses_ttl_days() {
        assert_eq!(expires_at(1_000, 2), 1_000 + 2 * 24 * 60 * 60 * 1000);
    }
}
