use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use super::{Telemetry, TelemetryError, now_ms, sha1_hex};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FailureDiagnosticInput {
    pub call_id: i64,
    pub patch_id: String,
    pub patch_sha: String,
    pub failure_kind: String,
    pub message: String,
    pub anchors: Vec<String>,
    pub files: Vec<String>,
    pub candidates: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FailureDiagnostic {
    pub diagnostic_id: String,
    pub telemetry_id: String,
    pub call_id: i64,
    pub patch_id: String,
    pub patch_sha: String,
    pub failure_kind: String,
    pub fingerprint: String,
    pub occurrence_count: i64,
    pub novelty: String,
    pub message: String,
    pub anchors: Vec<String>,
    pub files: Vec<String>,
    pub candidates: serde_json::Value,
    pub ts: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FailureFingerprintSummary {
    pub fingerprint: String,
    pub failure_kind: String,
    pub occurrence_count: i64,
    pub last_diagnostic_id: String,
    pub last_patch_id: String,
    pub anchors: Vec<String>,
    pub first_seen_ts: i64,
    pub last_seen_ts: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FailureReport {
    pub diagnostics: Vec<FailureDiagnostic>,
    pub recurring: Vec<FailureFingerprintSummary>,
}

impl Telemetry {
    pub fn record_failure_diagnostic(
        &self,
        input: &FailureDiagnosticInput,
    ) -> Result<FailureDiagnostic, TelemetryError> {
        let anchors_json = serde_json::to_string(&input.anchors)?;
        let files_json = serde_json::to_string(&input.files)?;
        let candidates_json = serde_json::to_string(&input.candidates)?;
        let fingerprint = failure_fingerprint(input, &anchors_json, &files_json);
        let ts = now_ms();
        let telemetry_id = format!("apt-call-{}", input.call_id);
        let diagnostic_id = format!("apd-{}", input.call_id);
        let conn = self.lock_conn();
        let previous: Option<i64> = conn
            .query_row(
                "SELECT occurrence_count FROM failure_fingerprints WHERE fingerprint = ?1",
                params![&fingerprint],
                |row| row.get(0),
            )
            .optional()?;
        let occurrence_count = previous.unwrap_or(0) + 1;
        let novelty = if previous.is_some() {
            "repeated"
        } else {
            "novel"
        }
        .to_string();
        conn.execute(
            "INSERT INTO failure_diagnostics
             (ts, call_id, diagnostic_id, patch_id, patch_sha, failure_kind, fingerprint, occurrence_count, novelty, message, anchors_json, files_json, candidates_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                ts,
                input.call_id,
                &diagnostic_id,
                &input.patch_id,
                &input.patch_sha,
                &input.failure_kind,
                &fingerprint,
                occurrence_count,
                &novelty,
                &input.message,
                &anchors_json,
                &files_json,
                &candidates_json,
            ],
        )?;
        conn.execute(
            "INSERT INTO failure_fingerprints
             (fingerprint, failure_kind, first_seen_ts, last_seen_ts, occurrence_count, last_diagnostic_id, last_patch_id, anchors_json)
             VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(fingerprint) DO UPDATE SET
                 last_seen_ts = excluded.last_seen_ts,
                 occurrence_count = excluded.occurrence_count,
                 last_diagnostic_id = excluded.last_diagnostic_id,
                 last_patch_id = excluded.last_patch_id,
                 anchors_json = excluded.anchors_json",
            params![
                &fingerprint,
                &input.failure_kind,
                ts,
                occurrence_count,
                &diagnostic_id,
                &input.patch_id,
                &anchors_json,
            ],
        )?;
        Ok(FailureDiagnostic {
            diagnostic_id,
            telemetry_id,
            call_id: input.call_id,
            patch_id: input.patch_id.clone(),
            patch_sha: input.patch_sha.clone(),
            failure_kind: input.failure_kind.clone(),
            fingerprint,
            occurrence_count,
            novelty,
            message: input.message.clone(),
            anchors: input.anchors.clone(),
            files: input.files.clone(),
            candidates: input.candidates.clone(),
            ts,
        })
    }

    pub fn failure_diagnostic(
        &self,
        diagnostic_id: &str,
    ) -> Result<Option<FailureDiagnostic>, TelemetryError> {
        Ok(self.with_conn(|conn| {
            conn.query_row(
                "SELECT ts, call_id, diagnostic_id, patch_id, patch_sha, failure_kind, fingerprint,
                        occurrence_count, novelty, message, anchors_json, files_json, candidates_json
                 FROM failure_diagnostics
                 WHERE diagnostic_id = ?1",
                params![diagnostic_id],
                diagnostic_from_row,
            )
            .optional()
        })?)
    }

    pub fn failure_report(&self, limit: usize) -> Result<FailureReport, TelemetryError> {
        let limit = limit.max(1) as i64;
        let diagnostics = self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT ts, call_id, diagnostic_id, patch_id, patch_sha, failure_kind, fingerprint,
                        occurrence_count, novelty, message, anchors_json, files_json, candidates_json
                 FROM failure_diagnostics
                 ORDER BY ts DESC, id DESC
                 LIMIT ?1",
            )?;
            stmt.query_map(params![limit], diagnostic_from_row)?
                .collect::<rusqlite::Result<Vec<_>>>()
        })?;
        let recurring = self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT fingerprint, failure_kind, occurrence_count, last_diagnostic_id, last_patch_id,
                        anchors_json, first_seen_ts, last_seen_ts
                 FROM failure_fingerprints
                 WHERE occurrence_count > 1
                 ORDER BY occurrence_count DESC, last_seen_ts DESC
                 LIMIT ?1",
            )?;
            stmt.query_map(params![limit], fingerprint_from_row)?
                .collect::<rusqlite::Result<Vec<_>>>()
        })?;
        Ok(FailureReport {
            diagnostics,
            recurring,
        })
    }
}

pub fn render_report(report: &FailureReport) -> String {
    let mut out = String::new();
    out.push_str("apply-patch failure diagnostics\n");
    if report.diagnostics.is_empty() {
        out.push_str("(no failure diagnostics recorded)\n");
        return out;
    }
    out.push_str("recent:\n");
    for diagnostic in &report.diagnostics {
        out.push_str(&format!(
            "- {} {} patch={} telemetry={} occurrences={}\n",
            diagnostic.diagnostic_id,
            diagnostic.failure_kind,
            diagnostic.patch_id,
            diagnostic.telemetry_id,
            diagnostic.occurrence_count
        ));
        if !diagnostic.anchors.is_empty() {
            out.push_str(&format!("  anchors: {}\n", diagnostic.anchors.join(" | ")));
        }
    }
    if !report.recurring.is_empty() {
        out.push_str("recurring fingerprints:\n");
        for fp in &report.recurring {
            out.push_str(&format!(
                "- {} {} occurrences={} last={} patch={}\n",
                fp.fingerprint,
                fp.failure_kind,
                fp.occurrence_count,
                fp.last_diagnostic_id,
                fp.last_patch_id
            ));
        }
    }
    out
}

pub fn render_diagnostic(diagnostic: &FailureDiagnostic) -> String {
    let mut out = format!(
        "apply-patch diagnostic {}\nkind: {}\npatch: {}\ntelemetry: {}\nfingerprint: {}\noccurrences: {} ({})\n",
        diagnostic.diagnostic_id,
        diagnostic.failure_kind,
        diagnostic.patch_id,
        diagnostic.telemetry_id,
        diagnostic.fingerprint,
        diagnostic.occurrence_count,
        diagnostic.novelty
    );
    if !diagnostic.files.is_empty() {
        out.push_str(&format!("files: {}\n", diagnostic.files.join(", ")));
    }
    if !diagnostic.anchors.is_empty() {
        out.push_str(&format!("anchors: {}\n", diagnostic.anchors.join(" | ")));
    }
    out.push_str(&format!("message: {}\n", diagnostic.message));
    out
}

fn failure_fingerprint(
    input: &FailureDiagnosticInput,
    anchors_json: &str,
    files_json: &str,
) -> String {
    sha1_hex(
        format!(
            "{}\0{}\0{}\0{}",
            input.failure_kind, input.message, anchors_json, files_json
        )
        .as_bytes(),
    )
}

fn diagnostic_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<FailureDiagnostic> {
    let ts = row.get(0)?;
    let call_id = row.get(1)?;
    let diagnostic_id: String = row.get(2)?;
    let anchors_json: String = row.get(10)?;
    let files_json: String = row.get(11)?;
    let candidates_json: String = row.get(12)?;
    Ok(FailureDiagnostic {
        ts,
        call_id,
        telemetry_id: format!("apt-call-{call_id}"),
        diagnostic_id,
        patch_id: row.get(3)?,
        patch_sha: row.get(4)?,
        failure_kind: row.get(5)?,
        fingerprint: row.get(6)?,
        occurrence_count: row.get(7)?,
        novelty: row.get(8)?,
        message: row.get(9)?,
        anchors: serde_json::from_str(&anchors_json).unwrap_or_default(),
        files: serde_json::from_str(&files_json).unwrap_or_default(),
        candidates: serde_json::from_str(&candidates_json).unwrap_or(serde_json::Value::Null),
    })
}

fn fingerprint_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<FailureFingerprintSummary> {
    let anchors_json: String = row.get(5)?;
    Ok(FailureFingerprintSummary {
        fingerprint: row.get(0)?,
        failure_kind: row.get(1)?,
        occurrence_count: row.get(2)?,
        last_diagnostic_id: row.get(3)?,
        last_patch_id: row.get(4)?,
        anchors: serde_json::from_str(&anchors_json).unwrap_or_default(),
        first_seen_ts: row.get(6)?,
        last_seen_ts: row.get(7)?,
    })
}
