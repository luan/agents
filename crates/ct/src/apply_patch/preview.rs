use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::path::PathBuf;

use serde::Serialize;

use super::apply::display_rel;
use super::apply::read_file;
use super::apply::resolve_path;
use super::parser::Hunk;
use super::parser::UpdateFileChunk;
use super::parser::UpdateScopeChunk;
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
    let scope_updates = collect_scope_preview_updates(&hunks, &cwd_canon)?;
    let mut processed_scope_updates = HashSet::<PathBuf>::new();

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
                if scope_updates.contains_key(&abs) || !seen_updates.insert(abs.clone()) {
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
            Hunk::UpdateScope { path, chunks } => {
                let abs = resolve_path(&cwd_canon, &path).ok()?;
                if seen_updates.contains(&abs) {
                    return None;
                }
                if !processed_scope_updates.insert(abs.clone()) {
                    continue;
                }
                let rel = display_rel(&path);
                let (original, _) = read_file(&abs, &rel).ok()?;
                let chunks = scope_updates
                    .get(&abs)
                    .map(|(_, chunks)| chunks.as_slice())
                    .unwrap_or(chunks.as_slice());
                let original_lines = lines(&original);
                let resolved =
                    resolve_partial_scope_chunks(&original_lines, &original, &rel, chunks)?;
                let new_lines = apply_partial_replacements(original_lines.clone(), resolved);
                let new_content = new_lines.join("\n");
                let (diff, additions, deletions) =
                    super::diff::unified_diff(&rel, &original, &new_content);
                let scopes = super::scope::source_scopes(&rel, &new_content);
                changes.push(PreviewChange {
                    path: rel,
                    kind: PreviewChangeType::Update,
                    additions,
                    deletions,
                    unified_diff: diff,
                    scopes,
                    move_path: None,
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

fn collect_scope_preview_updates(
    hunks: &[Hunk],
    cwd_canon: &Path,
) -> Option<HashMap<PathBuf, (PathBuf, Vec<UpdateScopeChunk>)>> {
    let mut updates: HashMap<PathBuf, (PathBuf, Vec<UpdateScopeChunk>)> = HashMap::new();
    for hunk in hunks {
        let Hunk::UpdateScope { path, chunks } = hunk else {
            continue;
        };
        let abs = resolve_path(cwd_canon, path).ok()?;
        updates
            .entry(abs)
            .or_insert_with(|| (path.clone(), Vec::new()))
            .1
            .extend(chunks.iter().cloned());
    }
    Some(updates)
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
        let mut outcome = seek_sequence(original_lines, old, line_index, chunk.is_end_of_file);
        let mut repaired_old: Option<Vec<String>> = None;
        let mut repaired_new: Option<Vec<String>> = None;
        if matches!(outcome, SeekOutcome::NotFound) {
            let candidate = repair_missing_marker_space(old);
            if candidate != old {
                outcome =
                    seek_sequence(original_lines, &candidate, line_index, chunk.is_end_of_file);
                if !matches!(outcome, SeekOutcome::NotFound) {
                    repaired_old = Some(candidate);
                    repaired_new = Some(repair_missing_marker_space(new));
                }
            }
        }
        let old = repaired_old.as_deref().unwrap_or(old);
        let new = repaired_new.as_deref().unwrap_or(new);
        match outcome {
            SeekOutcome::Unique { idx, .. } => {
                replacements.push(PartialReplacement {
                    start: idx,
                    old: old.to_vec(),
                    new: preserve_matched_context(original_lines, idx, old, new),
                });
                line_index = idx + old.len();
            }
            SeekOutcome::NotFound | SeekOutcome::Ambiguous { .. } => return None,
        }
    }

    Some(replacements)
}

fn resolve_partial_scope_chunks(
    original_lines: &[String],
    original: &str,
    file_rel: &str,
    chunks: &[UpdateScopeChunk],
) -> Option<Vec<PartialReplacement>> {
    let mut replacements = Vec::new();
    let mut cursors: HashMap<(usize, usize, String, String), usize> = HashMap::new();

    for chunk in chunks {
        let (_, _, scope) =
            super::scope::anchor_for_locator(file_rel, original, &chunk.locator).ok()?;
        let start = scope.start_line.saturating_sub(1).min(original_lines.len());
        let end = scope.end_line.min(original_lines.len()).max(start);
        let key = (
            start,
            end,
            scope.kind.clone(),
            format!("{}:{}", scope.name, chunk.locator),
        );
        let cursor = cursors.entry(key).or_insert(start);
        let scope_lines = &original_lines[start..end];
        let relative_cursor = cursor.saturating_sub(start).min(scope_lines.len());

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
        if old.is_empty() {
            replacements.push(PartialReplacement {
                start: *cursor,
                old: Vec::new(),
                new: new.to_vec(),
            });
            continue;
        }
        let mut outcome = seek_sequence(scope_lines, old, relative_cursor, chunk.is_end_of_file);
        let mut repaired_old: Option<Vec<String>> = None;
        let mut repaired_new: Option<Vec<String>> = None;
        if matches!(outcome, SeekOutcome::NotFound) {
            let candidate = repair_missing_marker_space(old);
            if candidate != old {
                outcome = seek_sequence(
                    scope_lines,
                    &candidate,
                    relative_cursor,
                    chunk.is_end_of_file,
                );
                if !matches!(outcome, SeekOutcome::NotFound) {
                    repaired_old = Some(candidate);
                    repaired_new = Some(repair_missing_marker_space(new));
                }
            }
        }
        let old = repaired_old.as_deref().unwrap_or(old);
        let new = repaired_new.as_deref().unwrap_or(new);
        match outcome {
            SeekOutcome::Unique { idx, .. } => {
                let abs_idx = start + idx;
                replacements.push(PartialReplacement {
                    start: abs_idx,
                    old: old.to_vec(),
                    new: preserve_matched_context(original_lines, abs_idx, old, new),
                });
                *cursor = abs_idx + old.len();
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

fn preserve_matched_context(
    original_lines: &[String],
    start: usize,
    old: &[String],
    new: &[String],
) -> Vec<String> {
    let mut out = new.to_vec();
    let mut old_index = 0;
    for line in &mut out {
        if old_index >= old.len() {
            break;
        }
        if let Some(relative) = old[old_index..]
            .iter()
            .position(|old_line| old_line == line)
        {
            old_index += relative;
            if let Some(original) = original_lines.get(start + old_index) {
                *line = original.clone();
            }
            old_index += 1;
        }
    }
    out
}

fn repair_missing_marker_space(lines: &[String]) -> Vec<String> {
    lines
        .iter()
        .map(|line| {
            if line.starts_with(' ') {
                format!(" {line}")
            } else {
                line.clone()
            }
        })
        .collect()
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

    #[test]
    fn partial_preview_batches_repeated_update_scope_sections() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path().join("sample.js"),
            "function alpha() {\n  return 1;\n}\n\nfunction beta() {\n  return 1;\n}\n",
        )
        .unwrap();
        let patch = concat!(
            "*** Begin Patch\n",
            "*** Update Scope: sample.js\n",
            "@@ function alpha\n",
            "-  return 1;\n",
            "+  return 10;\n",
            "*** Update Scope: sample.js\n",
            "@@ function beta\n",
            "-  return 1;\n",
            "+  return 20;\n",
        );
        let response = preview(patch, temp.path(), true);
        assert_eq!(response.status, "valid");
        assert!(response.diff.contains("+  return 10;"));
        assert!(response.diff.contains("+  return 20;"));
    }
}
