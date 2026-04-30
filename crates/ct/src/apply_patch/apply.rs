// Derives `derive_new_contents` from openai/codex apply-patch/src/lib.rs
// https://github.com/openai/codex/tree/fe7c959e90d46abb8311e4a0b369e6cb32bf337e
// Licensed under Apache License 2.0. See NOTICE at workspace root.

use std::collections::{HashMap, HashSet};
use std::fs::OpenOptions;
use std::path::Path;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use super::diff::unified_diff;
use super::parser::Hunk;
use super::parser::UpdateFileChunk;
use super::parser::UpdateScopeChunk;
use super::parser::parse_patch;
use super::scope::ScopeResolveError;
use super::seek_sequence::MatchQuality;
use super::seek_sequence::SeekOutcome;
use super::seek_sequence::seek_sequence;
use super::telemetry::{AnchorAttempt, Fingerprint, sha1_hex};

#[derive(Debug, serde::Serialize)]
pub struct FileChange {
    pub path: String,
    #[serde(rename = "type")]
    pub kind: ChangeType,
    #[serde(skip)]
    pub old_hash: Option<String>,
    pub additions: usize,
    pub deletions: usize,
    pub unified_diff: String,
    pub move_path: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub line_changes: Vec<LineChange>,
    /// Per-hunk fuzzy-match report. Empty when every chunk matched exactly.
    /// Entries name only the chunks that needed fuzzy matching (trim /
    /// normalise); callers may echo the diff when the list is non-empty.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub fuzzy_hunks: Vec<HunkFuzzy>,
    /// Post-apply snapshot around each hunk. A small numbered window of the
    /// file as it will exist after commit — lets callers plan subsequent
    /// edits without re-reading the file. Empty for Add/Delete.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub post_apply_regions: Vec<HunkRegion>,
    #[serde(skip)]
    pub new_content: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct HunkFuzzy {
    /// 0-based index of the chunk within the file's Update section.
    pub chunk: usize,
    pub tier: MatchQuality,
}

/// Numbered window of the post-apply file state around one hunk. `start_line`
/// is 1-based so the caller can cite file positions directly.
#[derive(Debug, Clone, serde::Serialize)]
pub struct HunkRegion {
    /// 0-based index of the chunk within the file's Update section.
    pub chunk: usize,
    pub start_line: usize,
    pub lines: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct LineChange {
    /// 0-based index of the chunk within the file's Update section.
    pub chunk: usize,
    /// 1-based first old line touched by this changed run. For insertions,
    /// this is the old line before which the new run was inserted; EOF
    /// insertions use old line count + 1.
    pub old_start: Option<usize>,
    /// 1-based last old line removed/replaced by this run. Empty for pure
    /// insertions and add-file changes.
    pub old_end: Option<usize>,
    /// 1-based first new line authored by this run. Empty for pure deletions.
    pub new_start: Option<usize>,
    /// 1-based last new line authored by this run. Empty for pure deletions.
    pub new_end: Option<usize>,
    pub old_len: usize,
    pub new_len: usize,
}

type DerivedContents = (String, Vec<HunkFuzzy>, Vec<HunkRegion>, Vec<LineChange>);

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeType {
    Add,
    Update,
    Delete,
    Move,
}

#[derive(Debug, thiserror::Error)]
pub enum ApplyPatchError {
    #[error("parse error: {0}")]
    Parse(#[from] super::parser::ParseError),
    #[error(
        "context not found in {path} at chunk #{chunk}{}{}{}",
        format_anchor_stack(.change_contexts),
        .first_old_line.as_deref().map(|l| format!(": first expected line was {l:?}")).unwrap_or_default(),
        .near_miss.as_deref().unwrap_or("")
    )]
    ContextNotFound {
        path: String,
        chunk: usize,
        change_contexts: Vec<String>,
        first_old_line: Option<String>,
        near_miss: Option<String>,
    },
    #[error(
        "ambiguous context in {path} at chunk #{chunk}{} — matched {} location(s) at lines {candidates:?}; widen the context or use a more specific @@ anchor{}",
        format_anchor_stack(.change_contexts),
        .candidates.len(),
        format_disambiguation(.disambiguation_hints),
    )]
    AmbiguousContext {
        path: String,
        chunk: usize,
        change_contexts: Vec<String>,
        candidates: Vec<usize>,
        /// Pre-computed `@@ <anchor> → line N` suggestions, one per
        /// candidate where a unique upstream anchor was found. Empty when
        /// no disambiguator was synthesizable (file too short, or every
        /// upstream line is also ambiguous).
        disambiguation_hints: Vec<String>,
    },
    #[error("delete target is a directory: {0}")]
    DeleteIsDirectory(String),
    #[error("target is a directory: {0}")]
    TargetIsDirectory(String),
    #[error("target is read-only: {0}")]
    ReadOnlyTarget(String),
    #[error("add target already exists: {0}")]
    AddTargetExists(String),
    #[error(
        "multiple updates target the same path: {0} (combine into one Update with multiple hunks)"
    )]
    DuplicateUpdate(String),
    #[error("move target already exists: {0}")]
    MoveTargetExists(String),
    #[error(
        "line range mismatch in {path} at chunk #{chunk}: expected lines {start}-{end} to match the hunk body{}",
        .near_miss.as_deref().unwrap_or("")
    )]
    LineRangeMismatch {
        path: String,
        chunk: usize,
        start: usize,
        end: usize,
        near_miss: Option<String>,
    },
    #[error(
        "replace-all count mismatch in {path}: expected {expected} replacement(s), found {actual}"
    )]
    ReplacementCountMismatch {
        path: String,
        expected: usize,
        actual: usize,
    },
    #[error(
        "in {path} chunk #{chunk}: anchor `@@ {anchor}` also appears as the first context line. The anchor is consumed and the pattern search starts on the line *after* it — drop either the anchor or that first context line."
    )]
    AnchorShadowsFirstContext {
        path: String,
        chunk: usize,
        anchor: String,
    },
    #[error("io error ({path}): {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("{error}; rollback failed: {rollback}")]
    RollbackFailed {
        error: Box<ApplyPatchError>,
        rollback: String,
    },
}

/// Render a stacked-anchor list for inclusion in error messages. One anchor
/// renders as `(@@ foo)`; multiple as `(@@ foo / @@ bar)`. Empty stack →
/// empty string.
fn format_anchor_stack(contexts: &[String]) -> String {
    if contexts.is_empty() {
        return String::new();
    }
    let parts: Vec<String> = contexts.iter().map(|c| format!("@@ {c}")).collect();
    format!(" ({})", parts.join(" / "))
}

/// Render the AmbiguousContext disambiguation suggestions block. Each hint is
/// already a self-contained `@@ <line>  →  line N` string.
fn format_disambiguation(hints: &[String]) -> String {
    if hints.is_empty() {
        return String::new();
    }
    let mut out = String::from("\nsuggested anchors:");
    for h in hints {
        out.push_str("\n  ");
        out.push_str(h);
    }
    out
}

enum ChunkFailure {
    NotFound {
        chunk_index: usize,
        change_contexts: Vec<String>,
        first_old_line: Option<String>,
        near_miss: Option<String>,
    },
    Ambiguous {
        chunk_index: usize,
        change_contexts: Vec<String>,
        candidates: Vec<usize>,
        disambiguation_hints: Vec<String>,
    },
    LineRangeMismatch {
        chunk_index: usize,
        start: usize,
        end: usize,
        near_miss: Option<String>,
    },
    AnchorShadowsFirstContext {
        chunk_index: usize,
        anchor: String,
    },
}

#[derive(Debug)]
pub struct ApplyOutcome {
    pub changes: Vec<FileChange>,
    pub attempts: Vec<AnchorAttempt>,
    pub fingerprints: Vec<(String, Fingerprint)>,
}

#[derive(Debug)]
pub struct ApplyFailure {
    pub error: ApplyPatchError,
    pub attempts: Vec<AnchorAttempt>,
    pub fingerprints: Vec<(String, Fingerprint)>,
}

impl From<ApplyPatchError> for Box<ApplyFailure> {
    fn from(error: ApplyPatchError) -> Self {
        Box::new(ApplyFailure {
            error,
            attempts: Vec::new(),
            fingerprints: Vec::new(),
        })
    }
}

pub fn apply(patch: &str, cwd: &Path, dry_run: bool) -> Result<ApplyOutcome, Box<ApplyFailure>> {
    let outcome = plan(patch, cwd)?;
    if !dry_run {
        commit(cwd, &outcome.changes).map_err(|error| {
            Box::new(ApplyFailure {
                error,
                attempts: outcome.attempts.clone(),
                fingerprints: outcome.fingerprints.clone(),
            })
        })?;
    }
    Ok(outcome)
}

pub fn plan(patch: &str, cwd: &Path) -> Result<ApplyOutcome, Box<ApplyFailure>> {
    let hunks =
        parse_patch(patch).map_err(|e| Box::<ApplyFailure>::from(ApplyPatchError::from(e)))?;
    let cwd_canon = cwd.canonicalize().map_err(|source| {
        Box::<ApplyFailure>::from(ApplyPatchError::Io {
            path: cwd.display().to_string(),
            source,
        })
    })?;
    let scope_updates = collect_scope_update_chunks(&hunks, &cwd_canon)?;

    // Detect duplicate concrete updates. Multiple `*** Update Scope:` sections
    // for one path are deliberately batched below, but mixing those with a
    // whole-file Update would otherwise produce two independent write plans.
    // Independent plans would both read the original and the second write would
    // silently overwrite the first — reject up front and ask the caller to
    // combine hunks.
    let mut seen_updates: HashSet<PathBuf> = HashSet::new();
    for hunk in &hunks {
        if let Hunk::UpdateFile { path, .. } | Hunk::ReplaceAll { path, .. } = hunk {
            let abs = resolve_path(&cwd_canon, path)?;
            if scope_updates.contains_key(&abs) || !seen_updates.insert(abs) {
                return Err(Box::<ApplyFailure>::from(ApplyPatchError::DuplicateUpdate(
                    display_rel(path),
                )));
            }
        }
    }

    // Paths scheduled for Delete in this envelope. Add and Move-to may target
    // these even if they currently exist on disk — the envelope expresses an
    // atomic replace.
    let mut pending_deletes: HashSet<PathBuf> = HashSet::new();
    let mut changes = Vec::with_capacity(hunks.len());
    let mut attempts: Vec<AnchorAttempt> = Vec::new();
    let mut fingerprints: Vec<(String, Fingerprint)> = Vec::new();
    let mut processed_scope_updates: HashSet<PathBuf> = HashSet::new();

    let fail = |error: ApplyPatchError,
                attempts: &[AnchorAttempt],
                fingerprints: &[(String, Fingerprint)]|
     -> Box<ApplyFailure> {
        Box::new(ApplyFailure {
            error,
            attempts: attempts.to_vec(),
            fingerprints: fingerprints.to_vec(),
        })
    };

    for hunk in hunks {
        match hunk {
            Hunk::AddFile { path, contents } => {
                let abs = resolve_path(&cwd_canon, &path)
                    .map_err(|e| fail(e, &attempts, &fingerprints))?;
                let rel = display_rel(&path);
                if abs.exists() && !pending_deletes.contains(&abs) {
                    return Err(fail(
                        ApplyPatchError::AddTargetExists(rel),
                        &attempts,
                        &fingerprints,
                    ));
                }
                let (diff_text, additions, deletions) = unified_diff(&rel, "", &contents);
                let line_count = contents.lines().count().max(1);
                changes.push(FileChange {
                    path: rel,
                    kind: ChangeType::Add,
                    old_hash: None,
                    additions,
                    deletions,
                    unified_diff: diff_text,
                    move_path: None,
                    line_changes: vec![LineChange {
                        chunk: 0,
                        old_start: None,
                        old_end: None,
                        new_start: Some(1),
                        new_end: Some(line_count),
                        old_len: 0,
                        new_len: line_count,
                    }],
                    fuzzy_hunks: Vec::new(),
                    post_apply_regions: Vec::new(),
                    new_content: Some(contents),
                });
            }
            Hunk::DeleteFile { path } => {
                let abs = resolve_path(&cwd_canon, &path)
                    .map_err(|e| fail(e, &attempts, &fingerprints))?;
                let rel = display_rel(&path);
                let (original, fp) =
                    read_file(&abs, &rel).map_err(|e| fail(e, &attempts, &fingerprints))?;
                let old_hash = fp.sha1.clone();
                fingerprints.push((rel.clone(), fp));
                let old_line_count = original.lines().count().max(1);
                let (diff_text, additions, deletions) = unified_diff(&rel, &original, "");
                pending_deletes.insert(abs);
                changes.push(FileChange {
                    path: rel,
                    kind: ChangeType::Delete,
                    old_hash: Some(old_hash),
                    additions,
                    deletions,
                    unified_diff: diff_text,
                    move_path: None,
                    line_changes: vec![LineChange {
                        chunk: 0,
                        old_start: Some(1),
                        old_end: Some(old_line_count),
                        new_start: None,
                        new_end: None,
                        old_len: old_line_count,
                        new_len: 0,
                    }],
                    fuzzy_hunks: Vec::new(),
                    post_apply_regions: Vec::new(),
                    new_content: None,
                });
            }
            Hunk::UpdateFile {
                path,
                move_path,
                chunks,
            } => {
                let abs = resolve_path(&cwd_canon, &path)
                    .map_err(|e| fail(e, &attempts, &fingerprints))?;
                let rel = display_rel(&path);
                let (original, fp) =
                    read_file(&abs, &rel).map_err(|e| fail(e, &attempts, &fingerprints))?;
                let old_hash = fp.sha1.clone();
                fingerprints.push((rel.clone(), fp));
                let (new_content, fuzzy_hunks, post_apply_regions, line_changes) =
                    derive_new_contents(&original, &chunks, &rel, &mut attempts).map_err(
                        |err| fail(chunk_failure_to_error(err, &rel), &attempts, &fingerprints),
                    )?;

                match move_path {
                    Some(dest) => {
                        let dest_abs = resolve_path(&cwd_canon, &dest)
                            .map_err(|e| fail(e, &attempts, &fingerprints))?;
                        let dest_rel = display_rel(&dest);
                        if dest_abs != abs
                            && dest_abs.exists()
                            && !pending_deletes.contains(&dest_abs)
                        {
                            return Err(fail(
                                ApplyPatchError::MoveTargetExists(dest_rel),
                                &attempts,
                                &fingerprints,
                            ));
                        }
                        let (diff_text, additions, deletions) =
                            unified_diff(&rel, &original, &new_content);
                        changes.push(FileChange {
                            path: rel,
                            kind: ChangeType::Move,
                            old_hash: Some(old_hash),
                            additions,
                            deletions,
                            unified_diff: diff_text,
                            move_path: Some(dest_rel),
                            line_changes,
                            fuzzy_hunks,
                            post_apply_regions,
                            new_content: Some(new_content),
                        });
                    }
                    None => {
                        let (diff_text, additions, deletions) =
                            unified_diff(&rel, &original, &new_content);
                        changes.push(FileChange {
                            path: rel,
                            kind: ChangeType::Update,
                            old_hash: Some(old_hash),
                            additions,
                            deletions,
                            unified_diff: diff_text,
                            move_path: None,
                            line_changes,
                            fuzzy_hunks,
                            post_apply_regions,
                            new_content: Some(new_content),
                        });
                    }
                }
            }
            Hunk::ReplaceAll {
                path,
                expected_replacements,
                old_lines,
                new_lines,
            } => {
                let abs = resolve_path(&cwd_canon, &path)
                    .map_err(|e| fail(e, &attempts, &fingerprints))?;
                let rel = display_rel(&path);
                let (original, fp) =
                    read_file(&abs, &rel).map_err(|e| fail(e, &attempts, &fingerprints))?;
                let old_hash = fp.sha1.clone();
                fingerprints.push((rel.clone(), fp));
                let original_lines = lines_without_trailing_empty(&original);
                let replacements =
                    replace_all_replacements(&original_lines, &old_lines, &new_lines, 0);
                if replacements.len() != expected_replacements {
                    return Err(fail(
                        ApplyPatchError::ReplacementCountMismatch {
                            path: rel,
                            expected: expected_replacements,
                            actual: replacements.len(),
                        },
                        &attempts,
                        &fingerprints,
                    ));
                }
                let regions_meta = plan_post_apply_regions(&replacements);
                let line_changes = plan_line_changes(&replacements);
                let mut new_content_lines = apply_replacements(original_lines, replacements);
                if !new_content_lines.last().is_some_and(String::is_empty) {
                    new_content_lines.push(String::new());
                }
                let regions = materialize_regions(&new_content_lines, &regions_meta);
                let new_content = new_content_lines.join("\n");
                let (diff_text, additions, deletions) = unified_diff(&rel, &original, &new_content);
                changes.push(FileChange {
                    path: rel,
                    kind: ChangeType::Update,
                    old_hash: Some(old_hash),
                    additions,
                    deletions,
                    unified_diff: diff_text,
                    move_path: None,
                    line_changes,
                    fuzzy_hunks: Vec::new(),
                    post_apply_regions: regions,
                    new_content: Some(new_content),
                });
            }
            Hunk::UpdateScope { path, chunks } => {
                let abs = resolve_path(&cwd_canon, &path)
                    .map_err(|e| fail(e, &attempts, &fingerprints))?;
                if !processed_scope_updates.insert(abs.clone()) {
                    continue;
                }
                let rel = display_rel(&path);
                let (original, fp) =
                    read_file(&abs, &rel).map_err(|e| fail(e, &attempts, &fingerprints))?;
                let old_hash = fp.sha1.clone();
                fingerprints.push((rel.clone(), fp));
                let chunks = scope_updates
                    .get(&abs)
                    .map(|(_, chunks)| chunks.as_slice())
                    .unwrap_or(chunks.as_slice());
                let (new_content, fuzzy_hunks, post_apply_regions, line_changes) =
                    derive_new_contents_from_scope_chunks(&original, chunks, &rel, &mut attempts)
                        .map_err(|e| fail(e, &attempts, &fingerprints))?;
                let (diff_text, additions, deletions) = unified_diff(&rel, &original, &new_content);
                changes.push(FileChange {
                    path: rel,
                    kind: ChangeType::Update,
                    old_hash: Some(old_hash),
                    additions,
                    deletions,
                    unified_diff: diff_text,
                    move_path: None,
                    line_changes,
                    fuzzy_hunks,
                    post_apply_regions,
                    new_content: Some(new_content),
                });
            }
        }
    }

    Ok(ApplyOutcome {
        changes,
        attempts,
        fingerprints,
    })
}

fn collect_scope_update_chunks(
    hunks: &[Hunk],
    cwd_canon: &Path,
) -> Result<HashMap<PathBuf, (PathBuf, Vec<UpdateScopeChunk>)>, ApplyPatchError> {
    let mut updates: HashMap<PathBuf, (PathBuf, Vec<UpdateScopeChunk>)> = HashMap::new();
    for hunk in hunks {
        let Hunk::UpdateScope { path, chunks } = hunk else {
            continue;
        };
        let abs = resolve_path(cwd_canon, path)?;
        updates
            .entry(abs)
            .or_insert_with(|| (path.clone(), Vec::new()))
            .1
            .extend(chunks.iter().cloned());
    }
    Ok(updates)
}

pub fn commit(cwd: &Path, changes: &[FileChange]) -> Result<(), ApplyPatchError> {
    let cwd_canon = cwd.canonicalize().map_err(|source| ApplyPatchError::Io {
        path: cwd.display().to_string(),
        source,
    })?;

    preflight_commit(&cwd_canon, changes)?;
    let snapshots = collect_snapshots(&cwd_canon, changes)?;

    for change in changes {
        if let Err(error) = commit_one(&cwd_canon, change) {
            if let Err(rollback) = rollback_snapshots(&snapshots) {
                return Err(ApplyPatchError::RollbackFailed {
                    error: Box::new(error),
                    rollback,
                });
            }
            return Err(error);
        }
    }
    Ok(())
}

fn commit_one(cwd_canon: &Path, change: &FileChange) -> Result<(), ApplyPatchError> {
    let source_abs = resolve_path(cwd_canon, Path::new(&change.path))?;
    match change.kind {
        ChangeType::Add | ChangeType::Update => {
            let content = change
                .new_content
                .as_deref()
                .expect("Add/Update change missing new_content");
            write_file(&source_abs, &change.path, content)?;
        }
        ChangeType::Move => {
            let dest_rel = change
                .move_path
                .as_ref()
                .expect("Move change missing move_path");
            let dest_abs = resolve_path(cwd_canon, Path::new(dest_rel))?;
            let content = change
                .new_content
                .as_deref()
                .expect("Move change missing new_content");
            write_file(&dest_abs, dest_rel, content)?;
            if source_abs != dest_abs {
                std::fs::remove_file(&source_abs).map_err(|source| ApplyPatchError::Io {
                    path: change.path.clone(),
                    source,
                })?;
            }
        }
        ChangeType::Delete => {
            let meta = std::fs::metadata(&source_abs).map_err(|source| ApplyPatchError::Io {
                path: change.path.clone(),
                source,
            })?;
            if meta.is_dir() {
                return Err(ApplyPatchError::DeleteIsDirectory(change.path.clone()));
            }
            std::fs::remove_file(&source_abs).map_err(|source| ApplyPatchError::Io {
                path: change.path.clone(),
                source,
            })?;
        }
    }
    Ok(())
}

#[derive(Debug)]
struct FileSnapshot {
    abs: PathBuf,
    rel: String,
    content: Option<String>,
}

fn preflight_commit(cwd_canon: &Path, changes: &[FileChange]) -> Result<(), ApplyPatchError> {
    for change in changes {
        let source_abs = resolve_path(cwd_canon, Path::new(&change.path))?;
        match change.kind {
            ChangeType::Add | ChangeType::Update => {
                ensure_writable_target(&source_abs, &change.path)?;
            }
            ChangeType::Delete => ensure_deletable_target(&source_abs, &change.path)?,
            ChangeType::Move => {
                ensure_deletable_target(&source_abs, &change.path)?;
                let dest_rel = change
                    .move_path
                    .as_ref()
                    .expect("Move change missing move_path");
                let dest_abs = resolve_path(cwd_canon, Path::new(dest_rel))?;
                ensure_writable_target(&dest_abs, dest_rel)?;
            }
        }
    }
    Ok(())
}

fn collect_snapshots(
    cwd_canon: &Path,
    changes: &[FileChange],
) -> Result<Vec<FileSnapshot>, ApplyPatchError> {
    let mut seen: HashMap<PathBuf, String> = HashMap::new();

    for change in changes {
        let source_abs = resolve_path(cwd_canon, Path::new(&change.path))?;
        seen.entry(source_abs)
            .or_insert_with(|| change.path.clone());
        if let ChangeType::Move = change.kind {
            let dest_rel = change
                .move_path
                .as_ref()
                .expect("Move change missing move_path");
            let dest_abs = resolve_path(cwd_canon, Path::new(dest_rel))?;
            seen.entry(dest_abs).or_insert_with(|| dest_rel.clone());
        }
    }

    let mut snapshots = Vec::with_capacity(seen.len());
    for (abs, rel) in seen {
        let content = if abs.exists() {
            Some(
                std::fs::read_to_string(&abs).map_err(|source| ApplyPatchError::Io {
                    path: rel.clone(),
                    source,
                })?,
            )
        } else {
            None
        };
        snapshots.push(FileSnapshot { abs, rel, content });
    }
    Ok(snapshots)
}

fn rollback_snapshots(snapshots: &[FileSnapshot]) -> Result<(), String> {
    let mut errors = Vec::new();
    for snapshot in snapshots {
        let result = match &snapshot.content {
            Some(content) => {
                write_file(&snapshot.abs, &snapshot.rel, content).map_err(|e| e.to_string())
            }
            None => {
                if snapshot.abs.exists() {
                    std::fs::remove_file(&snapshot.abs).map_err(|e| e.to_string())
                } else {
                    Ok(())
                }
            }
        };
        if let Err(error) = result {
            errors.push(format!("{}: {error}", snapshot.rel));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

fn ensure_writable_target(abs: &Path, rel: &str) -> Result<(), ApplyPatchError> {
    if let Ok(meta) = std::fs::metadata(abs) {
        if meta.is_dir() {
            return Err(ApplyPatchError::TargetIsDirectory(rel.to_string()));
        }
        if meta.permissions().readonly() {
            return Err(ApplyPatchError::ReadOnlyTarget(rel.to_string()));
        }
        OpenOptions::new()
            .write(true)
            .open(abs)
            .map_err(|source| ApplyPatchError::Io {
                path: rel.to_string(),
                source,
            })?;
    }
    ensure_parent_writable(abs, rel)
}

fn ensure_deletable_target(abs: &Path, rel: &str) -> Result<(), ApplyPatchError> {
    let meta = std::fs::metadata(abs).map_err(|source| ApplyPatchError::Io {
        path: rel.to_string(),
        source,
    })?;
    if meta.is_dir() {
        return Err(ApplyPatchError::DeleteIsDirectory(rel.to_string()));
    }
    ensure_parent_writable(abs, rel)
}

fn ensure_parent_writable(abs: &Path, rel: &str) -> Result<(), ApplyPatchError> {
    let Some(mut cursor) = abs.parent().map(Path::to_path_buf) else {
        return Ok(());
    };
    while !cursor.exists() {
        if !cursor.pop() {
            return Ok(());
        }
    }
    let meta = std::fs::metadata(&cursor).map_err(|source| ApplyPatchError::Io {
        path: rel.to_string(),
        source,
    })?;
    if !meta.is_dir() {
        return Err(ApplyPatchError::TargetIsDirectory(
            cursor.display().to_string(),
        ));
    }
    if meta.permissions().readonly() {
        return Err(ApplyPatchError::ReadOnlyTarget(
            cursor.display().to_string(),
        ));
    }
    Ok(())
}

pub(crate) fn read_file(abs: &Path, rel: &str) -> Result<(String, Fingerprint), ApplyPatchError> {
    let contents = std::fs::read_to_string(abs).map_err(|source| ApplyPatchError::Io {
        path: rel.to_string(),
        source,
    })?;
    let meta = std::fs::metadata(abs).map_err(|source| ApplyPatchError::Io {
        path: rel.to_string(),
        source,
    })?;
    let mtime_ns = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as i64)
        .unwrap_or(0);
    let sha1 = sha1_hex(contents.as_bytes());
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Ok((contents, Fingerprint { mtime_ns, sha1, ts }))
}

fn write_file(abs: &Path, rel: &str, content: &str) -> Result<(), ApplyPatchError> {
    if let Some(parent) = abs.parent() {
        std::fs::create_dir_all(parent).map_err(|source| ApplyPatchError::Io {
            path: rel.to_string(),
            source,
        })?;
    }
    std::fs::write(abs, content).map_err(|source| ApplyPatchError::Io {
        path: rel.to_string(),
        source,
    })
}

pub(crate) fn display_rel(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// Resolve a patch-referenced path. Absolute paths are accepted as-is;
/// relative paths are joined with `cwd_canon`. The canonicalisation walk
/// handles not-yet-existing targets (e.g. Add) by canonicalising the longest
/// existing prefix and appending the rest verbatim.
pub(crate) fn resolve_path(cwd_canon: &Path, rel: &Path) -> Result<PathBuf, ApplyPatchError> {
    let target = if rel.is_absolute() {
        rel.to_path_buf()
    } else {
        cwd_canon.join(rel)
    };
    canonicalize_with_existing_prefix(&target)
}

/// Canonicalize the longest existing prefix of `path` and append the remaining
/// components verbatim. This lets us resolve symlinks on the parent chain
/// without requiring the leaf (a not-yet-written Add target) to exist.
fn canonicalize_with_existing_prefix(path: &Path) -> Result<PathBuf, ApplyPatchError> {
    let mut remainder: Vec<std::ffi::OsString> = Vec::new();
    let mut cursor = path.to_path_buf();

    let base = loop {
        if cursor.exists() {
            break cursor
                .canonicalize()
                .map_err(|source| ApplyPatchError::Io {
                    path: path.display().to_string(),
                    source,
                })?;
        }
        let Some(name) = cursor.file_name().map(|n| n.to_os_string()) else {
            // Ran out of ancestors without hitting an existing path. Fall back
            // to the original path — shouldn't happen in practice because cwd
            // must exist before we canonicalize it upstream.
            break path.to_path_buf();
        };
        remainder.push(name);
        if !cursor.pop() {
            break path.to_path_buf();
        }
    };

    let mut out = base;
    for name in remainder.into_iter().rev() {
        out.push(name);
    }
    Ok(out)
}

fn derive_new_contents(
    original: &str,
    chunks: &[UpdateFileChunk],
    file_rel: &str,
    attempts: &mut Vec<AnchorAttempt>,
) -> Result<DerivedContents, ChunkFailure> {
    let original_lines = lines_without_trailing_empty(original);

    let (replacements, fuzzy_hunks) =
        compute_replacements(&original_lines, chunks, file_rel, attempts)?;
    let regions_meta = plan_post_apply_regions(&replacements);
    let line_changes = plan_line_changes(&replacements);
    let mut new_lines = apply_replacements(original_lines, replacements);
    if !new_lines.last().is_some_and(String::is_empty) {
        new_lines.push(String::new());
    }
    let regions = materialize_regions(&new_lines, &regions_meta);
    Ok((new_lines.join("\n"), fuzzy_hunks, regions, line_changes))
}

fn lines_without_trailing_empty(text: &str) -> Vec<String> {
    let mut lines: Vec<String> = text.split('\n').map(String::from).collect();
    if lines.last().is_some_and(String::is_empty) {
        lines.pop();
    }
    lines
}

#[derive(Debug)]
struct Replacement {
    chunk: usize,
    start: usize,
    old: Vec<String>,
    new: Vec<String>,
}

impl Replacement {
    fn old_len(&self) -> usize {
        self.old.len()
    }
}

type Replacements = Vec<Replacement>;

/// Amount of context on each side of a hunk in the post-apply echo. Small
/// enough to keep responses cheap, large enough that the agent can see the
/// surrounding neighborhood for a follow-up edit.
const POST_APPLY_PAD: usize = 3;

/// Walk the (sorted) replacement list once to compute each hunk's post-apply
/// line range. Each replacement shifts every later replacement's position by
/// `new.len() - old_len`.
fn plan_post_apply_regions(replacements: &[Replacement]) -> Vec<(usize, usize, usize)> {
    let mut out = Vec::with_capacity(replacements.len());
    let mut delta: isize = 0;
    for r in replacements {
        let new_start = (r.start as isize + delta).max(0) as usize;
        out.push((r.chunk, new_start, r.new.len()));
        delta += r.new.len() as isize - r.old_len() as isize;
    }
    out
}

fn plan_line_changes(replacements: &[Replacement]) -> Vec<LineChange> {
    let mut out = Vec::new();
    let mut delta: isize = 0;
    for r in replacements {
        let new_start = (r.start as isize + delta).max(0) as usize;
        out.extend(line_changes_for_replacement(r, new_start));
        delta += r.new.len() as isize - r.old_len() as isize;
    }
    out
}

fn line_changes_for_replacement(r: &Replacement, replacement_new_start: usize) -> Vec<LineChange> {
    if r.old.is_empty() || r.new.is_empty() {
        return vec![line_change(
            r.chunk,
            r.start,
            r.old_len(),
            replacement_new_start,
            r.new.len(),
        )];
    }

    let equal_pairs = lcs_equal_pairs(&r.old, &r.new);
    let mut changes = Vec::new();
    let mut old_cursor = 0;
    let mut new_cursor = 0;
    for (old_idx, new_idx) in equal_pairs {
        if old_idx > old_cursor || new_idx > new_cursor {
            changes.push(line_change(
                r.chunk,
                r.start + old_cursor,
                old_idx - old_cursor,
                replacement_new_start + new_cursor,
                new_idx - new_cursor,
            ));
        }
        old_cursor = old_idx + 1;
        new_cursor = new_idx + 1;
    }
    if old_cursor < r.old.len() || new_cursor < r.new.len() {
        changes.push(line_change(
            r.chunk,
            r.start + old_cursor,
            r.old.len() - old_cursor,
            replacement_new_start + new_cursor,
            r.new.len() - new_cursor,
        ));
    }
    changes
}

fn line_change(
    chunk: usize,
    old_start_zero: usize,
    old_len: usize,
    new_start_zero: usize,
    new_len: usize,
) -> LineChange {
    LineChange {
        chunk,
        old_start: Some(old_start_zero + 1),
        old_end: (old_len > 0).then_some(old_start_zero + old_len),
        new_start: (new_len > 0).then_some(new_start_zero + 1),
        new_end: (new_len > 0).then_some(new_start_zero + new_len),
        old_len,
        new_len,
    }
}

fn lcs_equal_pairs(old: &[String], new: &[String]) -> Vec<(usize, usize)> {
    let mut dp = vec![vec![0_usize; new.len() + 1]; old.len() + 1];
    for old_idx in (0..old.len()).rev() {
        for new_idx in (0..new.len()).rev() {
            dp[old_idx][new_idx] = if old[old_idx] == new[new_idx] {
                dp[old_idx + 1][new_idx + 1] + 1
            } else {
                dp[old_idx + 1][new_idx].max(dp[old_idx][new_idx + 1])
            };
        }
    }

    let mut pairs = Vec::new();
    let mut old_idx = 0;
    let mut new_idx = 0;
    while old_idx < old.len() && new_idx < new.len() {
        if old[old_idx] == new[new_idx] {
            pairs.push((old_idx, new_idx));
            old_idx += 1;
            new_idx += 1;
        } else if dp[old_idx + 1][new_idx] >= dp[old_idx][new_idx + 1] {
            old_idx += 1;
        } else {
            new_idx += 1;
        }
    }
    pairs
}

/// Slice a padded window out of the post-apply file for each hunk.
fn materialize_regions(
    new_lines: &[String],
    regions_meta: &[(usize, usize, usize)],
) -> Vec<HunkRegion> {
    let mut regions = Vec::with_capacity(regions_meta.len());
    for &(chunk_idx, new_start, new_len) in regions_meta {
        let start = new_start.saturating_sub(POST_APPLY_PAD);
        let end = (new_start + new_len + POST_APPLY_PAD).min(new_lines.len());
        if start >= end {
            continue;
        }
        regions.push(HunkRegion {
            chunk: chunk_idx,
            start_line: start + 1,
            lines: new_lines[start..end].to_vec(),
        });
    }
    regions
}

fn replace_all_replacements(
    original_lines: &[String],
    old_lines: &[String],
    new_lines: &[String],
    chunk: usize,
) -> Vec<Replacement> {
    if old_lines.is_empty() {
        return Vec::new();
    }
    let mut replacements = Vec::new();
    let mut idx = 0;
    while idx + old_lines.len() <= original_lines.len() {
        if original_lines[idx..idx + old_lines.len()] == *old_lines {
            replacements.push(Replacement {
                chunk,
                start: idx,
                old: old_lines.to_vec(),
                new: new_lines.to_vec(),
            });
            idx += old_lines.len();
        } else {
            idx += 1;
        }
    }
    replacements
}

fn compute_replacements(
    original_lines: &[String],
    chunks: &[UpdateFileChunk],
    file_rel: &str,
    attempts: &mut Vec<AnchorAttempt>,
) -> Result<(Replacements, Vec<HunkFuzzy>), ChunkFailure> {
    let mut replacements: Replacements = Vec::new();
    let mut line_index: usize = 0;
    let mut fuzzy_hunks: Vec<HunkFuzzy> = Vec::new();

    for (chunk_index, chunk) in chunks.iter().enumerate() {
        let mut chunk_worst = MatchQuality::Exact;
        if let Some((start, end)) = chunk.line_range {
            let start_zero = start.saturating_sub(1);
            if start == 0 || end < start || end > original_lines.len() {
                return Err(ChunkFailure::LineRangeMismatch {
                    chunk_index,
                    start,
                    end,
                    near_miss: near_miss_snippet(
                        original_lines,
                        start_zero.min(original_lines.len()),
                        chunk.old_lines.first().map(String::as_str),
                    ),
                });
            }
            let old_slice = &original_lines[start_zero..end];
            if old_slice != chunk.old_lines.as_slice() {
                return Err(ChunkFailure::LineRangeMismatch {
                    chunk_index,
                    start,
                    end,
                    near_miss: near_miss_snippet(
                        original_lines,
                        start_zero,
                        chunk.old_lines.first().map(String::as_str),
                    ),
                });
            }
            replacements.push(Replacement {
                chunk: chunk_index,
                start: start_zero,
                old: chunk.old_lines.clone(),
                new: chunk.new_lines.clone(),
            });
            line_index = end;
            attempts.push(AnchorAttempt {
                file_path: file_rel.to_string(),
                chunk_index,
                anchor_text: Some(format!("lines {start}-{end}")),
                success: true,
                fuzzy_tier: Some(chunk_worst.as_str().to_string()),
            });
            continue;
        }
        // Walk every stacked anchor in order. Each `@@ <line>` advances the
        // file cursor past its match before the next anchor (or the body
        // pattern) is searched. The last anchor in the stack is the one
        // immediately before the body — that's the one used for the
        // anchor-shadow check.
        if let Some(last_anchor) = chunk.change_contexts.last()
            && chunk.old_lines.first() == Some(last_anchor)
        {
            // Catch the anchor-shadow footgun *before* seeking: the anchor
            // consumes its line and the pattern search resumes below, so if
            // the first pattern line is the same text it will either miss
            // entirely or (worse) match a later duplicate. Specific error
            // beats a confusing "context not found".
            attempts.push(AnchorAttempt {
                file_path: file_rel.to_string(),
                chunk_index,
                anchor_text: Some(last_anchor.clone()),
                success: false,
                fuzzy_tier: None,
            });
            return Err(ChunkFailure::AnchorShadowsFirstContext {
                chunk_index,
                anchor: last_anchor.clone(),
            });
        }
        for ctx_line in &chunk.change_contexts {
            match seek_sequence(
                original_lines,
                std::slice::from_ref(ctx_line),
                line_index,
                false,
            ) {
                SeekOutcome::Unique { idx, quality } => {
                    line_index = idx + 1;
                    chunk_worst = worse_of(chunk_worst, quality);
                    attempts.push(AnchorAttempt {
                        file_path: file_rel.to_string(),
                        chunk_index,
                        anchor_text: Some(ctx_line.clone()),
                        success: true,
                        fuzzy_tier: Some(quality.as_str().to_string()),
                    });
                }
                SeekOutcome::Ambiguous { matches, .. } => {
                    attempts.push(AnchorAttempt {
                        file_path: file_rel.to_string(),
                        chunk_index,
                        anchor_text: Some(ctx_line.clone()),
                        success: false,
                        fuzzy_tier: None,
                    });
                    let candidates = one_based(&matches);
                    let disambiguation_hints = disambiguate_candidates(original_lines, &matches);
                    return Err(ChunkFailure::Ambiguous {
                        chunk_index,
                        change_contexts: chunk.change_contexts.clone(),
                        candidates,
                        disambiguation_hints,
                    });
                }
                SeekOutcome::NotFound => {
                    attempts.push(AnchorAttempt {
                        file_path: file_rel.to_string(),
                        chunk_index,
                        anchor_text: Some(ctx_line.clone()),
                        success: false,
                        fuzzy_tier: None,
                    });
                    return Err(ChunkFailure::NotFound {
                        chunk_index,
                        change_contexts: chunk.change_contexts.clone(),
                        first_old_line: chunk.old_lines.first().cloned(),
                        near_miss: near_miss_snippet(
                            original_lines,
                            line_index,
                            Some(ctx_line.as_str()),
                        ),
                    });
                }
            }
        }

        if chunk.old_lines.is_empty() {
            let insertion_idx = if original_lines.last().is_some_and(String::is_empty) {
                original_lines.len() - 1
            } else {
                original_lines.len()
            };
            replacements.push(Replacement {
                chunk: chunk_index,
                start: insertion_idx,
                old: Vec::new(),
                new: chunk.new_lines.clone(),
            });
            attempts.push(AnchorAttempt {
                file_path: file_rel.to_string(),
                chunk_index,
                anchor_text: chunk.change_contexts.last().cloned(),
                success: true,
                fuzzy_tier: Some(chunk_worst.as_str().to_string()),
            });
            continue;
        }

        let mut pattern: &[String] = &chunk.old_lines;
        let mut new_slice: &[String] = &chunk.new_lines;
        let mut outcome = seek_sequence(original_lines, pattern, line_index, chunk.is_end_of_file);
        let mut repaired_pattern: Option<Vec<String>> = None;
        let mut repaired_new: Option<Vec<String>> = None;

        if matches!(outcome, SeekOutcome::NotFound) && pattern.last().is_some_and(String::is_empty)
        {
            pattern = &pattern[..pattern.len() - 1];
            if new_slice.last().is_some_and(String::is_empty) {
                new_slice = &new_slice[..new_slice.len() - 1];
            }
            outcome = seek_sequence(original_lines, pattern, line_index, chunk.is_end_of_file);
        }
        if matches!(outcome, SeekOutcome::NotFound) {
            let candidate = repair_missing_marker_space(pattern);
            if candidate != pattern {
                outcome =
                    seek_sequence(original_lines, &candidate, line_index, chunk.is_end_of_file);
                if !matches!(outcome, SeekOutcome::NotFound) {
                    repaired_pattern = Some(candidate);
                    repaired_new = Some(repair_missing_marker_space(new_slice));
                }
            }
        }
        let pattern = repaired_pattern.as_deref().unwrap_or(pattern);
        let new_slice = repaired_new.as_deref().unwrap_or(new_slice);

        match outcome {
            SeekOutcome::Unique { idx, quality } => {
                replacements.push(Replacement {
                    chunk: chunk_index,
                    start: idx,
                    old: pattern.to_vec(),
                    new: preserve_matched_context(original_lines, idx, pattern, new_slice),
                });
                line_index = idx + pattern.len();
                chunk_worst = worse_of(chunk_worst, quality);
            }
            SeekOutcome::Ambiguous { matches, .. } => {
                attempts.push(AnchorAttempt {
                    file_path: file_rel.to_string(),
                    chunk_index,
                    anchor_text: chunk.change_contexts.last().cloned(),
                    success: false,
                    fuzzy_tier: None,
                });
                let candidates = one_based(&matches);
                let disambiguation_hints = disambiguate_candidates(original_lines, &matches);
                return Err(ChunkFailure::Ambiguous {
                    chunk_index,
                    change_contexts: chunk.change_contexts.clone(),
                    candidates,
                    disambiguation_hints,
                });
            }
            SeekOutcome::NotFound => {
                attempts.push(AnchorAttempt {
                    file_path: file_rel.to_string(),
                    chunk_index,
                    anchor_text: chunk.change_contexts.last().cloned(),
                    success: false,
                    fuzzy_tier: None,
                });
                return Err(ChunkFailure::NotFound {
                    chunk_index,
                    change_contexts: chunk.change_contexts.clone(),
                    first_old_line: chunk.old_lines.first().cloned(),
                    near_miss: near_miss_snippet(
                        original_lines,
                        line_index,
                        chunk.old_lines.first().map(String::as_str),
                    ),
                });
            }
        }

        attempts.push(AnchorAttempt {
            file_path: file_rel.to_string(),
            chunk_index,
            anchor_text: chunk.change_contexts.last().cloned(),
            success: true,
            fuzzy_tier: Some(chunk_worst.as_str().to_string()),
        });

        if chunk_worst != MatchQuality::Exact {
            fuzzy_hunks.push(HunkFuzzy {
                chunk: chunk_index,
                tier: chunk_worst,
            });
        }
    }

    replacements.sort_by_key(|r| r.start);
    Ok((replacements, fuzzy_hunks))
}

fn derive_new_contents_from_scope_chunks(
    original: &str,
    chunks: &[UpdateScopeChunk],
    file_rel: &str,
    attempts: &mut Vec<AnchorAttempt>,
) -> Result<DerivedContents, ApplyPatchError> {
    let mut original_lines: Vec<String> = original.split('\n').map(String::from).collect();
    if original_lines.last().is_some_and(String::is_empty) {
        original_lines.pop();
    }

    let (replacements, fuzzy_hunks) =
        compute_scope_replacements(&original_lines, original, chunks, file_rel, attempts)?;
    let regions_meta = plan_post_apply_regions(&replacements);
    let line_changes = plan_line_changes(&replacements);
    let mut new_lines = apply_replacements(original_lines, replacements);
    if !new_lines.last().is_some_and(String::is_empty) {
        new_lines.push(String::new());
    }
    let regions = materialize_regions(&new_lines, &regions_meta);
    Ok((new_lines.join("\n"), fuzzy_hunks, regions, line_changes))
}

type ScopeCursorKey = (usize, usize, String, String);

fn compute_scope_replacements(
    original_lines: &[String],
    original: &str,
    chunks: &[UpdateScopeChunk],
    file_rel: &str,
    attempts: &mut Vec<AnchorAttempt>,
) -> Result<(Replacements, Vec<HunkFuzzy>), ApplyPatchError> {
    let mut replacements: Replacements = Vec::new();
    let mut fuzzy_hunks = Vec::new();
    let mut cursors: HashMap<ScopeCursorKey, usize> = HashMap::new();

    for (chunk_index, chunk) in chunks.iter().enumerate() {
        let (_, _, scope) = super::scope::anchor_for_locator(file_rel, original, &chunk.locator)
            .map_err(|error| scope_resolve_error(file_rel, original, chunk_index, chunk, error))?;
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

        if chunk.old_lines.is_empty() {
            replacements.push(Replacement {
                chunk: chunk_index,
                start: *cursor,
                old: Vec::new(),
                new: chunk.new_lines.clone(),
            });
            attempts.push(AnchorAttempt {
                file_path: file_rel.to_string(),
                chunk_index,
                anchor_text: Some(chunk.locator.clone()),
                success: true,
                fuzzy_tier: Some(MatchQuality::Exact.as_str().to_string()),
            });
            continue;
        }

        let mut pattern: &[String] = &chunk.old_lines;
        let mut new_slice: &[String] = &chunk.new_lines;
        let mut outcome =
            seek_sequence(scope_lines, pattern, relative_cursor, chunk.is_end_of_file);
        let mut repaired_pattern: Option<Vec<String>> = None;
        let mut repaired_new: Option<Vec<String>> = None;
        if matches!(outcome, SeekOutcome::NotFound) && pattern.last().is_some_and(String::is_empty)
        {
            pattern = &pattern[..pattern.len() - 1];
            if new_slice.last().is_some_and(String::is_empty) {
                new_slice = &new_slice[..new_slice.len() - 1];
            }
            outcome = seek_sequence(scope_lines, pattern, relative_cursor, chunk.is_end_of_file);
        }
        if matches!(outcome, SeekOutcome::NotFound) {
            let candidate = repair_missing_marker_space(pattern);
            if candidate != pattern {
                outcome = seek_sequence(
                    scope_lines,
                    &candidate,
                    relative_cursor,
                    chunk.is_end_of_file,
                );
                if !matches!(outcome, SeekOutcome::NotFound) {
                    repaired_pattern = Some(candidate);
                    repaired_new = Some(repair_missing_marker_space(new_slice));
                }
            }
        }
        let pattern = repaired_pattern.as_deref().unwrap_or(pattern);
        let new_slice = repaired_new.as_deref().unwrap_or(new_slice);

        match outcome {
            SeekOutcome::Unique { idx, quality } => {
                let abs_idx = start + idx;
                replacements.push(Replacement {
                    chunk: chunk_index,
                    start: abs_idx,
                    old: pattern.to_vec(),
                    new: preserve_matched_context(original_lines, abs_idx, pattern, new_slice),
                });
                *cursor = abs_idx + pattern.len();
                attempts.push(AnchorAttempt {
                    file_path: file_rel.to_string(),
                    chunk_index,
                    anchor_text: Some(chunk.locator.clone()),
                    success: true,
                    fuzzy_tier: Some(quality.as_str().to_string()),
                });
                if quality != MatchQuality::Exact {
                    fuzzy_hunks.push(HunkFuzzy {
                        chunk: chunk_index,
                        tier: quality,
                    });
                }
            }
            SeekOutcome::Ambiguous { matches, .. } => {
                let abs_matches = matches
                    .into_iter()
                    .map(|matched| start + matched)
                    .collect::<Vec<_>>();
                attempts.push(AnchorAttempt {
                    file_path: file_rel.to_string(),
                    chunk_index,
                    anchor_text: Some(chunk.locator.clone()),
                    success: false,
                    fuzzy_tier: None,
                });
                return Err(ApplyPatchError::AmbiguousContext {
                    path: file_rel.to_string(),
                    chunk: chunk_index,
                    change_contexts: vec![chunk.locator.clone()],
                    candidates: one_based(&abs_matches),
                    disambiguation_hints: disambiguate_candidates(original_lines, &abs_matches),
                });
            }
            SeekOutcome::NotFound => {
                attempts.push(AnchorAttempt {
                    file_path: file_rel.to_string(),
                    chunk_index,
                    anchor_text: Some(chunk.locator.clone()),
                    success: false,
                    fuzzy_tier: None,
                });
                return Err(ApplyPatchError::ContextNotFound {
                    path: file_rel.to_string(),
                    chunk: chunk_index,
                    change_contexts: vec![chunk.locator.clone()],
                    first_old_line: chunk.old_lines.first().cloned(),
                    near_miss: scope_near_miss_snippet(
                        original_lines,
                        *cursor,
                        chunk.old_lines.first().map(String::as_str),
                        &scope,
                    ),
                });
            }
        }
    }

    replacements.sort_by_key(|replacement| replacement.start);
    Ok((replacements, fuzzy_hunks))
}

fn scope_resolve_error(
    file_rel: &str,
    original: &str,
    chunk_index: usize,
    chunk: &UpdateScopeChunk,
    error: ScopeResolveError,
) -> ApplyPatchError {
    match error {
        ScopeResolveError::NotFound | ScopeResolveError::EmptySource => {
            ApplyPatchError::ContextNotFound {
                path: file_rel.to_string(),
                chunk: chunk_index,
                change_contexts: vec![chunk.locator.clone()],
                first_old_line: chunk.old_lines.first().cloned(),
                near_miss: available_scope_snippet(file_rel, original),
            }
        }
        ScopeResolveError::Ambiguous(scopes) => ApplyPatchError::AmbiguousContext {
            path: file_rel.to_string(),
            chunk: chunk_index,
            change_contexts: vec![chunk.locator.clone()],
            candidates: scopes.iter().map(|scope| scope.start_line).collect(),
            disambiguation_hints: scopes
                .iter()
                .take(4)
                .map(|scope| {
                    format!(
                        "@@ {} {}  →  line {}",
                        scope.kind, scope.name, scope.start_line
                    )
                })
                .collect(),
        },
    }
}

fn scope_near_miss_snippet(
    original_lines: &[String],
    cursor: usize,
    expected: Option<&str>,
    scope: &super::scope::SourceScope,
) -> Option<String> {
    let mut snippet = format!(
        "\ninside {} {} (lines {}-{}):",
        scope.kind, scope.name, scope.start_line, scope.end_line
    );
    if let Some(near_miss) = near_miss_snippet(original_lines, cursor, expected) {
        snippet.push_str(&near_miss);
    }
    Some(snippet)
}

fn available_scope_snippet(file_rel: &str, original: &str) -> Option<String> {
    let scopes = super::scope::source_scopes(file_rel, original);
    if scopes.is_empty() {
        return None;
    }
    let mut out = String::from("\navailable scopes:\n");
    for scope in scopes.into_iter().take(16) {
        out.push_str(&format!(
            "{:>4}: {} {} (ends {})\n",
            scope.start_line, scope.kind, scope.name, scope.end_line
        ));
    }
    Some(out)
}

fn preserve_matched_context(
    original_lines: &[String],
    start: usize,
    pattern: &[String],
    new_lines: &[String],
) -> Vec<String> {
    let mut out = new_lines.to_vec();
    let mut old_index = 0;
    for line in &mut out {
        if old_index >= pattern.len() {
            break;
        }
        if let Some(relative) = pattern[old_index..].iter().position(|old| old == line) {
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

fn worse_of(a: MatchQuality, b: MatchQuality) -> MatchQuality {
    let rank = |q: MatchQuality| match q {
        MatchQuality::Exact => 0,
        MatchQuality::TrimEnd => 1,
        MatchQuality::Trim => 2,
        MatchQuality::Normalized => 3,
    };
    if rank(a) >= rank(b) { a } else { b }
}

fn one_based(zero: &[usize]) -> Vec<usize> {
    zero.iter().map(|&i| i + 1).collect()
}

/// Numbered window of the original file, centered on the closest fuzzy match
/// for `expected` (the line the patch thought it was removing). Falls back to
/// `cursor` when `expected` is absent or too dissimilar. Included in
/// ContextNotFound errors so callers can regenerate the patch without
/// re-reading the file.
fn near_miss_snippet(
    original_lines: &[String],
    cursor: usize,
    expected: Option<&str>,
) -> Option<String> {
    if original_lines.is_empty() {
        return None;
    }
    const LEAD: usize = 8;
    const WINDOW: usize = 24;

    // Trust the closest match only when it's plausibly the same line — within
    // half the expected character length, floor 3. Beyond that the "closest"
    // line is probably unrelated and would mis-center the window.
    let closest = expected.filter(|e| !e.is_empty()).and_then(|exp| {
        let (idx, dist) = closest_line(exp, original_lines)?;
        let budget = exp.chars().count().div_ceil(2).max(3);
        (dist <= budget).then_some((idx, dist))
    });

    let center = closest.map(|(idx, _)| idx).unwrap_or(cursor);
    let start = center.saturating_sub(LEAD);
    let end = (center + WINDOW).min(original_lines.len());
    if start >= end {
        return None;
    }

    let width = ((end as f64).log10().floor() as usize) + 1;
    let mut out = String::from("\nfile state");
    if let Some((idx, dist)) = closest {
        out.push_str(&format!(
            " (closest match: line {} at edit distance {})",
            idx + 1,
            dist,
        ));
    }
    out.push_str(":\n");
    for (offset, line) in original_lines[start..end].iter().enumerate() {
        out.push_str(&format!(
            "{:>width$}: {}\n",
            start + offset + 1,
            line,
            width = width,
        ));
    }
    Some(out)
}

/// Scan `lines` for the one with smallest Levenshtein distance to `expected`.
/// Prunes by length gap — if `|len(a) - len(b)| ≥ best_dist`, no way this line
/// is closer than the current best, so skip the full DP.
fn closest_line(expected: &str, lines: &[String]) -> Option<(usize, usize)> {
    if lines.is_empty() {
        return None;
    }
    let exp_len = expected.chars().count();
    let mut best: Option<(usize, usize)> = None;
    for (idx, line) in lines.iter().enumerate() {
        let line_len = line.chars().count();
        let len_gap = exp_len.abs_diff(line_len);
        if let Some((_, best_dist)) = best
            && len_gap >= best_dist
        {
            continue;
        }
        let dist = levenshtein(expected, line);
        if best.is_none_or(|(_, bd)| dist < bd) {
            best = Some((idx, dist));
            if dist == 0 {
                return best;
            }
        }
    }
    best
}

/// Character-wise Levenshtein distance. Two-row DP — O(m·n) time, O(n) space.
fn levenshtein(a: &str, b: &str) -> usize {
    let a_chars: Vec<char> = a.chars().collect();
    let b_chars: Vec<char> = b.chars().collect();
    let (m, n) = (a_chars.len(), b_chars.len());
    if m == 0 {
        return n;
    }
    if n == 0 {
        return m;
    }
    let mut prev: Vec<usize> = (0..=n).collect();
    let mut curr: Vec<usize> = vec![0; n + 1];
    for i in 1..=m {
        curr[0] = i;
        for j in 1..=n {
            let cost = usize::from(a_chars[i - 1] != b_chars[j - 1]);
            curr[j] = (prev[j] + 1).min(curr[j - 1] + 1).min(prev[j - 1] + cost);
        }
        std::mem::swap(&mut prev, &mut curr);
    }
    prev[n]
}

fn chunk_failure_to_error(fail: ChunkFailure, path: &str) -> ApplyPatchError {
    match fail {
        ChunkFailure::NotFound {
            chunk_index,
            change_contexts,
            first_old_line,
            near_miss,
        } => ApplyPatchError::ContextNotFound {
            path: path.to_string(),
            chunk: chunk_index,
            change_contexts,
            first_old_line,
            near_miss,
        },
        ChunkFailure::Ambiguous {
            chunk_index,
            change_contexts,
            candidates,
            disambiguation_hints,
        } => ApplyPatchError::AmbiguousContext {
            path: path.to_string(),
            chunk: chunk_index,
            change_contexts,
            candidates,
            disambiguation_hints,
        },
        ChunkFailure::LineRangeMismatch {
            chunk_index,
            start,
            end,
            near_miss,
        } => ApplyPatchError::LineRangeMismatch {
            path: path.to_string(),
            chunk: chunk_index,
            start,
            end,
            near_miss,
        },
        ChunkFailure::AnchorShadowsFirstContext {
            chunk_index,
            anchor,
        } => ApplyPatchError::AnchorShadowsFirstContext {
            path: path.to_string(),
            chunk: chunk_index,
            anchor,
        },
    }
}

/// Maximum lines to scan upward from each ambiguous candidate when looking
/// for a structurally distinct anchor. Bounded so a 50k-line file doesn't
/// quadratic-search itself when ambiguity strikes near the end.
const DISAMBIGUATION_LOOKBACK: usize = 80;

/// Maximum number of disambiguation suggestions to emit. Past this, the
/// error message is just clutter — the caller has enough to pick.
const DISAMBIGUATION_MAX_HINTS: usize = 4;

/// For each ambiguous candidate (0-based file index of the start of the
/// match), walk upward up to `DISAMBIGUATION_LOOKBACK` lines looking for a
/// "structural" line that:
///
///   1. Is non-blank.
///   2. Appears exactly once in the file (so it's a valid `@@` anchor).
///   3. Doesn't itself match any of the other candidate locations' upstream
///      window (so it discriminates *this* candidate from the others).
///
/// Returns one suggestion per candidate where such a line exists, capped at
/// `DISAMBIGUATION_MAX_HINTS`. Empty when no disambiguator could be found.
fn disambiguate_candidates(original_lines: &[String], candidates: &[usize]) -> Vec<String> {
    if candidates.len() < 2 {
        return Vec::new();
    }
    // Pre-build a uniqueness map: count occurrences of each line across the
    // whole file. A line is a candidate anchor only if its count is 1.
    let mut counts: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for line in original_lines {
        *counts.entry(line.as_str()).or_insert(0) += 1;
    }

    let mut hints: Vec<String> = Vec::new();
    for &cand in candidates {
        if hints.len() >= DISAMBIGUATION_MAX_HINTS {
            break;
        }
        let lookback_start = cand.saturating_sub(DISAMBIGUATION_LOOKBACK);
        // Walk upward from the line just above the candidate. Prefer stable
        // semantic parent lines (e.g. `name: "tool"`, function headers) over
        // nearer incidental statements so the suggestion remains useful when
        // retrying with stacked anchors.
        let mut anchor_line: Option<(u8, usize, &str)> = None;
        for i in (lookback_start..cand).rev() {
            let line = original_lines[i].as_str();
            if !is_structural_line(line) {
                continue;
            }
            if counts.get(line).copied().unwrap_or(0) != 1 {
                continue;
            }
            let priority = anchor_priority(line);
            match anchor_line {
                Some((best_priority, _, _)) if best_priority >= priority => {}
                _ => anchor_line = Some((priority, i, line)),
            }
        }
        if let Some((_, idx, line)) = anchor_line {
            // 1-based line numbers in the hint match what the user sees in
            // their editor and what the candidates list reports.
            hints.push(format!(
                "@@ {}  →  pins to candidate at line {} (anchor at line {})",
                line.trim_end(),
                cand + 1,
                idx + 1
            ));
        }
    }
    hints
}

/// A "structural" line that's worth proposing as an anchor: non-blank,
/// non-pure-punctuation, and ideally a declaration/header. We err on the
/// side of accepting any non-trivial content — `is_unique` filters down to
/// the lines that actually disambiguate.
fn is_structural_line(line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return false;
    }
    // Reject pure-punctuation lines like `}`, `};`, `);`, `})`, etc.
    // They're rarely unique enough to be useful, and are noisy.
    if trimmed.chars().all(|c| !c.is_alphanumeric()) {
        return false;
    }
    true
}

fn anchor_priority(line: &str) -> u8 {
    let trimmed = line.trim_start();
    if trimmed.starts_with("name:")
        || trimmed.starts_with("id:")
        || trimmed.starts_with("key:")
        || trimmed.starts_with("type:")
    {
        return 4;
    }
    if trimmed.starts_with("pub fn ")
        || trimmed.starts_with("fn ")
        || trimmed.starts_with("async fn ")
        || trimmed.starts_with("impl ")
        || trimmed.starts_with("mod ")
        || trimmed.starts_with("pub struct ")
        || trimmed.starts_with("struct ")
        || trimmed.starts_with("pub enum ")
        || trimmed.starts_with("enum ")
        || trimmed.starts_with("class ")
        || trimmed.starts_with("function ")
        || trimmed.starts_with("export function ")
    {
        return 3;
    }
    if trimmed.ends_with("{") || trimmed.ends_with("({") || trimmed.ends_with("[") {
        return 2;
    }
    1
}

fn apply_replacements(mut lines: Vec<String>, replacements: Replacements) -> Vec<String> {
    // Iterate in reverse so earlier edits' offsets stay valid as later ones
    // land. `splice` is O(n) once per hunk (vs O(k·n) for remove+insert) and
    // moves owned `String`s into place without cloning.
    for r in replacements.into_iter().rev() {
        let start = r.start.min(lines.len());
        let end = (r.start + r.old_len()).min(lines.len());
        lines.splice(start..end, r.new);
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn resolve_path_accepts_relative_and_absolute() {
        let tmp = TempDir::new().unwrap();
        let sub = tmp.path().join("foo");
        fs::create_dir_all(&sub).unwrap();
        let canon = tmp.path().canonicalize().unwrap();

        let via_relative = resolve_path(&canon, Path::new("foo/bar.rs")).unwrap();
        assert!(via_relative.starts_with(&canon));
        assert!(via_relative.ends_with("bar.rs"));

        let abs = canon.join("zed.txt");
        let via_absolute = resolve_path(&canon, &abs).unwrap();
        assert_eq!(via_absolute, abs);
    }

    #[test]
    fn plan_add_returns_add_change() {
        let tmp = TempDir::new().unwrap();
        let patch = "*** Begin Patch\n*** Add File: hello.txt\n+hi\n+world\n*** End Patch\n";
        let outcome = plan(patch, tmp.path()).unwrap();
        let changes = &outcome.changes;
        assert_eq!(changes.len(), 1);
        let c = &changes[0];
        assert_eq!(c.kind, ChangeType::Add);
        assert_eq!(c.path, "hello.txt");
        assert!(c.additions > 0);
        assert_eq!(c.deletions, 0);
        assert_eq!(c.new_content.as_deref(), Some("hi\nworld\n"));
        // Filesystem untouched by plan alone.
        assert!(!tmp.path().join("hello.txt").exists());
    }

    #[test]
    fn update_scope_uses_tree_sitter_locator() {
        let tmp = TempDir::new().unwrap();
        fs::write(
            tmp.path().join("sample.js"),
            "function alpha() {\n  return 1;\n}\n\nfunction beta() {\n  return 1;\n}\n",
        )
        .unwrap();
        let patch = concat!(
            "*** Begin Patch\n",
            "*** Update Scope: sample.js\n",
            "@@ function beta\n",
            "-  return 1;\n",
            "+  return 2;\n",
            "*** End Patch\n",
        );
        let outcome = plan(patch, tmp.path()).unwrap();
        let content = outcome.changes[0].new_content.as_deref().unwrap();
        assert!(content.contains("function alpha() {\n  return 1;\n}"));
        assert!(content.contains("function beta() {\n  return 2;\n}"));
    }

    #[test]
    fn update_scope_batches_multiple_sections_for_one_file() {
        let tmp = TempDir::new().unwrap();
        fs::write(
            tmp.path().join("sample.js"),
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
            "*** End Patch\n",
        );
        let outcome = plan(patch, tmp.path()).unwrap();
        let content = outcome.changes[0].new_content.as_deref().unwrap();
        assert!(content.contains("function alpha() {\n  return 10;\n}"));
        assert!(content.contains("function beta() {\n  return 20;\n}"));
    }

    #[test]
    fn update_scope_allows_repeated_locator_chunks_in_one_scope() {
        let tmp = TempDir::new().unwrap();
        fs::write(
            tmp.path().join("sample.js"),
            "function alpha() {\n  const one = 1;\n  const two = 2;\n  return one + two;\n}\n",
        )
        .unwrap();
        let patch = concat!(
            "*** Begin Patch\n",
            "*** Update Scope: sample.js\n",
            "@@ function alpha\n",
            "-  const one = 1;\n",
            "+  const one = 10;\n",
            "@@ function alpha\n",
            "-  return one + two;\n",
            "+  return one * two;\n",
            "*** End Patch\n",
        );
        let outcome = plan(patch, tmp.path()).unwrap();
        let content = outcome.changes[0].new_content.as_deref().unwrap();
        assert!(content.contains("  const one = 10;"));
        assert!(content.contains("  return one * two;"));
    }

    #[test]
    fn update_scope_repairs_missing_marker_space_for_indented_lines() {
        let tmp = TempDir::new().unwrap();
        fs::write(
            tmp.path().join("sample.rs"),
            "#[test]\nfn sample() {\n        assert!(\n            true\n        );\n}\n",
        )
        .unwrap();
        let patch = concat!(
            "*** Begin Patch\n",
            "*** Update Scope: sample.rs\n",
            "@@ function sample\n",
            "        assert!(\n",
            "-            true\n",
            "+            false\n",
            "        );\n",
            "*** End Patch\n",
        );
        let outcome = plan(patch, tmp.path()).unwrap();
        let content = outcome.changes[0].new_content.as_deref().unwrap();
        assert!(content.contains("        assert!(\n            false\n        );"));
    }

    #[test]
    fn plan_and_commit_round_trip() {
        let tmp = TempDir::new().unwrap();
        // Seed files for Update, Delete, Move.
        fs::write(tmp.path().join("update_me.txt"), "alpha\nbeta\ngamma\n").unwrap();
        fs::write(tmp.path().join("delete_me.txt"), "bye\n").unwrap();
        fs::write(tmp.path().join("move_src.txt"), "one\ntwo\nthree\n").unwrap();

        let patch = concat!(
            "*** Begin Patch\n",
            "*** Add File: added.txt\n",
            "+fresh\n",
            "*** Update File: update_me.txt\n",
            "@@\n",
            " alpha\n",
            "-beta\n",
            "+BETA\n",
            " gamma\n",
            "*** Delete File: delete_me.txt\n",
            "*** Update File: move_src.txt\n",
            "*** Move to: move_dst.txt\n",
            "@@\n",
            " one\n",
            "-two\n",
            "+TWO\n",
            " three\n",
            "*** End Patch\n",
        );

        let outcome = plan(patch, tmp.path()).unwrap();
        let changes = outcome.changes;
        assert_eq!(changes.len(), 4);
        commit(tmp.path(), &changes).unwrap();

        assert_eq!(
            fs::read_to_string(tmp.path().join("added.txt")).unwrap(),
            "fresh\n"
        );
        assert_eq!(
            fs::read_to_string(tmp.path().join("update_me.txt")).unwrap(),
            "alpha\nBETA\ngamma\n"
        );
        assert!(!tmp.path().join("delete_me.txt").exists());
        assert!(!tmp.path().join("move_src.txt").exists());
        assert_eq!(
            fs::read_to_string(tmp.path().join("move_dst.txt")).unwrap(),
            "one\nTWO\nthree\n"
        );
    }

    #[test]
    fn dry_run_leaves_fs_unchanged() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("keep.txt"), "stay\n").unwrap();
        let patch = concat!(
            "*** Begin Patch\n",
            "*** Update File: keep.txt\n",
            "@@\n",
            "-stay\n",
            "+moved\n",
            "*** End Patch\n",
        );

        // plan() alone must not write.
        let outcome = plan(patch, tmp.path()).unwrap();
        let changes = &outcome.changes;
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].kind, ChangeType::Update);
        assert_eq!(
            fs::read_to_string(tmp.path().join("keep.txt")).unwrap(),
            "stay\n"
        );

        // apply() with dry_run=true must also not write.
        let _ = apply(patch, tmp.path(), true).unwrap();
        assert_eq!(
            fs::read_to_string(tmp.path().join("keep.txt")).unwrap(),
            "stay\n"
        );
    }

    #[test]
    fn post_apply_region_echoes_window_around_each_hunk() {
        let tmp = TempDir::new().unwrap();
        fs::write(
            tmp.path().join("lib.rs"),
            "fn one() {}\nfn two() {}\nfn three() {}\nfn four() {}\nfn five() {}\n",
        )
        .unwrap();
        let patch = concat!(
            "*** Begin Patch\n",
            "*** Update File: lib.rs\n",
            "@@\n",
            " fn two() {}\n",
            "-fn three() {}\n",
            "+fn THREE() {}\n",
            " fn four() {}\n",
            "*** End Patch\n",
        );

        let outcome = plan(patch, tmp.path()).unwrap();
        let changes = &outcome.changes;
        let regions = &changes[0].post_apply_regions;
        assert_eq!(regions.len(), 1, "one hunk → one region");
        assert_eq!(regions[0].chunk, 0);
        assert!(
            regions[0].lines.iter().any(|l| l == "fn THREE() {}"),
            "post-apply window must include the new line, got: {:?}",
            regions[0].lines,
        );
        // `start_line` is 1-based — verify the first echoed line really sits
        // at that file position after apply.
        let expected_first = &regions[0].lines[0];
        let new_content = changes[0].new_content.as_deref().unwrap();
        let new_lines: Vec<&str> = new_content.lines().collect();
        assert_eq!(new_lines[regions[0].start_line - 1], expected_first);
    }

    #[test]
    fn line_changes_describe_authored_runs_without_context() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("lib.rs"), "one\ntwo\nthree\nfour\n").unwrap();
        let patch = concat!(
            "*** Begin Patch\n",
            "*** Update File: lib.rs\n",
            "@@\n",
            " one\n",
            "-two\n",
            "+TWO\n",
            "+two and a half\n",
            " three\n",
            "*** End Patch\n",
        );

        let outcome = plan(patch, tmp.path()).unwrap();
        let changes = &outcome.changes[0].line_changes;
        assert_eq!(
            changes,
            &[LineChange {
                chunk: 0,
                old_start: Some(2),
                old_end: Some(2),
                new_start: Some(2),
                new_end: Some(3),
                old_len: 1,
                new_len: 2,
            }]
        );
    }

    #[test]
    fn line_changes_track_insertions_and_deletions() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("lib.rs"), "one\ntwo\nthree\n").unwrap();
        let insert = concat!(
            "*** Begin Patch\n",
            "*** Update File: lib.rs\n",
            "@@\n",
            "+four\n",
            "*** End Patch\n",
        );
        let inserted = plan(insert, tmp.path()).unwrap();
        assert_eq!(inserted.changes[0].line_changes[0].old_start, Some(4));
        assert_eq!(inserted.changes[0].line_changes[0].new_start, Some(4));
        assert_eq!(inserted.changes[0].line_changes[0].old_len, 0);
        assert_eq!(inserted.changes[0].line_changes[0].new_len, 1);

        let delete = concat!(
            "*** Begin Patch\n",
            "*** Update File: lib.rs\n",
            "@@\n",
            " one\n",
            "-two\n",
            " three\n",
            "*** End Patch\n",
        );
        let deleted = plan(delete, tmp.path()).unwrap();
        assert_eq!(deleted.changes[0].line_changes[0].old_start, Some(2));
        assert_eq!(deleted.changes[0].line_changes[0].old_end, Some(2));
        assert_eq!(deleted.changes[0].line_changes[0].new_start, None);
        assert_eq!(deleted.changes[0].line_changes[0].old_len, 1);
        assert_eq!(deleted.changes[0].line_changes[0].new_len, 0);
    }

    #[test]
    fn near_miss_hints_closest_line_via_edit_distance() {
        // "println!(\"nope\")" is a 5-edit mutation of "println!(\"hello\")";
        // the near-miss hint should center on line 2 and name its distance.
        let lines: Vec<String> = ["fn main() {", "    println!(\"hello\");", "}"]
            .iter()
            .map(|s| (*s).to_string())
            .collect();
        let hint = near_miss_snippet(&lines, 0, Some("    println!(\"nope\");")).unwrap();
        assert!(hint.contains("closest match: line 2"), "{hint}");
        assert!(hint.contains("edit distance 5"), "{hint}");
        assert!(hint.contains("println!(\"hello\")"), "{hint}");
    }

    #[test]
    fn near_miss_falls_back_to_cursor_when_no_close_match() {
        let lines: Vec<String> = (0..10).map(|i| format!("unrelated line {i}")).collect();
        let hint = near_miss_snippet(&lines, 5, Some("totally different content here")).unwrap();
        // Distance is huge → no closest-match header; window stays around cursor.
        assert!(!hint.contains("closest match"), "{hint}");
        assert!(hint.contains("unrelated line 5"), "{hint}");
    }

    #[test]
    fn anchor_shadowing_first_context_returns_specific_error() {
        let tmp = TempDir::new().unwrap();
        fs::write(
            tmp.path().join("m.rs"),
            "fn greet() {\n    println!(\"hi\");\n}\n",
        )
        .unwrap();
        // The offender: `@@ fn greet() {` followed by ` fn greet() {` as first
        // context line. Anchor is consumed, then the pattern search tries to
        // find `fn greet() {` on the next line — fails. Before this check it
        // surfaced as a confusing "context not found"; now the error names it.
        let patch = concat!(
            "*** Begin Patch\n",
            "*** Update File: m.rs\n",
            "@@ fn greet() {\n",
            " fn greet() {\n",
            "-    println!(\"hi\");\n",
            "+    println!(\"hello\");\n",
            " }\n",
            "*** End Patch\n",
        );
        let err = plan(patch, tmp.path()).unwrap_err().error;
        match err {
            ApplyPatchError::AnchorShadowsFirstContext { anchor, chunk, .. } => {
                assert_eq!(anchor, "fn greet() {");
                assert_eq!(chunk, 0);
            }
            other => panic!("expected AnchorShadowsFirstContext, got: {other:?}"),
        }
    }

    #[test]
    fn zero_context_unique_removal_applies() {
        // The `-` line alone is distinctive enough to be unique in the file,
        // so no context is needed. Keeps hunks tight and reduces drift risk.
        let tmp = TempDir::new().unwrap();
        fs::write(
            tmp.path().join("code.rs"),
            "fn a() {}\nfn UNIQUE_TARGET() {}\nfn b() {}\n",
        )
        .unwrap();
        let patch = concat!(
            "*** Begin Patch\n",
            "*** Update File: code.rs\n",
            "@@\n",
            "-fn UNIQUE_TARGET() {}\n",
            "+fn RENAMED() {}\n",
            "*** End Patch\n",
        );
        let outcome = plan(patch, tmp.path()).unwrap();
        let changes = &outcome.changes;
        assert_eq!(
            changes[0].new_content.as_deref(),
            Some("fn a() {}\nfn RENAMED() {}\nfn b() {}\n"),
        );
    }

    #[test]
    fn zero_context_ambiguous_removal_rejected_with_candidates() {
        // Same shape, but the `-` line occurs twice — ambiguity detection
        // kicks in and reports both line numbers so the caller can add one
        // line of context instead of re-reading the file.
        let tmp = TempDir::new().unwrap();
        fs::write(
            tmp.path().join("code.rs"),
            "let x = 1;\nlet y = 2;\nlet x = 1;\n",
        )
        .unwrap();
        let patch = concat!(
            "*** Begin Patch\n",
            "*** Update File: code.rs\n",
            "@@\n",
            "-let x = 1;\n",
            "+let z = 3;\n",
            "*** End Patch\n",
        );
        let err = plan(patch, tmp.path()).unwrap_err().error;
        match err {
            ApplyPatchError::AmbiguousContext { candidates, .. } => {
                assert_eq!(candidates, vec![1, 3]);
            }
            other => panic!("expected AmbiguousContext, got: {other:?}"),
        }
    }

    #[test]
    fn single_context_line_resolves_ambiguity() {
        // Neither `    return;` nor `pub fn two() {` alone is unique, but the
        // pair is — one context line is enough to pin the edit.
        let tmp = TempDir::new().unwrap();
        fs::write(
            tmp.path().join("code.rs"),
            "pub fn one() {}\npub fn two() {\n    return;\n}\npub fn three() {\n    return;\n}\n",
        )
        .unwrap();
        let patch = concat!(
            "*** Begin Patch\n",
            "*** Update File: code.rs\n",
            "@@\n",
            " pub fn two() {\n",
            "-    return;\n",
            "+    return 42;\n",
            "*** End Patch\n",
        );
        let outcome = plan(patch, tmp.path()).unwrap();
        let changes = &outcome.changes;
        let content = changes[0].new_content.as_deref().unwrap();
        assert!(
            content.contains("pub fn two() {\n    return 42;\n}"),
            "hunk must land in fn two, got: {content}",
        );
        assert!(
            content.contains("pub fn three() {\n    return;\n}"),
            "fn three must stay untouched, got: {content}",
        );
    }

    /// Stacked `@@` anchors narrow into a function inside an impl block,
    /// then patch a line that's repeated across multiple impls. Without
    /// stacked anchor support this used to be unreachable without echoing
    /// the entire impl as context.
    #[test]
    fn stacked_anchors_narrow_into_impl_block() {
        let tmp = TempDir::new().unwrap();
        fs::write(
            tmp.path().join("code.rs"),
            "impl Foo {\n    fn run(&self) {\n        return;\n    }\n}\n\
             impl Bar {\n    fn run(&self) {\n        return;\n    }\n}\n",
        )
        .unwrap();
        let patch = concat!(
            "*** Begin Patch\n",
            "*** Update File: code.rs\n",
            "@@ impl Bar {\n",
            "@@     fn run(&self) {\n",
            "-        return;\n",
            "+        return 42;\n",
            "*** End Patch\n",
        );
        let outcome = plan(patch, tmp.path()).unwrap();
        let content = outcome.changes[0].new_content.as_deref().unwrap();
        assert!(
            content.contains("impl Bar {\n    fn run(&self) {\n        return 42;\n"),
            "hunk must land in Bar::run, got: {content}",
        );
        assert!(
            content.contains("impl Foo {\n    fn run(&self) {\n        return;\n"),
            "Foo::run must stay untouched, got: {content}",
        );
    }

    /// AmbiguousContext on a generic body line surfaces a suggested anchor
    /// for each candidate, drawn from a unique upstream structural line.
    /// Converts a re-try into a deterministic fix instead of forcing the
    /// model to re-read the file.
    #[test]
    fn ambiguous_context_emits_disambiguation_hints() {
        let tmp = TempDir::new().unwrap();
        fs::write(
            tmp.path().join("code.rs"),
            "pub fn alpha() {\n    return;\n}\n\
             pub fn beta() {\n    return;\n}\n",
        )
        .unwrap();
        let patch = concat!(
            "*** Begin Patch\n",
            "*** Update File: code.rs\n",
            "@@\n",
            "-    return;\n",
            "+    return 42;\n",
            "*** End Patch\n",
        );
        let err = plan(patch, tmp.path()).unwrap_err().error;
        let msg = err.to_string();
        assert!(msg.contains("ambiguous context"), "msg: {msg}");
        assert!(msg.contains("suggested anchors:"), "msg: {msg}");
        assert!(
            msg.contains("@@ pub fn alpha()") || msg.contains("@@ pub fn beta()"),
            "expected at least one structural anchor suggestion, got: {msg}"
        );
    }

    /// Stacked anchor anchor-shadow check uses the *last* anchor (the one
    /// immediately before the body), not the first.
    #[test]
    fn anchor_shadow_check_uses_last_stacked_anchor() {
        let tmp = TempDir::new().unwrap();
        fs::write(
            tmp.path().join("m.rs"),
            "mod outer {\n    fn greet() {\n        println!(\"hi\");\n    }\n}\n",
        )
        .unwrap();
        // Two stacked anchors. The *second* (`fn greet() {`) shadows the
        // first body line — that's what should be flagged.
        let patch = concat!(
            "*** Begin Patch\n",
            "*** Update File: m.rs\n",
            "@@ mod outer {\n",
            "@@ fn greet() {\n",
            " fn greet() {\n",
            "-        println!(\"hi\");\n",
            "+        println!(\"hello\");\n",
            " }\n",
            "*** End Patch\n",
        );
        let err = plan(patch, tmp.path()).unwrap_err().error;
        match err {
            ApplyPatchError::AnchorShadowsFirstContext { anchor, .. } => {
                assert_eq!(anchor, "fn greet() {");
            }
            other => panic!("expected AnchorShadowsFirstContext, got: {other:?}"),
        }
    }

    #[test]
    fn anchor_stack_renders_one_or_many() {
        assert_eq!(format_anchor_stack(&[]), "");
        assert_eq!(format_anchor_stack(&["foo".into()]), " (@@ foo)");
        assert_eq!(
            format_anchor_stack(&["foo".into(), "bar".into()]),
            " (@@ foo / @@ bar)"
        );
    }

    #[test]
    fn disambiguate_skips_when_only_one_candidate() {
        let lines: Vec<String> = vec!["fn foo()".into(), "    return;".into()];
        assert!(disambiguate_candidates(&lines, &[1]).is_empty());
    }

    #[test]
    fn disambiguate_picks_nearest_unique_upstream_line() {
        let lines: Vec<String> = vec![
            "fn alpha()".into(),
            "    return;".into(),
            "fn beta()".into(),
            "    return;".into(),
        ];
        let hints = disambiguate_candidates(&lines, &[1, 3]);
        assert_eq!(hints.len(), 2);
        assert!(hints[0].contains("@@ fn alpha()"), "hints: {hints:?}");
        assert!(hints[1].contains("@@ fn beta()"), "hints: {hints:?}");
        assert!(hints[0].contains("line 2"), "hints: {hints:?}");
        assert!(hints[1].contains("line 4"), "hints: {hints:?}");
    }

    #[test]
    fn disambiguate_prefers_semantic_parent_over_nearer_statement() {
        let lines: Vec<String> = vec![
            "registerTool({".into(),
            "\tname: \"vault_create\",".into(),
            "\tasync execute() {".into(),
            "\t\tif (dive) args.push(\"--dive\");".into(),
            "\t\tconst result = await runCt(args, ctx.cwd, signal);".into(),
            "\t\treturn toolResult(formatCommand(\"ct\", args), ctx.cwd, result);".into(),
            "\t},".into(),
            "});".into(),
            "registerTool({".into(),
            "\tname: \"vault_archive\",".into(),
            "\tasync execute() {".into(),
            "\t\tthrow new Error(\"target required\");".into(),
            "\t\tconst result = await runCt(args, ctx.cwd, signal);".into(),
            "\t\treturn toolResult(formatCommand(\"ct\", args), ctx.cwd, result);".into(),
            "\t},".into(),
            "});".into(),
        ];
        let hints = disambiguate_candidates(&lines, &[4, 12]);
        assert_eq!(hints.len(), 2);
        assert!(
            hints[0].contains("@@ \tname: \"vault_create\","),
            "hints: {hints:?}"
        );
        assert!(
            hints[1].contains("@@ \tname: \"vault_archive\","),
            "hints: {hints:?}"
        );
    }

    #[test]
    fn is_structural_rejects_pure_punctuation() {
        assert!(!is_structural_line("}"));
        assert!(!is_structural_line("};"));
        assert!(!is_structural_line("    )"));
        assert!(!is_structural_line(""));
        assert!(!is_structural_line("   "));
        assert!(is_structural_line("fn foo()"));
        assert!(is_structural_line("    return;"));
    }
}
