use std::path::Path;

use serde::Serialize;

use super::draft;
use super::telemetry::diagnostics::{FailureDiagnostic, FailureDiagnosticInput};
use super::{
    AnchorAttempt, ApplyFailure, ApplyPatchError, CallRecord, FileCallEntry, Fingerprint,
    Telemetry, sha1_hex,
};

#[derive(Debug, Clone, Serialize)]
pub struct RepairBlock {
    pub patch_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub telemetry_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostic_id: Option<String>,
    pub failure_kind: String,
    pub anchors: Vec<String>,
    pub report_command: String,
    pub next_action: String,
    pub draft_created: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct FailureArtifacts {
    pub repair_block: RepairBlock,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<FailureDiagnostic>,
}

pub fn failure_kind(error: &ApplyPatchError) -> &'static str {
    match error {
        ApplyPatchError::Parse(e) => e.subkind_str(),
        ApplyPatchError::ContextNotFound { .. } => "context_not_found",
        ApplyPatchError::AmbiguousContext { .. } => "ambiguous_context",
        ApplyPatchError::AnchorShadowsFirstContext { .. } => "anchor_shadows_first_context",
        ApplyPatchError::DuplicateUpdate(_) => "duplicate_update",
        ApplyPatchError::DeleteIsDirectory(_) => "delete_is_directory",
        ApplyPatchError::TargetIsDirectory(_) => "target_is_directory",
        ApplyPatchError::ReadOnlyTarget(_) => "read_only_target",
        ApplyPatchError::AddTargetExists(_) => "add_target_exists",
        ApplyPatchError::MoveTargetExists(_) => "move_target_exists",
        ApplyPatchError::Io { .. } => "io",
        ApplyPatchError::RollbackFailed { .. } => "rollback_failed",
    }
}

pub fn handle_failure(
    tel: Option<&Telemetry>,
    cwd: &Path,
    failure: &ApplyFailure,
    duration_us: u64,
    patch_sha: &str,
    patch_body: &str,
) -> FailureArtifacts {
    let patch_id = sha1_hex(patch_body.as_bytes());
    let kind = failure_kind(&failure.error).to_string();
    let anchors = anchors_for_failure(&failure.error, &failure.attempts);
    let draft_created = create_or_link_draft(cwd, &patch_id, &kind, &failure.error, patch_body);
    let mut diagnostic = None;

    if let Some(tel) = tel {
        match record_failure(
            tel,
            failure,
            duration_us,
            patch_sha,
            patch_body,
            &patch_id,
            &kind,
            &anchors,
        ) {
            Ok(recorded) => diagnostic = Some(recorded),
            Err(e) => eprintln!("apply-patch telemetry: {e}"),
        }
    }

    let telemetry_id = diagnostic.as_ref().map(|d| d.telemetry_id.clone());
    let diagnostic_id = diagnostic.as_ref().map(|d| d.diagnostic_id.clone());
    let report_command = diagnostic_id
        .as_ref()
        .map(|id| format!("ct apply-patch report {id}"))
        .unwrap_or_else(|| "ct apply-patch report".to_string());
    let next_action = next_action(&patch_id, &kind, &anchors);

    FailureArtifacts {
        repair_block: RepairBlock {
            patch_id,
            telemetry_id,
            diagnostic_id,
            failure_kind: kind,
            anchors,
            report_command,
            next_action,
            draft_created,
        },
        diagnostic,
    }
}

impl RepairBlock {
    pub fn render_compact(&self) -> String {
        let telemetry = self.telemetry_id.as_deref().unwrap_or("unavailable");
        let diagnostic = self.diagnostic_id.as_deref().unwrap_or("unavailable");
        let anchors = if self.anchors.is_empty() {
            "none".to_string()
        } else {
            self.anchors.join(" | ")
        };
        format!(
            "repair: patch={} telemetry={} diagnostic={} kind={} anchors={} report=`{}` next={} draft={}",
            self.patch_id,
            telemetry,
            diagnostic,
            self.failure_kind,
            anchors,
            self.report_command,
            self.next_action,
            if self.draft_created {
                "linked"
            } else {
                "unavailable"
            }
        )
    }
}

fn record_failure(
    tel: &Telemetry,
    failure: &ApplyFailure,
    duration_us: u64,
    patch_sha: &str,
    patch_body: &str,
    patch_id: &str,
    kind: &str,
    anchors: &[String],
) -> Result<FailureDiagnostic, super::telemetry::TelemetryError> {
    tel.record_patch_body(patch_sha, patch_body)?;
    let files = build_file_entries_from_attempts(&failure.attempts, &failure.fingerprints);
    let file_names = files
        .iter()
        .map(|file| file.path.clone())
        .collect::<Vec<_>>();
    let record = CallRecord {
        outcome: kind.to_string(),
        error_kind: Some(kind.to_string()),
        files,
        duration_us,
        patch_sha: patch_sha.to_string(),
        fingerprints_json: fingerprints_to_json(&failure.fingerprints),
    };
    let call_id = tel.record_call(&record)?;
    tel.record_anchor_attempts(call_id, &failure.attempts)?;
    let diagnostic = tel.record_failure_diagnostic(&FailureDiagnosticInput {
        call_id,
        patch_id: patch_id.to_string(),
        patch_sha: patch_sha.to_string(),
        failure_kind: kind.to_string(),
        message: failure.error.to_string(),
        anchors: anchors.to_vec(),
        files: file_names,
        candidates: candidates_json(&failure.error),
    })?;
    for (path, fp) in &failure.fingerprints {
        tel.upsert_fingerprint(path, fp)?;
    }
    Ok(diagnostic)
}

fn create_or_link_draft(
    cwd: &Path,
    patch_id: &str,
    kind: &str,
    error: &ApplyPatchError,
    patch_body: &str,
) -> bool {
    let root = cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf());
    let chunks = draft::chunk_plan(patch_body)
        .unwrap_or_default()
        .into_iter()
        .map(|mut chunk| {
            chunk.status = "blocked".to_string();
            chunk.error_kind = Some(kind.to_string());
            chunk.error_message = Some(error.to_string());
            crate::lens::PatchDraftChunk {
                chunk_index: chunk.chunk_index,
                file_path: chunk.file_path,
                change_type: chunk.change_type,
                status: chunk.status,
                old_start: chunk.old_start,
                old_end: chunk.old_end,
                new_start: chunk.new_start,
                new_end: chunk.new_end,
                error_kind: chunk.error_kind,
                error_message: chunk.error_message,
            }
        })
        .collect::<Vec<_>>();
    let candidates = draft_candidates(error);
    let Ok(mut store) = crate::lens::LensStore::open_for_project(&root) else {
        return false;
    };
    store
        .create_patch_draft(crate::lens::store::NewPatchDraft {
            id: patch_id,
            cwd: &root.to_string_lossy(),
            session_id: None,
            status: "blocked",
            patch_sha: patch_id,
            body: patch_body,
            chunks: &chunks,
            candidates: &candidates,
        })
        .is_ok()
}

fn draft_candidates(error: &ApplyPatchError) -> Vec<crate::lens::PatchCandidate> {
    let ApplyPatchError::AmbiguousContext {
        chunk,
        candidates,
        disambiguation_hints,
        ..
    } = error
    else {
        return Vec::new();
    };
    candidates
        .iter()
        .enumerate()
        .map(|(idx, line)| {
            let anchor = disambiguation_hints
                .get(idx)
                .and_then(|hint| hint.split("  ").next())
                .map(str::to_string);
            let anchors = anchor.iter().cloned().collect::<Vec<_>>();
            crate::lens::PatchCandidate {
                chunk_index: *chunk as i64,
                line: *line as i64,
                suggested_anchor: anchor,
                enclosing_symbol: None,
                enclosing_kind: None,
                symbol_start: None,
                symbol_end: None,
                candidate_kind: "telemetry_disambiguation".to_string(),
                symbol: None,
                anchors,
                confidence: "medium".to_string(),
                reason: "apply-patch ambiguous context candidate".to_string(),
            }
        })
        .collect()
}

pub fn anchors_for_failure(error: &ApplyPatchError, attempts: &[AnchorAttempt]) -> Vec<String> {
    let mut anchors = Vec::new();
    match error {
        ApplyPatchError::ContextNotFound {
            change_contexts, ..
        }
        | ApplyPatchError::AmbiguousContext {
            change_contexts, ..
        } => {
            for anchor in change_contexts {
                push_unique(&mut anchors, format!("@@ {anchor}"));
            }
        }
        ApplyPatchError::AnchorShadowsFirstContext { anchor, .. } => {
            push_unique(&mut anchors, format!("@@ {anchor}"));
        }
        _ => {}
    }
    if let ApplyPatchError::AmbiguousContext {
        disambiguation_hints,
        ..
    } = error
    {
        for hint in disambiguation_hints.iter().take(4) {
            push_unique(&mut anchors, hint.clone());
        }
    }
    for attempt in attempts.iter().filter(|attempt| !attempt.success) {
        let anchor = attempt
            .anchor_text
            .as_ref()
            .map(|anchor| format!("@@ {anchor}"))
            .unwrap_or_else(|| "bare @@".to_string());
        push_unique(&mut anchors, anchor);
    }
    anchors.truncate(6);
    anchors
}

fn next_action(patch_id: &str, kind: &str, anchors: &[String]) -> String {
    if kind == "ambiguous_context" && !anchors.is_empty() {
        format!(
            "retry using one suggested `@@ symbol-or-line` anchor plus 2-3 unchanged context lines; if needed inspect `ct apply-patch draft show {patch_id}`"
        )
    } else if kind == "context_not_found" {
        "regenerate the failing hunk from the numbered file-state snippet above; prefer `@@ symbol-or-line` anchors and keep 2-3 unchanged context lines".to_string()
    } else {
        format!("inspect `ct apply-patch draft show {patch_id}` and regenerate the failing hunk")
    }
}

fn push_unique(values: &mut Vec<String>, value: String) {
    if !value.trim().is_empty() && !values.contains(&value) {
        values.push(value);
    }
}

fn build_file_entries_from_attempts(
    attempts: &[AnchorAttempt],
    fingerprints: &[(String, Fingerprint)],
) -> Vec<FileCallEntry> {
    let mut seen: Vec<String> = Vec::new();
    for a in attempts {
        if !seen.iter().any(|p| p == &a.file_path) {
            seen.push(a.file_path.clone());
        }
    }
    for (p, _) in fingerprints {
        if !seen.iter().any(|s| s == p) {
            seen.push(p.clone());
        }
    }
    seen.into_iter()
        .map(|path| {
            let chunk_count = attempts.iter().filter(|a| a.file_path == path).count();
            let file_sha1 = fingerprints
                .iter()
                .find(|(p, _)| p == &path)
                .map(|(_, fp)| fp.sha1.clone());
            FileCallEntry {
                path,
                chunk_count,
                fuzzy_tier_used: None,
                file_sha1,
            }
        })
        .collect()
}

fn fingerprints_to_json(fps: &[(String, Fingerprint)]) -> String {
    let map: serde_json::Map<String, serde_json::Value> = fps
        .iter()
        .map(|(p, fp)| {
            (
                p.clone(),
                serde_json::json!({ "mtime_ns": fp.mtime_ns, "sha1": fp.sha1 }),
            )
        })
        .collect();
    serde_json::to_string(&serde_json::Value::Object(map)).unwrap_or_else(|_| "{}".to_string())
}

fn candidates_json(error: &ApplyPatchError) -> serde_json::Value {
    match error {
        ApplyPatchError::AmbiguousContext {
            path,
            chunk,
            candidates,
            disambiguation_hints,
            ..
        } => serde_json::json!({
            "path": path,
            "chunk": chunk,
            "candidate_lines": candidates,
            "disambiguation_hints": disambiguation_hints,
        }),
        _ => serde_json::Value::Null,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repair_block_is_compact_and_actionable() {
        let block = RepairBlock {
            patch_id: "patch123".to_string(),
            telemetry_id: Some("apt-call-7".to_string()),
            diagnostic_id: Some("apd-7".to_string()),
            failure_kind: "ambiguous_context".to_string(),
            anchors: vec!["@@ fn main".to_string()],
            report_command: "ct apply-patch report apd-7".to_string(),
            next_action: "inspect draft".to_string(),
            draft_created: true,
        };
        let rendered = block.render_compact();
        assert!(rendered.contains("patch=patch123"));
        assert!(rendered.contains("telemetry=apt-call-7"));
        assert!(rendered.contains("diagnostic=apd-7"));
        assert!(rendered.contains("kind=ambiguous_context"));
        assert!(rendered.contains("@@ fn main"));
        assert!(rendered.contains("ct apply-patch report apd-7"));
    }
}
