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
    pub actionability: String,
    pub next_action: String,
    pub fingerprint: String,
    pub occurrence_count: i64,
    pub novelty: String,
    pub message: String,
    pub anchors: Vec<String>,
    pub files: Vec<String>,
    pub candidates: serde_json::Value,
    pub ts: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_skeleton: Option<String>,
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
            actionability: actionability_for_kind(&input.failure_kind).to_string(),
            next_action: next_action_for_kind(&input.failure_kind).to_string(),
            fingerprint,
            occurrence_count,
            novelty,
            message: input.message.clone(),
            anchors: input.anchors.clone(),
            files: input.files.clone(),
            candidates: input.candidates.clone(),
            ts,
            retry_skeleton: None,
        })
    }
}

fn failure_fingerprint(
    input: &FailureDiagnosticInput,
    anchors_json: &str,
    files_json: &str,
) -> String {
    let normalized_anchors = normalized_anchor_fingerprint(&input.anchors, anchors_json);
    let normalized_message = normalized_message_fingerprint(input);
    sha1_hex(
        format!(
            "{}\0{}\0{}\0{}",
            input.failure_kind, normalized_message, normalized_anchors, files_json
        )
        .as_bytes(),
    )
}

fn has_bare_anchor(anchors: &[String]) -> bool {
    anchors.iter().any(|anchor| anchor == "bare @@")
}

fn has_suggested_anchor(anchors: &[String]) -> bool {
    anchors
        .iter()
        .any(|anchor| anchor.contains("pins to candidate"))
}

fn actionability_for_kind(kind: &str) -> &'static str {
    match kind {
        "anchor_shadows" | "anchor_shadows_first_context" => "safe-to-apply-candidate",
        "context_not_found" | "ambiguous_context" => "retry-with-repair",
        "parse"
        | "parse_envelope"
        | "parse_empty_update"
        | "parse_unknown_hunk_header"
        | "add_missing_plus"
        | "unprefixed_line"
        | "missing_chunk_header"
        | "empty_update"
        | "unknown_hunk_header" => "malformed-patch",
        "add_target_exists"
        | "move_target_exists"
        | "duplicate_update"
        | "line_range_mismatch"
        | "replacement_count_mismatch"
        | "delete_is_directory"
        | "target_is_directory"
        | "read_only_target" => "guardrail-conflict",
        "io" | "rollback_failed" => "internal/io",
        _ => "unknown",
    }
}

fn next_action_for_kind(kind: &str) -> &'static str {
    match kind {
        "add_target_exists" => {
            return "delete the existing file first or convert the hunk to Update File";
        }
        "move_target_exists" => {
            return "delete or rename the destination first, then retry the move";
        }
        "duplicate_update" => return "combine updates for the same file into one Update File hunk",
        "line_range_mismatch" => return "re-read the target lines or remove the stale line range",
        "replacement_count_mismatch" => {
            return "set Expect Replacements to the observed count or narrow the match";
        }
        _ => {}
    }
    match actionability_for_kind(kind) {
        "safe-to-apply-candidate" => {
            "retry with the latest apply-patch; this pattern may now apply safely"
        }
        "retry-with-repair" => "refresh context or add a stable anchor before retrying",
        "malformed-patch" => "fix the patch envelope or hunk grammar, then retry",
        "guardrail-conflict" => {
            "express replacement intent explicitly or inspect the retained draft"
        }
        "internal/io" => "inspect filesystem state and retry after resolving the IO failure",
        _ => "inspect the diagnostic and regenerate the patch",
    }
}

fn normalized_anchor_fingerprint(anchors: &[String], anchors_json: &str) -> String {
    if has_bare_anchor(anchors) {
        return "bare @@".to_string();
    }
    if has_suggested_anchor(anchors) {
        return "suggested @@".to_string();
    }
    anchors_json.to_string()
}

fn normalized_message_fingerprint(input: &FailureDiagnosticInput) -> String {
    match input.failure_kind.as_str() {
        "context_not_found" | "ambiguous_context" => input.failure_kind.clone(),
        _ => input
            .message
            .split_whitespace()
            .take(24)
            .collect::<Vec<_>>()
            .join(" "),
    }
}
