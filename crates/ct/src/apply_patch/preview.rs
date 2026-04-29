use std::collections::HashSet;
use std::path::Path;
use std::path::PathBuf;

use serde::Serialize;

use super::apply::display_rel;
use super::apply::read_file;
use super::apply::resolve_path;
use super::parser::Hunk;
use super::parser::UpdateFileChunk;
use super::parser::parse_patch;
use super::scope::SourceScope;
use super::seek_sequence::SeekOutcome;
use super::seek_sequence::seek_sequence;

#[derive(Debug, Serialize)]
pub struct PreviewResponse {
    pub status: &'static str,
    pub complete: bool,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub diff: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub changes: Vec<PreviewChange>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct PreviewChange {
    pub path: String,
    #[serde(rename = "type")]
    pub kind: PreviewChangeType,
    pub additions: usize,
    pub deletions: usize,
    pub unified_diff: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub scopes: Vec<SourceScope>,
    pub move_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PreviewChangeType {
    Add,
    Update,
    Delete,
    Move,
}

pub fn preview(patch: &str, cwd: &Path, partial: bool) -> PreviewResponse {
    let mut patch = patch.to_string();
    let complete = patch
        .replace("\r\n", "\n")
        .lines()
        .any(|line| line == "*** End Patch");
    if partial && !complete && patch.contains("*** Begin Patch") {
        if !patch.ends_with('\n') {
            patch.push('\n');
        }
        patch.push_str("*** End Patch\n");
    }

    if partial {
        if let Some(response) = preview_partial(&patch, cwd, complete) {
            return response;
        }
    }

    match super::apply::plan(&patch, cwd) {
        Ok(outcome) => {
            let scoped_changes = preview_partial(&patch, cwd, complete)
                .map(|response| response.changes)
                .unwrap_or_default();
            let diff = outcome
                .changes
                .iter()
                .map(|change| change.unified_diff.as_str())
                .collect::<Vec<_>>()
                .join("\n");
            PreviewResponse {
                status: "valid",
                complete,
                diff,
                changes: outcome
                    .changes
                    .into_iter()
                    .map(|change| {
                        let scopes = scoped_changes
                            .iter()
                            .find(|scoped| scoped.path == change.path)
                            .map(|scoped| scoped.scopes.clone())
                            .unwrap_or_default();
                        PreviewChange {
                            path: change.path,
                            kind: match change.kind {
                                super::apply::ChangeType::Add => PreviewChangeType::Add,
                                super::apply::ChangeType::Update => PreviewChangeType::Update,
                                super::apply::ChangeType::Delete => PreviewChangeType::Delete,
                                super::apply::ChangeType::Move => PreviewChangeType::Move,
                            },
                            additions: change.additions,
                            deletions: change.deletions,
                            unified_diff: change.unified_diff,
                            scopes,
                            move_path: change.move_path,
                        }
                    })
                    .collect(),
                error: None,
            }
        }
        Err(failure) => PreviewResponse {
            status: "invalid",
            complete,
            diff: String::new(),
            changes: Vec::new(),
            error: Some(failure.error.to_string()),
        },
    }
}

fn preview_partial(patch: &str, cwd: &Path, complete: bool) -> Option<PreviewResponse> {
    let hunks = parse_patch(patch).ok()?;
    let cwd_canon = cwd.canonicalize().ok()?;
    let mut changes = Vec::new();
    let mut seen_updates = HashSet::<PathBuf>::new();

    for hunk in hunks {
        match hunk {
            Hunk::AddFile { path, contents } => {
                let rel = display_rel(&path);
                let (diff, additions, deletions) = super::diff::unified_diff(&rel, "", &contents);
                let scopes = super::scope::source_scopes(&rel, &contents);
                changes.push(PreviewChange {
                    path: rel,
                    kind: PreviewChangeType::Add,
                    additions,
                    deletions,
                    unified_diff: diff,
                    scopes,
                    move_path: None,
                });
            }
            Hunk::DeleteFile { path } => {
                let abs = resolve_path(&cwd_canon, &path).ok()?;
                let rel = display_rel(&path);
                let (original, _) = read_file(&abs, &rel).ok()?;
                let (diff, additions, deletions) = super::diff::unified_diff(&rel, &original, "");
                let scopes = super::scope::source_scopes(&rel, &original);
                changes.push(PreviewChange {
                    path: rel,
                    kind: PreviewChangeType::Delete,
                    additions,
                    deletions,
                    unified_diff: diff,
                    scopes,
                    move_path: None,
                });
            }
            Hunk::UpdateFile {
                path,
                move_path,
                chunks,
            } => {
                let abs = resolve_path(&cwd_canon, &path).ok()?;
                if !seen_updates.insert(abs.clone()) {
                    return None;
                }
                let rel = display_rel(&path);
                let (original, _) = read_file(&abs, &rel).ok()?;
                let original_lines = lines(&original);
                let resolved = resolve_partial_chunks(&original_lines, &chunks)?;
                let new_lines = apply_partial_replacements(original_lines.clone(), resolved);
                let new_content = new_lines.join("\n");
                let (diff, additions, deletions) =
                    super::diff::unified_diff(&rel, &original, &new_content);
                let scopes = super::scope::source_scopes(&rel, &new_content);
                changes.push(PreviewChange {
                    path: rel,
                    kind: if move_path.is_some() {
                        PreviewChangeType::Move
                    } else {
                        PreviewChangeType::Update
                    },
                    additions,
                    deletions,
                    unified_diff: diff,
                    scopes,
                    move_path: move_path.as_ref().map(|path| display_rel(path)),
                });
            }
        }
    }

    if changes.is_empty() {
        return None;
    }
    let diff = changes
        .iter()
        .map(|change| change.unified_diff.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    Some(PreviewResponse {
        status: "valid",
        complete,
        diff,
        changes,
        error: None,
    })
}

#[derive(Clone)]
struct PartialReplacement {
    start: usize,
    old: Vec<String>,
    new: Vec<String>,
}

fn resolve_partial_chunks(
    original_lines: &[String],
    chunks: &[UpdateFileChunk],
) -> Option<Vec<PartialReplacement>> {
    let mut replacements = Vec::new();
    let mut line_index = 0usize;

    for chunk in chunks {
        for ctx_line in &chunk.change_contexts {
            match seek_sequence(
                original_lines,
                std::slice::from_ref(ctx_line),
                line_index,
                false,
            ) {
                SeekOutcome::Unique { idx, .. } => line_index = idx + 1,
                SeekOutcome::NotFound | SeekOutcome::Ambiguous { .. } => return None,
            }
        }

        let old = if chunk.old_lines.last().is_some_and(String::is_empty) {
            &chunk.old_lines[..chunk.old_lines.len() - 1]
        } else {
            &chunk.old_lines
        };
        let new = if chunk.new_lines.last().is_some_and(String::is_empty) {
            &chunk.new_lines[..chunk.new_lines.len() - 1]
        } else {
            &chunk.new_lines
        };
        let outcome = seek_sequence(original_lines, old, line_index, chunk.is_end_of_file);
        match outcome {
            SeekOutcome::Unique { idx, .. } => {
                replacements.push(PartialReplacement {
                    start: idx,
                    old: old.to_vec(),
                    new: new.to_vec(),
                });
                line_index = idx + old.len();
            }
            SeekOutcome::NotFound | SeekOutcome::Ambiguous { .. } => return None,
        }
    }

    Some(replacements)
}

fn apply_partial_replacements(
    mut lines: Vec<String>,
    mut replacements: Vec<PartialReplacement>,
) -> Vec<String> {
    replacements.sort_by_key(|replacement| replacement.start);
    for replacement in replacements.into_iter().rev() {
        lines.splice(
            replacement.start..replacement.start + replacement.old.len(),
            replacement.new,
        );
    }
    lines
}

fn lines(text: &str) -> Vec<String> {
    text.replace("\r\n", "\n")
        .split('\n')
        .map(ToString::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn partial_preview_resolves_line_numbers_before_end_marker() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path().join("sample.js"),
            "function sample() {\n  const one = 1;\n  const two = 2;\n  return one + two;\n}\n",
        )
        .unwrap();
        let patch = "*** Begin Patch\n*** Update File: sample.js\n@@\n   const one = 1;\n-  const two = 2;\n+  const two = 22;\n   return one + two;\n";
        let response = preview(patch, temp.path(), true);
        assert_eq!(response.status, "valid");
        assert!(!response.complete);
        assert!(response.diff.contains("-  const two = 2;"));
        assert!(response.diff.contains("+  const two = 22;"));
        assert!(
            response.changes[0]
                .scopes
                .iter()
                .any(|scope| scope.name == "sample")
        );
    }
}
