use serde::Serialize;

use super::ApplyPatchError;
use super::parser::{Hunk, parse_patch};

#[derive(Debug, Clone, Serialize)]
pub struct DraftChunkPlan {
    pub chunk_index: i64,
    pub file_path: String,
    pub change_type: String,
    pub old_start: Option<i64>,
    pub old_end: Option<i64>,
    pub new_start: Option<i64>,
    pub new_end: Option<i64>,
    pub status: String,
    pub error_kind: Option<String>,
    pub error_message: Option<String>,
}

pub fn chunk_plan(patch: &str) -> Result<Vec<DraftChunkPlan>, super::parser::ParseError> {
    let hunks = parse_patch(patch)?;
    let mut chunks = Vec::new();
    let mut chunk_index = 0_i64;
    for hunk in hunks {
        match hunk {
            Hunk::AddFile { path, contents } => {
                let line_count = contents.lines().count() as i64;
                chunks.push(DraftChunkPlan {
                    chunk_index,
                    file_path: path.display().to_string(),
                    change_type: "add".to_string(),
                    old_start: None,
                    old_end: None,
                    new_start: Some(1),
                    new_end: Some(line_count.max(1)),
                    status: "planned".to_string(),
                    error_kind: None,
                    error_message: None,
                });
                chunk_index += 1;
            }
            Hunk::DeleteFile { path } => {
                chunks.push(DraftChunkPlan {
                    chunk_index,
                    file_path: path.display().to_string(),
                    change_type: "delete".to_string(),
                    old_start: None,
                    old_end: None,
                    new_start: None,
                    new_end: None,
                    status: "planned".to_string(),
                    error_kind: None,
                    error_message: None,
                });
                chunk_index += 1;
            }
            Hunk::UpdateFile {
                path,
                move_path,
                chunks: update_chunks,
            } => {
                if update_chunks.is_empty() {
                    chunks.push(DraftChunkPlan {
                        chunk_index,
                        file_path: path.display().to_string(),
                        change_type: if move_path.is_some() {
                            "move"
                        } else {
                            "update"
                        }
                        .to_string(),
                        old_start: None,
                        old_end: None,
                        new_start: None,
                        new_end: None,
                        status: "planned".to_string(),
                        error_kind: None,
                        error_message: None,
                    });
                    chunk_index += 1;
                }
                for chunk in update_chunks {
                    let old_len = chunk.old_lines.len() as i64;
                    let new_len = chunk.new_lines.len() as i64;
                    chunks.push(DraftChunkPlan {
                        chunk_index,
                        file_path: path.display().to_string(),
                        change_type: "update".to_string(),
                        old_start: None,
                        old_end: old_len.checked_sub(1),
                        new_start: None,
                        new_end: new_len.checked_sub(1),
                        status: "planned".to_string(),
                        error_kind: None,
                        error_message: None,
                    });
                    chunk_index += 1;
                }
            }
            Hunk::ReplaceAll {
                path,
                expected_replacements,
                old_lines,
                ..
            } => {
                let old_len = old_lines.len() as i64;
                for _ in 0..expected_replacements.max(1) {
                    chunks.push(DraftChunkPlan {
                        chunk_index,
                        file_path: path.display().to_string(),
                        change_type: "replace_all".to_string(),
                        old_start: None,
                        old_end: old_len.checked_sub(1),
                        new_start: None,
                        new_end: None,
                        status: "planned".to_string(),
                        error_kind: None,
                        error_message: None,
                    });
                    chunk_index += 1;
                }
            }
            Hunk::UpdateScope {
                path,
                chunks: update_chunks,
            } => {
                for chunk in update_chunks {
                    let old_len = chunk.old_lines.len() as i64;
                    let new_len = chunk.new_lines.len() as i64;
                    chunks.push(DraftChunkPlan {
                        chunk_index,
                        file_path: path.display().to_string(),
                        change_type: "update_scope".to_string(),
                        old_start: None,
                        old_end: old_len.checked_sub(1),
                        new_start: None,
                        new_end: new_len.checked_sub(1),
                        status: "planned".to_string(),
                        error_kind: None,
                        error_message: None,
                    });
                    chunk_index += 1;
                }
            }
        }
    }
    Ok(chunks)
}

pub fn error_kind(error: &ApplyPatchError) -> &'static str {
    match error {
        ApplyPatchError::Parse(e) => e.subkind_str(),
        ApplyPatchError::ContextNotFound { .. } => "context_not_found",
        ApplyPatchError::AmbiguousContext { .. } => "ambiguous_context",
        ApplyPatchError::LineRangeMismatch { .. } => "line_range_mismatch",
        ApplyPatchError::ReplacementCountMismatch { .. } => "replacement_count_mismatch",
        ApplyPatchError::OverlappingReplacements { .. } => "overlapping_replacements",
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
