// Ported from openai/codex apply-patch/src/parser.rs
// https://github.com/openai/codex/tree/fe7c959e90d46abb8311e4a0b369e6cb32bf337e
// Licensed under Apache License 2.0. See NOTICE at workspace root.

//! This module is responsible for parsing & validating a patch into a list of "hunks".
//! (It does not attempt to actually check that the patch can be applied to the filesystem.)
//!
//! The official Lark grammar for the apply-patch format is:
//!
//! start: begin_patch intent? hunk+ end_patch
//! begin_patch: "*** Begin Patch" LF
//! end_patch: "*** End Patch" LF?
//! intent: "*** Intent: " intent_text LF
//!
//! hunk: add_hunk | delete_hunk | update_hunk | move_hunk | replace_all_hunk | update_scope_hunk
//! add_hunk: "*** Add File: " filename LF add_line+
//! delete_hunk: "*** Delete File: " filename LF
//! update_hunk: "*** Update File: " filename LF change_move? change?
//! move_hunk: "*** Move File: " filename " -> " filename LF
//! replace_all_hunk: "*** Replace All In File: " filename LF "*** Expect Replacements: " int LF replace_line+
//! update_scope_hunk: "*** Update Scope: " filename LF scope_change+
//! filename: /(.+)/
//! intent_text: /(.+)/
//! add_line: "+" /(.+)/ LF -> line
//!
//! change_move: "*** Move to: " filename LF
//! change: change_context* (change_line+ eof_line?)
//! change_context: ("@@" | "@@ " /(.+)/) LF      # one or more may stack
//! scope_change: "@@ " /(.+)/ LF change_line+ eof_line?
//! change_line: ("+" | "-" | " ") /(.+)/ LF
//! eof_line: "*** End of File" LF
//!
//! The parser below is a little more lenient than the explicit spec and allows for
//! leading/trailing whitespace around patch markers.
use std::path::PathBuf;

const BEGIN_PATCH_MARKER: &str = "*** Begin Patch";
const END_PATCH_MARKER: &str = "*** End Patch";
const INTENT_MARKER: &str = "*** Intent: ";
const ADD_FILE_MARKER: &str = "*** Add File: ";
const DELETE_FILE_MARKER: &str = "*** Delete File: ";
const UPDATE_FILE_MARKER: &str = "*** Update File: ";
const UPDATE_SCOPE_MARKER: &str = "*** Update Scope: ";
const MOVE_FILE_MARKER: &str = "*** Move File: ";
const MOVE_TO_MARKER: &str = "*** Move to: ";
const REPLACE_ALL_MARKER: &str = "*** Replace All In File: ";
const EXPECT_REPLACEMENTS_MARKER: &str = "*** Expect Replacements: ";
const EOF_MARKER: &str = "*** End of File";
const CHANGE_CONTEXT_MARKER: &str = "@@ ";
const EMPTY_CHANGE_CONTEXT_MARKER: &str = "@@";
const LINE_RANGE_CONTEXT_PREFIX: &str = "lines ";

/// Subkind of `InvalidHunkError`. Surfaced through telemetry so the dominant
/// parse-failure shape (e.g. Add-File body lines without a `+` prefix) is
/// visible in `ct apply-patch stats` rather than collapsed into a single
/// `parse` bucket.
#[derive(Debug, PartialEq, Clone, Copy)]
pub enum ParseErrorKind {
    /// Add-File body line without the required `+` prefix.
    AddMissingPlus,
    /// Update-hunk body line that doesn't start with ` `, `+`, or `-`.
    UnprefixedLine,
    /// First chunk of an Update started with neither `@@` nor a body line.
    MissingChunkHeader,
    /// Update hunk had no chunks and no `*** Move to:`.
    EmptyUpdate,
    /// Hunk header didn't match Add/Delete/Update.
    UnknownHunkHeader,
    /// Anything that doesn't fit a more specific subkind above.
    Other,
}

#[derive(Debug, PartialEq, Clone)]
pub enum ParseError {
    InvalidPatchError(String),
    InvalidHunkError {
        message: String,
        line_number: usize,
        snippet: Option<String>,
        kind: ParseErrorKind,
    },
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ParseError::InvalidPatchError(msg) => write!(f, "invalid patch: {msg}"),
            ParseError::InvalidHunkError {
                message,
                line_number,
                snippet,
                kind: _,
            } => write!(
                f,
                "invalid hunk at line {line_number}, {message}{}",
                snippet.as_deref().unwrap_or("")
            ),
        }
    }
}

impl std::error::Error for ParseError {}

impl ParseError {
    /// Stable string discriminator used by the telemetry layer to bucket
    /// parse failures. The empty-string sentinel for `InvalidPatchError`
    /// keeps the existing `parse` bucket intact for envelope-shape errors
    /// while letting hunk-shape errors break out by kind.
    pub fn subkind_str(&self) -> &'static str {
        match self {
            ParseError::InvalidPatchError(_) => "parse_envelope",
            ParseError::InvalidHunkError { kind, .. } => match kind {
                ParseErrorKind::AddMissingPlus => "parse_add_missing_plus",
                ParseErrorKind::UnprefixedLine => "parse_unprefixed_line",
                ParseErrorKind::MissingChunkHeader => "parse_missing_chunk_header",
                ParseErrorKind::EmptyUpdate => "parse_empty_update",
                ParseErrorKind::UnknownHunkHeader => "parse_unknown_hunk_header",
                ParseErrorKind::Other => "parse_other",
            },
        }
    }
}

use ParseError::*;

#[derive(Debug, PartialEq, Clone)]
#[allow(clippy::enum_variant_names)]
pub enum Hunk {
    AddFile {
        path: PathBuf,
        contents: String,
    },
    DeleteFile {
        path: PathBuf,
    },
    UpdateFile {
        path: PathBuf,
        move_path: Option<PathBuf>,

        /// Chunks should be in order, i.e. the `change_context` of one chunk
        /// should occur later in the file than the previous chunk.
        chunks: Vec<UpdateFileChunk>,
    },
    ReplaceAll {
        path: PathBuf,
        expected_replacements: usize,
        old_lines: Vec<String>,
        new_lines: Vec<String>,
    },
    UpdateScope {
        path: PathBuf,
        chunks: Vec<UpdateScopeChunk>,
    },
}

use Hunk::*;

#[derive(Debug, PartialEq, Clone)]
pub struct UpdateFileChunk {
    /// Anchor lines used to narrow the position of the chunk. Each
    /// `@@ <line>` immediately before the body contributes one entry, applied
    /// in order: the file cursor advances past anchor[0]'s match, then
    /// anchor[1] is searched after that point, etc. A bare `@@` is a no-op
    /// (consumed but not stored). Empty vec means "no anchor — use the body
    /// pattern alone".
    pub change_contexts: Vec<String>,
    /// Optional 1-based inclusive target from `@@ lines A-B`.
    pub line_range: Option<(usize, usize)>,

    /// A contiguous block of lines that should be replaced with `new_lines`.
    /// `old_lines` must occur strictly after the last anchor in
    /// `change_contexts`.
    pub old_lines: Vec<String>,
    pub new_lines: Vec<String>,

    /// If set to true, `old_lines` must occur at the end of the source file.
    /// (Tolerance around trailing newlines should be encouraged.)
    pub is_end_of_file: bool,
}

#[derive(Debug, PartialEq, Clone)]
pub struct UpdateScopeChunk {
    pub locator: String,
    pub old_lines: Vec<String>,
    pub new_lines: Vec<String>,
    pub is_end_of_file: bool,
}

pub fn parse_patch(patch: &str) -> Result<Vec<Hunk>, ParseError> {
    parse_patch_text(patch)
}

fn parse_patch_text(patch: &str) -> Result<Vec<Hunk>, ParseError> {
    let lines: Vec<&str> = patch.trim().lines().collect();
    let (_patch_lines, hunk_lines) = check_patch_boundaries_strict(&lines)?;
    let (hunk_lines, line_number_offset) = strip_optional_intent(hunk_lines);

    let mut hunks: Vec<Hunk> = Vec::new();
    let mut remaining_lines = hunk_lines;
    let mut line_number = 2 + line_number_offset;
    while !remaining_lines.is_empty() {
        let (hunk, hunk_lines) =
            parse_one_hunk(remaining_lines, line_number).map_err(|e| annotate(e, &lines))?;
        hunks.push(hunk);
        line_number += hunk_lines;
        remaining_lines = &remaining_lines[hunk_lines..]
    }
    Ok(hunks)
}

fn strip_optional_intent<'a>(hunk_lines: &'a [&'a str]) -> (&'a [&'a str], usize) {
    match hunk_lines.first().map(|line| line.trim()) {
        Some(line) if line.starts_with(INTENT_MARKER) => (&hunk_lines[1..], 1),
        _ => (hunk_lines, 0),
    }
}

/// Attach a snippet of the patch body around the failing line to a hunk
/// parse error, so callers can see what they wrote without counting lines.
fn annotate(err: ParseError, all_lines: &[&str]) -> ParseError {
    match err {
        ParseError::InvalidHunkError {
            message,
            line_number,
            snippet: None,
            kind,
        } => {
            let snippet = snippet_for(all_lines, line_number);
            ParseError::InvalidHunkError {
                message,
                line_number,
                snippet,
                kind,
            }
        }
        other => other,
    }
}

fn snippet_for(lines: &[&str], line_number: usize) -> Option<String> {
    if line_number == 0 || line_number > lines.len() {
        return None;
    }
    let idx = line_number - 1;
    let start = idx.saturating_sub(1);
    let end = (idx + 2).min(lines.len());
    let width = end.to_string().len();
    let mut out = String::from("\npatch near error:\n");
    for (offset, line) in lines[start..end].iter().enumerate() {
        let num = start + offset + 1;
        let marker = if start + offset == idx {
            ">>> "
        } else {
            "    "
        };
        out.push_str(&format!("{marker}{num:>width$}: {}\n", line, width = width));
    }
    Some(out)
}

/// Checks the start and end lines of the patch text for `apply_patch`,
/// returning an error if they do not match the expected markers.
fn check_patch_boundaries_strict<'a>(
    lines: &'a [&'a str],
) -> Result<(&'a [&'a str], &'a [&'a str]), ParseError> {
    let (first_line, last_line) = match lines {
        [] => (None, None),
        [first] => (Some(first), Some(first)),
        [first, .., last] => (Some(first), Some(last)),
    };
    check_start_and_end_lines_strict(first_line, last_line)?;
    Ok((lines, &lines[1..lines.len() - 1]))
}

fn check_start_and_end_lines_strict(
    first_line: Option<&&str>,
    last_line: Option<&&str>,
) -> Result<(), ParseError> {
    let first_trimmed = first_line.map(|line| line.trim());
    let last_trimmed = last_line.map(|line| line.trim());

    match (first_trimmed, last_trimmed) {
        (Some(first), Some(last)) if first == BEGIN_PATCH_MARKER && last == END_PATCH_MARKER => {
            Ok(())
        }
        (Some(first), _) if first != BEGIN_PATCH_MARKER => Err(InvalidPatchError(
            boundary_error_message("first", BEGIN_PATCH_MARKER, first_line.copied()),
        )),
        _ => Err(InvalidPatchError(boundary_error_message(
            "last",
            END_PATCH_MARKER,
            last_line.copied(),
        ))),
    }
}

fn boundary_error_message(which: &str, expected: &str, observed: Option<&str>) -> String {
    let Some(line) = observed else {
        return format!("The {which} line of the patch must be '{expected}' (patch was empty)");
    };
    let trimmed = line.trim();
    let hint = marker_prefix_hint(trimmed, expected);
    let base = format!("The {which} line of the patch must be '{expected}', got: {line:?}");
    match hint {
        Some(h) => format!("{base}. {h}"),
        None => base,
    }
}

fn marker_prefix_hint(trimmed: &str, expected: &str) -> Option<&'static str> {
    for prefix in ["+", "-", " "] {
        if let Some(rest) = trimmed.strip_prefix(prefix)
            && rest.trim_start() == expected
        {
            return Some(
                "It looks like the envelope marker was written as a hunk line. \
                 Drop the leading '+', '-', or ' ' prefix so the marker terminates the envelope.",
            );
        }
    }
    None
}

/// Attempts to parse a single hunk from the start of lines.
/// Returns the parsed hunk and the number of lines parsed (or a ParseError).
fn parse_one_hunk(lines: &[&str], line_number: usize) -> Result<(Hunk, usize), ParseError> {
    // Be tolerant of case mismatches and extra padding around marker strings.
    let first_line = lines[0].trim();
    if let Some(path) = first_line.strip_prefix(ADD_FILE_MARKER) {
        // Add File
        let mut contents = String::new();
        let mut parsed_lines = 1;
        for add_line in &lines[1..] {
            if let Some(line_to_add) = add_line.strip_prefix('+') {
                contents.push_str(line_to_add);
                contents.push('\n');
                parsed_lines += 1;
            } else {
                // Stop on the next hunk marker — that's the legitimate end of
                // this Add-File body. Anything else here is the most common
                // Add-File mistake: the model wrote raw file contents without
                // the required `+` prefix (e.g. literal `---` for markdown
                // frontmatter). Surface it specifically so telemetry buckets
                // it as `parse_add_missing_plus` and the model sees a precise
                // hint instead of "unknown hunk header" for the next line.
                let trimmed = add_line.trim_start();
                if !trimmed.starts_with("***") {
                    let preview: String = add_line.chars().take(80).collect();
                    return Err(InvalidHunkError {
                        message: format!(
                            "Add File body lines must start with '+' — got: {preview:?}. \
                             Prefix every initial-content line with '+', including blank lines (' +' for an empty line is fine, just `+` works too)."
                        ),
                        line_number: line_number + parsed_lines,
                        snippet: None,
                        kind: ParseErrorKind::AddMissingPlus,
                    });
                }
                break;
            }
        }
        return Ok((
            AddFile {
                path: PathBuf::from(path),
                contents,
            },
            parsed_lines,
        ));
    } else if let Some(path) = first_line.strip_prefix(DELETE_FILE_MARKER) {
        // Delete File
        return Ok((
            DeleteFile {
                path: PathBuf::from(path),
            },
            1,
        ));
    } else if let Some(spec) = first_line.strip_prefix(MOVE_FILE_MARKER) {
        let Some((from, to)) = spec.split_once(" -> ") else {
            return Err(InvalidHunkError {
                message: "Move File hunk must be written as '*** Move File: old/path -> new/path'"
                    .to_string(),
                line_number,
                snippet: None,
                kind: ParseErrorKind::UnknownHunkHeader,
            });
        };
        return Ok((
            UpdateFile {
                path: PathBuf::from(from),
                move_path: Some(PathBuf::from(to)),
                chunks: Vec::new(),
            },
            1,
        ));
    } else if let Some(path) = first_line.strip_prefix(REPLACE_ALL_MARKER) {
        let Some(expect_line) = lines.get(1).and_then(|line| {
            line.trim()
                .strip_prefix(EXPECT_REPLACEMENTS_MARKER)
                .map(str::trim)
        }) else {
            return Err(InvalidHunkError {
                message: "Replace All hunks require '*** Expect Replacements: N' immediately after the file header".to_string(),
                line_number: line_number + 1,
                snippet: None,
                kind: ParseErrorKind::MissingChunkHeader,
            });
        };
        let expected_replacements = expect_line.parse::<usize>().map_err(|_| InvalidHunkError {
            message: format!("Invalid replacement count: {expect_line:?}"),
            line_number: line_number + 1,
            snippet: None,
            kind: ParseErrorKind::MissingChunkHeader,
        })?;
        let mut old_lines = Vec::new();
        let mut new_lines = Vec::new();
        let mut parsed_lines = 2;
        for line in &lines[2..] {
            if line.starts_with("***") {
                break;
            }
            match line.chars().next() {
                Some('-') => old_lines.push(line[1..].to_string()),
                Some('+') => new_lines.push(line[1..].to_string()),
                _ => {
                    return Err(InvalidHunkError {
                        message: "Replace All body lines must start with '-' or '+'".to_string(),
                        line_number: line_number + parsed_lines,
                        snippet: None,
                        kind: ParseErrorKind::UnprefixedLine,
                    });
                }
            }
            parsed_lines += 1;
        }
        if old_lines.is_empty() {
            return Err(InvalidHunkError {
                message: "Replace All requires at least one '-' line".to_string(),
                line_number,
                snippet: None,
                kind: ParseErrorKind::EmptyUpdate,
            });
        }
        return Ok((
            ReplaceAll {
                path: PathBuf::from(path),
                expected_replacements,
                old_lines,
                new_lines,
            },
            parsed_lines,
        ));
    } else if let Some(path) = first_line.strip_prefix(UPDATE_FILE_MARKER) {
        // Update File
        let mut remaining_lines = &lines[1..];
        let mut parsed_lines = 1;

        // Optional: move file line
        let move_path = remaining_lines
            .first()
            .and_then(|x| x.strip_prefix(MOVE_TO_MARKER));

        if move_path.is_some() {
            remaining_lines = &remaining_lines[1..];
            parsed_lines += 1;
        }

        let mut chunks = Vec::new();
        // NOTE: we need to know to stop once we reach the next special marker header.
        while !remaining_lines.is_empty() {
            // Skip over any completely blank lines that may separate chunks.
            if remaining_lines[0].trim().is_empty() {
                parsed_lines += 1;
                remaining_lines = &remaining_lines[1..];
                continue;
            }

            if remaining_lines[0].starts_with('*') {
                break;
            }

            let (chunk, chunk_lines) = parse_update_file_chunk(
                remaining_lines,
                line_number + parsed_lines,
                chunks.is_empty(),
            )?;
            chunks.push(chunk);
            parsed_lines += chunk_lines;
            remaining_lines = &remaining_lines[chunk_lines..]
        }

        if chunks.is_empty() && move_path.is_none() {
            return Err(InvalidHunkError {
                message: format!("Update file hunk for path '{path}' is empty"),
                line_number,
                snippet: None,
                kind: ParseErrorKind::EmptyUpdate,
            });
        }

        return Ok((
            UpdateFile {
                path: PathBuf::from(path),
                move_path: move_path.map(PathBuf::from),
                chunks,
            },
            parsed_lines,
        ));
    } else if let Some(path) = first_line.strip_prefix(UPDATE_SCOPE_MARKER) {
        let mut remaining_lines = &lines[1..];
        let mut parsed_lines = 1;
        let mut chunks = Vec::new();
        while !remaining_lines.is_empty() {
            if remaining_lines[0].trim().is_empty() {
                parsed_lines += 1;
                remaining_lines = &remaining_lines[1..];
                continue;
            }
            if remaining_lines[0].starts_with('*') {
                break;
            }
            let (chunk, chunk_lines) =
                parse_update_scope_chunk(remaining_lines, line_number + parsed_lines)?;
            chunks.push(chunk);
            parsed_lines += chunk_lines;
            remaining_lines = &remaining_lines[chunk_lines..];
        }
        if chunks.is_empty() {
            return Err(InvalidHunkError {
                message: format!("Update scope hunk for path '{path}' is empty"),
                line_number,
                snippet: None,
                kind: ParseErrorKind::EmptyUpdate,
            });
        }
        return Ok((
            UpdateScope {
                path: PathBuf::from(path),
                chunks,
            },
            parsed_lines,
        ));
    }

    Err(InvalidHunkError {
        message: format!(
            "'{first_line}' is not a valid hunk header. Valid hunk headers: '*** Add File: {{path}}', '*** Delete File: {{path}}', '*** Update File: {{path}}', '*** Move File: {{old}} -> {{new}}', '*** Replace All In File: {{path}}', '*** Update Scope: {{path}}'"
        ),
        line_number,
        snippet: None,
        kind: ParseErrorKind::UnknownHunkHeader,
    })
}

fn parse_line_range_context(
    context: &str,
    line_number: usize,
) -> Option<Result<(usize, usize), ParseError>> {
    let spec = context
        .trim()
        .strip_prefix(LINE_RANGE_CONTEXT_PREFIX)?
        .trim();
    let Some((start, end)) = spec.split_once('-') else {
        return Some(Err(InvalidHunkError {
            message: "Line range context must use '@@ lines START-END'".to_string(),
            line_number,
            snippet: None,
            kind: ParseErrorKind::MissingChunkHeader,
        }));
    };
    let parsed = start
        .trim()
        .parse::<usize>()
        .ok()
        .zip(end.trim().parse::<usize>().ok())
        .filter(|(start, end)| *start >= 1 && *start <= *end)
        .ok_or_else(|| InvalidHunkError {
            message: "Line range context must use a valid 1-based inclusive range".to_string(),
            line_number,
            snippet: None,
            kind: ParseErrorKind::MissingChunkHeader,
        });
    Some(parsed)
}

fn parse_update_file_chunk(
    lines: &[&str],
    line_number: usize,
    allow_missing_context: bool,
) -> Result<(UpdateFileChunk, usize), ParseError> {
    if lines.is_empty() {
        return Err(InvalidHunkError {
            message: "Update hunk does not contain any lines".to_string(),
            line_number,
            snippet: None,
            kind: ParseErrorKind::EmptyUpdate,
        });
    }
    // Collect *all* consecutive @@ / @@ <text> lines as a stacked anchor
    // sequence. Each non-empty anchor advances the cursor past its own match
    // before the next anchor (or the body) is searched. Bare `@@` is consumed
    // as a marker but contributes no anchor text.
    //
    // Stacked anchors used to be a parse error and were the dominant failure
    // shape in telemetry — models reach for them naturally to narrow into a
    // function or block before the change. Supporting them removes the
    // footgun.
    let mut change_contexts: Vec<String> = Vec::new();
    let mut line_range: Option<(usize, usize)> = None;
    let mut start_index = 0;
    while start_index < lines.len() {
        let line = lines[start_index];
        if line == EMPTY_CHANGE_CONTEXT_MARKER {
            start_index += 1;
            continue;
        }
        if let Some(context) = line.strip_prefix(CHANGE_CONTEXT_MARKER) {
            if let Some(range) = parse_line_range_context(context, line_number + start_index) {
                line_range = Some(range?);
            } else {
                change_contexts.push(context.to_string());
            }
            start_index += 1;
            continue;
        }
        break;
    }
    if start_index == 0 && !allow_missing_context {
        return Err(InvalidHunkError {
            message: format!(
                "Expected update hunk to start with a @@ context marker, got: '{}'",
                lines[0]
            ),
            line_number,
            snippet: None,
            kind: ParseErrorKind::MissingChunkHeader,
        });
    }
    if start_index >= lines.len() {
        return Err(InvalidHunkError {
            message: "Update hunk does not contain any lines".to_string(),
            line_number: line_number + 1,
            snippet: None,
            kind: ParseErrorKind::EmptyUpdate,
        });
    }
    let mut chunk = UpdateFileChunk {
        change_contexts,
        line_range,
        old_lines: Vec::new(),
        new_lines: Vec::new(),
        is_end_of_file: false,
    };
    let mut parsed_lines = 0;
    for line in &lines[start_index..] {
        match *line {
            EOF_MARKER => {
                if parsed_lines == 0 {
                    return Err(InvalidHunkError {
                        message: "Update hunk does not contain any lines".to_string(),
                        line_number: line_number + 1,
                        snippet: None,
                        kind: ParseErrorKind::EmptyUpdate,
                    });
                }
                chunk.is_end_of_file = true;
                parsed_lines += 1;
                break;
            }
            line_contents => {
                match line_contents.chars().next() {
                    None => {
                        // Interpret this as an empty line.
                        chunk.old_lines.push(String::new());
                        chunk.new_lines.push(String::new());
                    }
                    Some(' ') => {
                        chunk.old_lines.push(line_contents[1..].to_string());
                        chunk.new_lines.push(line_contents[1..].to_string());
                    }
                    Some('+') => {
                        chunk.new_lines.push(line_contents[1..].to_string());
                    }
                    Some('-') => {
                        chunk.old_lines.push(line_contents[1..].to_string());
                    }
                    _ => {
                        if parsed_lines == 0 {
                            return Err(InvalidHunkError {
                                message: format!(
                                    "Unexpected line found in update hunk: '{line_contents}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)"
                                ),
                                line_number: line_number + 1,
                                snippet: None,
                                kind: ParseErrorKind::UnprefixedLine,
                            });
                        }
                        // Assume this is the start of the next hunk.
                        break;
                    }
                }
                parsed_lines += 1;
            }
        }
    }

    Ok((chunk, parsed_lines + start_index))
}

fn parse_update_scope_chunk(
    lines: &[&str],
    line_number: usize,
) -> Result<(UpdateScopeChunk, usize), ParseError> {
    let Some(locator) = lines
        .first()
        .and_then(|line| line.strip_prefix(CHANGE_CONTEXT_MARKER))
        .map(str::trim)
        .filter(|locator| !locator.is_empty())
    else {
        return Err(InvalidHunkError {
            message: "Expected scope update hunk to start with '@@ <scope locator>'".to_string(),
            line_number,
            snippet: None,
            kind: ParseErrorKind::MissingChunkHeader,
        });
    };

    let (chunk, parsed_lines) = parse_update_file_chunk(lines, line_number, false)?;
    if chunk.change_contexts.len() != 1 {
        return Err(InvalidHunkError {
            message: "Update Scope hunks require exactly one semantic locator marker, e.g. '@@ function renderSummary'".to_string(),
            line_number,
            snippet: None,
            kind: ParseErrorKind::MissingChunkHeader,
        });
    }
    Ok((
        UpdateScopeChunk {
            locator: locator.to_string(),
            old_lines: chunk.old_lines,
            new_lines: chunk.new_lines,
            is_end_of_file: chunk.is_end_of_file,
        },
        parsed_lines,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_patch() {
        assert_eq!(
            parse_patch_text("bad"),
            Err(InvalidPatchError(
                "The first line of the patch must be '*** Begin Patch', got: \"bad\"".to_string()
            ))
        );
        assert_eq!(
            parse_patch_text("*** Begin Patch\nbad"),
            Err(InvalidPatchError(
                "The last line of the patch must be '*** End Patch', got: \"bad\"".to_string()
            ))
        );

        assert_eq!(
            parse_patch_text(concat!(
                "*** Begin Patch",
                " ",
                "\n*** Add File: foo\n+hi\n",
                " ",
                "*** End Patch"
            ))
            .unwrap(),
            vec![AddFile {
                path: PathBuf::from("foo"),
                contents: "hi\n".to_string()
            }]
        );
        match parse_patch_text(
            "*** Begin Patch\n\
             *** Update File: test.py\n\
             *** End Patch",
        ) {
            Err(ParseError::InvalidHunkError {
                ref message,
                line_number: 2,
                snippet: Some(_),
                kind: ParseErrorKind::EmptyUpdate,
            }) => {
                assert_eq!(message, "Update file hunk for path 'test.py' is empty");
            }
            other => panic!("expected annotated InvalidHunkError, got {other:?}"),
        }
        assert_eq!(
            parse_patch_text(
                "*** Begin Patch\n\
                 *** End Patch",
            )
            .unwrap(),
            Vec::<Hunk>::new()
        );

        let err = parse_patch_text(
            "*** Begin Patch\n\
             *** Add File: foo\n\
             +hi\n\
             +*** End Patch",
        )
        .unwrap_err();
        let ParseError::InvalidPatchError(msg) = err else {
            panic!("expected InvalidPatchError, got {err:?}");
        };
        assert!(msg.contains("got: \"+*** End Patch\""), "msg = {msg}");
        assert!(
            msg.contains("envelope marker was written as a hunk line"),
            "msg = {msg}"
        );
        assert_eq!(
            parse_patch_text(
                "*** Begin Patch\n\
                 *** Intent: Explain why this patch exists.\n\
                 *** Add File: path/add.py\n\
                 +abc\n\
                 +def\n\
                 *** Delete File: path/delete.py\n\
                 *** Update File: path/update.py\n\
                 *** Move to: path/update2.py\n\
                 @@ def f():\n\
                 -    pass\n\
                 +    return 123\n\
                 *** End Patch",
            )
            .unwrap(),
            vec![
                AddFile {
                    path: PathBuf::from("path/add.py"),
                    contents: "abc\ndef\n".to_string()
                },
                DeleteFile {
                    path: PathBuf::from("path/delete.py")
                },
                UpdateFile {
                    path: PathBuf::from("path/update.py"),
                    move_path: Some(PathBuf::from("path/update2.py")),
                    chunks: vec![UpdateFileChunk {
                        change_contexts: vec!["def f():".to_string()],
                        line_range: None,
                        old_lines: vec!["    pass".to_string()],
                        new_lines: vec!["    return 123".to_string()],
                        is_end_of_file: false
                    }]
                }
            ]
        );
        // Update hunk followed by another hunk (Add File).
        assert_eq!(
            parse_patch_text(
                "*** Begin Patch\n\
                 *** Update File: file.py\n\
                 @@\n\
                 +line\n\
                 *** Add File: other.py\n\
                 +content\n\
                 *** End Patch",
            )
            .unwrap(),
            vec![
                UpdateFile {
                    path: PathBuf::from("file.py"),
                    move_path: None,
                    chunks: vec![UpdateFileChunk {
                        change_contexts: vec![],
                        line_range: None,
                        old_lines: vec![],
                        new_lines: vec!["line".to_string()],
                        is_end_of_file: false
                    }],
                },
                AddFile {
                    path: PathBuf::from("other.py"),
                    contents: "content\n".to_string()
                }
            ]
        );

        // Update hunk without an explicit @@ header for the first chunk should parse.
        // Use a raw string to preserve the leading space diff marker on the context line.
        assert_eq!(
            parse_patch_text(
                r#"*** Begin Patch
*** Update File: file2.py
 import foo
+bar
*** End Patch"#,
            )
            .unwrap(),
            vec![UpdateFile {
                path: PathBuf::from("file2.py"),
                move_path: None,
                chunks: vec![UpdateFileChunk {
                    change_contexts: vec![],
                    line_range: None,
                    old_lines: vec!["import foo".to_string()],
                    new_lines: vec!["import foo".to_string(), "bar".to_string()],
                    is_end_of_file: false,
                }],
            }]
        );
    }

    #[test]
    fn test_parse_patch_accepts_relative_and_absolute_hunk_paths() {
        let dir = tempfile::tempdir().unwrap();
        let absolute_delete = dir.path().join("absolute-delete.py");
        let absolute_update = dir.path().join("absolute-update.py");
        let patch_text = format!(
            r#"*** Begin Patch
*** Add File: relative-add.py
+content
*** Delete File: {}
*** Update File: {}
@@
-old
+new
*** End Patch"#,
            absolute_delete.display(),
            absolute_update.display()
        );

        assert_eq!(
            parse_patch_text(&patch_text).unwrap(),
            vec![
                AddFile {
                    path: PathBuf::from("relative-add.py"),
                    contents: "content\n".to_string()
                },
                DeleteFile {
                    path: absolute_delete.clone()
                },
                UpdateFile {
                    path: absolute_update.clone(),
                    move_path: None,
                    chunks: vec![UpdateFileChunk {
                        change_contexts: vec![],
                        line_range: None,
                        old_lines: vec!["old".to_string()],
                        new_lines: vec!["new".to_string()],
                        is_end_of_file: false
                    }]
                },
            ]
        );
    }

    #[test]
    fn test_parse_one_hunk() {
        assert_eq!(
            parse_one_hunk(&["bad"], /*line_number*/ 234),
            Err(InvalidHunkError {
                message: "'bad' is not a valid hunk header. \
            Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}', '*** Move File: {old} -> {new}', '*** Replace All In File: {path}', '*** Update Scope: {path}'".to_string(),
                line_number: 234,
                snippet: None,
                kind: ParseErrorKind::UnknownHunkHeader,
            })
        );
        // Other edge cases are already covered by tests above/below.
    }

    #[test]
    fn parses_move_file_and_replace_all_hunks() {
        assert_eq!(
            parse_patch_text(
                "*** Begin Patch\n\
                 *** Move File: old.txt -> new.txt\n\
                 *** Replace All In File: words.txt\n\
                 *** Expect Replacements: 2\n\
                 -old\n\
                 +new\n\
                 *** End Patch",
            )
            .unwrap(),
            vec![
                UpdateFile {
                    path: PathBuf::from("old.txt"),
                    move_path: Some(PathBuf::from("new.txt")),
                    chunks: Vec::new(),
                },
                ReplaceAll {
                    path: PathBuf::from("words.txt"),
                    expected_replacements: 2,
                    old_lines: vec!["old".to_string()],
                    new_lines: vec!["new".to_string()],
                },
            ]
        );
    }

    #[test]
    fn parses_line_range_context() {
        let chunk = parse_update_file_chunk(
            &["@@ lines 10-12", "-old", "+new", "*** End Patch"],
            123,
            false,
        )
        .unwrap()
        .0;
        assert_eq!(chunk.line_range, Some((10, 12)));
        assert!(chunk.change_contexts.is_empty());
    }

    #[test]
    fn test_update_file_chunk() {
        assert_eq!(
            parse_update_file_chunk(
                &["bad"],
                /*line_number*/ 123,
                /*allow_missing_context*/ false
            ),
            Err(InvalidHunkError {
                message: "Expected update hunk to start with a @@ context marker, got: 'bad'"
                    .to_string(),
                line_number: 123,
                snippet: None,
                kind: ParseErrorKind::MissingChunkHeader,
            })
        );
        assert_eq!(
            parse_update_file_chunk(
                &["@@"],
                /*line_number*/ 123,
                /*allow_missing_context*/ false
            ),
            Err(InvalidHunkError {
                message: "Update hunk does not contain any lines".to_string(),
                line_number: 124,
                snippet: None,
                kind: ParseErrorKind::EmptyUpdate,
            })
        );
        assert_eq!(
            parse_update_file_chunk(&["@@", "bad"], /*line_number*/ 123, /*allow_missing_context*/ false),
            Err(InvalidHunkError {
                message:  "Unexpected line found in update hunk: 'bad'. \
                       Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)".to_string(),
                line_number: 124,
                snippet: None,
                kind: ParseErrorKind::UnprefixedLine,
            })
        );
        assert_eq!(
            parse_update_file_chunk(
                &["@@", "*** End of File"],
                /*line_number*/ 123,
                /*allow_missing_context*/ false
            ),
            Err(InvalidHunkError {
                message: "Update hunk does not contain any lines".to_string(),
                line_number: 124,
                snippet: None,
                kind: ParseErrorKind::EmptyUpdate,
            })
        );
        assert_eq!(
            parse_update_file_chunk(
                &[
                    "@@ change_context",
                    "",
                    " context",
                    "-remove",
                    "+add",
                    " context2",
                    "*** End Patch",
                ],
                /*line_number*/ 123,
                /*allow_missing_context*/ false
            ),
            Ok((
                (UpdateFileChunk {
                    change_contexts: vec!["change_context".to_string()],
                    line_range: None,
                    old_lines: vec![
                        "".to_string(),
                        "context".to_string(),
                        "remove".to_string(),
                        "context2".to_string()
                    ],
                    new_lines: vec![
                        "".to_string(),
                        "context".to_string(),
                        "add".to_string(),
                        "context2".to_string()
                    ],
                    is_end_of_file: false
                }),
                6
            ))
        );
        assert_eq!(
            parse_update_file_chunk(
                &["@@", "+line", "*** End of File"],
                /*line_number*/ 123,
                /*allow_missing_context*/ false
            ),
            Ok((
                (UpdateFileChunk {
                    change_contexts: vec![],
                    line_range: None,
                    old_lines: vec![],
                    new_lines: vec!["line".to_string()],
                    is_end_of_file: true
                }),
                3
            ))
        );
    }

    /// Two consecutive `@@ <text>` lines used to fail parsing — the model
    /// reaches for them naturally to narrow into a function or block, and
    /// telemetry showed this as the dominant `parse` shape. Both anchors
    /// must end up in `change_contexts`, in order.
    #[test]
    fn stacked_anchors_collected_in_order() {
        let chunk = parse_update_file_chunk(
            &[
                "@@ impl Foo for Bar",
                "@@ fn baz(&self)",
                "-    return false;",
                "+    return true;",
                "*** End Patch",
            ],
            123,
            false,
        )
        .unwrap()
        .0;
        assert_eq!(
            chunk.change_contexts,
            vec!["impl Foo for Bar".to_string(), "fn baz(&self)".to_string()]
        );
        assert_eq!(chunk.old_lines, vec!["    return false;".to_string()]);
        assert_eq!(chunk.new_lines, vec!["    return true;".to_string()]);
    }

    /// Bare `@@` lines mixed into a stacked anchor sequence are consumed
    /// without contributing to `change_contexts` — they're a no-op marker.
    #[test]
    fn bare_at_in_stack_is_skipped() {
        let chunk = parse_update_file_chunk(
            &[
                "@@ impl Foo",
                "@@",
                "@@ fn bar()",
                "-old",
                "+new",
                "*** End Patch",
            ],
            1,
            false,
        )
        .unwrap()
        .0;
        assert_eq!(
            chunk.change_contexts,
            vec!["impl Foo".to_string(), "fn bar()".to_string()]
        );
    }

    /// Add-File body line without a `+` prefix gets a specific subkind so
    /// telemetry can break it out of the generic `parse` bucket. Common
    /// trigger: literal markdown frontmatter (`---`) right after `*** Add
    /// File:`.
    #[test]
    fn add_file_missing_plus_returns_specific_subkind() {
        let err = parse_patch_text(
            "*** Begin Patch\n\
             *** Add File: notes.md\n\
             ---\n\
             title: foo\n\
             ---\n\
             *** End Patch",
        )
        .unwrap_err();
        match err {
            ParseError::InvalidHunkError { kind, message, .. } => {
                assert_eq!(kind, ParseErrorKind::AddMissingPlus);
                assert!(message.contains("must start with '+'"), "msg: {message}");
            }
            other => panic!("expected InvalidHunkError, got {other:?}"),
        }
    }

    #[test]
    fn subkind_str_maps_each_kind() {
        let kinds = [
            (ParseErrorKind::AddMissingPlus, "parse_add_missing_plus"),
            (ParseErrorKind::UnprefixedLine, "parse_unprefixed_line"),
            (
                ParseErrorKind::MissingChunkHeader,
                "parse_missing_chunk_header",
            ),
            (ParseErrorKind::EmptyUpdate, "parse_empty_update"),
            (
                ParseErrorKind::UnknownHunkHeader,
                "parse_unknown_hunk_header",
            ),
            (ParseErrorKind::Other, "parse_other"),
        ];
        for (kind, want) in kinds {
            let err = ParseError::InvalidHunkError {
                message: "x".into(),
                line_number: 0,
                snippet: None,
                kind,
            };
            assert_eq!(err.subkind_str(), want);
        }
        assert_eq!(
            ParseError::InvalidPatchError("x".into()).subkind_str(),
            "parse_envelope"
        );
    }
}
