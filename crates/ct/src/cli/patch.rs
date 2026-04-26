use std::io::IsTerminal;
use std::io::Read;

use crate::cli::args::{PatchAction, PatchDraftAction};
use crate::lens::{PatchCandidate, PatchDraftChunk};

pub fn run_patch(action: PatchAction) -> Result<(), Box<dyn std::error::Error>> {
    match action {
        PatchAction::Draft { action } => run_draft(action),
    }
}

fn run_draft(action: PatchDraftAction) -> Result<(), Box<dyn std::error::Error>> {
    match action {
        PatchDraftAction::Create { cwd, json } => create(cwd, json),
        PatchDraftAction::Status { patch_id, json } => status(&patch_id, json),
        PatchDraftAction::Show {
            patch_id,
            chunk,
            json,
        } => show(&patch_id, chunk, json),
        PatchDraftAction::Amend {
            patch_id,
            chunk,
            anchor,
            json,
        } => amend(&patch_id, chunk, anchor, json),
        PatchDraftAction::Apply { patch_id, json } => apply(&patch_id, json),
        PatchDraftAction::Discard { patch_id, json } => discard(&patch_id, json),
    }
}

fn create(cwd: Option<String>, json: bool) -> Result<(), Box<dyn std::error::Error>> {
    if std::io::stdin().is_terminal() {
        eprintln!("patch draft create: expected patch on stdin");
        std::process::exit(1);
    }
    let mut body = String::new();
    std::io::stdin()
        .lock()
        .take(crate::apply_patch::MAX_PATCH_SIZE_BYTES as u64 + 1)
        .read_to_string(&mut body)?;
    if body.len() > crate::apply_patch::MAX_PATCH_SIZE_BYTES {
        eprintln!(
            "patch draft create: patch exceeds {} byte limit",
            crate::apply_patch::MAX_PATCH_SIZE_BYTES
        );
        std::process::exit(1);
    }

    let cwd = cwd.unwrap_or_else(|| ".".to_string());
    let root = std::path::PathBuf::from(&cwd).canonicalize()?;
    let patch_id = crate::apply_patch::sha1_hex(body.as_bytes());
    let mut chunks = draft_chunks(&body)?;
    let (status, error_kind, error_message, candidates) =
        match crate::apply_patch::apply(&body, &root, true) {
            Ok(_) => ("applicable", None, None, Vec::new()),
            Err(failure) => (
                "blocked",
                Some(crate::apply_patch::draft::error_kind(&failure.error).to_string()),
                Some(failure.error.to_string()),
                patch_candidates(&failure.error, &root),
            ),
        };
    for chunk in &mut chunks {
        chunk.status = status.to_string();
        if status == "blocked" {
            chunk.error_kind = error_kind.clone();
            chunk.error_message = error_message.clone();
        }
    }

    let mut store = crate::lens::LensStore::open_for_project(&root)?;
    let summary = store.create_patch_draft(crate::lens::store::NewPatchDraft {
        id: &patch_id,
        cwd: &root.to_string_lossy(),
        session_id: None,
        status,
        patch_sha: &patch_id,
        body: &body,
        chunks: &chunks,
        candidates: &candidates,
    })?;
    print_out(
        json,
        &serde_json::json!({
            "patch_id": summary.id,
            "cwd": root,
            "status": summary.status,
            "body_bytes": summary.body_bytes,
            "stored": true,
            "chunks": chunks,
            "candidates": candidates
        }),
    )
}

fn status(patch_id: &str, json: bool) -> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::current_dir()?;
    let store = crate::lens::LensStore::open_for_project(&root)?;
    let out = match store.patch_draft_status(patch_id)? {
        Some(summary) => serde_json::json!({
            "patch_id": summary.id,
            "status": summary.status,
            "patch_sha": summary.patch_sha,
            "body_bytes": summary.body_bytes,
            "chunks": store.patch_draft_chunks(patch_id)?,
            "candidates": store.patch_draft_candidates(patch_id)?
        }),
        None => serde_json::json!({
            "patch_id": patch_id,
            "status": "not_found",
            "chunks": [],
            "candidates": []
        }),
    };
    print_out(json, &out)
}

fn show(
    patch_id: &str,
    chunk: Option<usize>,
    json: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::current_dir()?;
    let store = crate::lens::LensStore::open_for_project(&root)?;
    let chunks = select_chunk(store.patch_draft_chunks(patch_id)?, chunk);
    let candidates = select_candidate(store.patch_draft_candidates(patch_id)?, chunk);
    let body = if chunk.is_none() {
        store.patch_draft_body(patch_id)?
    } else {
        None
    };
    print_out(
        json,
        &serde_json::json!({
            "patch_id": patch_id,
            "chunk": chunk,
            "chunks": chunks,
            "candidates": candidates,
            "body": body
        }),
    )
}

fn amend(
    patch_id: &str,
    chunk: usize,
    anchor: Option<String>,
    json: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::current_dir()?;
    let store = crate::lens::LensStore::open_for_project(&root)?;
    let Some(body) = store.patch_draft_body(patch_id)? else {
        return print_out(
            json,
            &serde_json::json!({
                "patch_id": patch_id,
                "chunk": chunk,
                "amended": false,
                "status": "not_found"
            }),
        );
    };
    let anchor = anchor.ok_or("patch draft amend currently requires --anchor")?;
    let amended_body = amend_chunk_anchor(&body, chunk, &anchor)?;
    let new_patch_id = crate::apply_patch::sha1_hex(amended_body.as_bytes());
    let mut chunks = draft_chunks(&amended_body)?;
    let (status, error_kind, error_message, candidates) =
        match crate::apply_patch::apply(&amended_body, &root, true) {
            Ok(_) => ("applicable", None, None, Vec::new()),
            Err(failure) => (
                "blocked",
                Some(crate::apply_patch::draft::error_kind(&failure.error).to_string()),
                Some(failure.error.to_string()),
                patch_candidates(&failure.error, &root),
            ),
        };
    for chunk in &mut chunks {
        chunk.status = status.to_string();
        if status == "blocked" {
            chunk.error_kind = error_kind.clone();
            chunk.error_message = error_message.clone();
        }
    }
    let mut store = crate::lens::LensStore::open_for_project(&root)?;
    let summary = store.create_patch_draft(crate::lens::store::NewPatchDraft {
        id: &new_patch_id,
        cwd: &root.to_string_lossy(),
        session_id: None,
        status,
        patch_sha: &new_patch_id,
        body: &amended_body,
        chunks: &chunks,
        candidates: &candidates,
    })?;
    print_out(
        json,
        &serde_json::json!({
            "patch_id": patch_id,
            "new_patch_id": summary.id,
            "chunk": chunk,
            "anchor": anchor,
            "amended": true,
            "status": summary.status,
            "body_bytes": summary.body_bytes,
            "chunks": chunks,
            "candidates": candidates
        }),
    )
}

fn apply(patch_id: &str, json: bool) -> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::current_dir()?;
    let mut store = crate::lens::LensStore::open_for_project(&root)?;
    let Some(body) = store.patch_draft_body(patch_id)? else {
        return print_out(
            json,
            &serde_json::json!({ "patch_id": patch_id, "applied": false, "status": "not_found" }),
        );
    };
    match crate::apply_patch::apply(&body, &root, false) {
        Ok(outcome) => {
            store.record_applied_changes(None, "ct_patch_draft", &outcome.changes)?;
            print_out(
                json,
                &serde_json::json!({
                    "patch_id": patch_id,
                    "applied": true,
                    "status": "applied",
                    "changes": outcome.changes
                }),
            )
        }
        Err(failure) => print_out(
            json,
            &serde_json::json!({
                "patch_id": patch_id,
                "applied": false,
                "status": "blocked",
                "error_kind": crate::apply_patch::draft::error_kind(&failure.error),
                "error": failure.error.to_string(),
                "candidates": patch_candidates(&failure.error, &root)
            }),
        ),
    }
}

fn discard(patch_id: &str, json: bool) -> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::current_dir()?;
    let store = crate::lens::LensStore::open_for_project(&root)?;
    let discarded = store.discard_patch_draft(patch_id)?;
    print_out(
        json,
        &serde_json::json!({
            "patch_id": patch_id,
            "discarded": discarded,
            "status": if discarded { "discarded" } else { "not_found" }
        }),
    )
}

fn select_chunk(chunks: Vec<PatchDraftChunk>, chunk: Option<usize>) -> Vec<PatchDraftChunk> {
    match chunk {
        Some(index) => chunks
            .into_iter()
            .filter(|item| item.chunk_index == index as i64)
            .collect(),
        None => chunks,
    }
}

fn select_candidate(candidates: Vec<PatchCandidate>, chunk: Option<usize>) -> Vec<PatchCandidate> {
    match chunk {
        Some(index) => candidates
            .into_iter()
            .filter(|item| item.chunk_index == index as i64)
            .collect(),
        None => candidates,
    }
}

fn draft_chunks(body: &str) -> Result<Vec<PatchDraftChunk>, Box<dyn std::error::Error>> {
    Ok(crate::apply_patch::draft::chunk_plan(body)?
        .into_iter()
        .map(|chunk| PatchDraftChunk {
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
        })
        .collect())
}

fn amend_chunk_anchor(
    body: &str,
    target_chunk: usize,
    anchor: &str,
) -> Result<String, Box<dyn std::error::Error>> {
    let anchor = normalize_anchor(anchor)?;
    let mut lines = body.lines().map(str::to_string).collect::<Vec<_>>();
    let mut chunk_index = 0_usize;
    let mut i = 0_usize;
    while i < lines.len() {
        let line = lines[i].as_str();
        if line.starts_with("*** Add File: ") {
            if chunk_index == target_chunk {
                return Err("cannot add an anchor to an add-file chunk".into());
            }
            chunk_index += 1;
            i += 1;
            while i < lines.len() && !is_hunk_header(&lines[i]) {
                i += 1;
            }
            continue;
        }
        if line.starts_with("*** Delete File: ") {
            if chunk_index == target_chunk {
                return Err("cannot add an anchor to a delete-file chunk".into());
            }
            chunk_index += 1;
            i += 1;
            continue;
        }
        if line.starts_with("*** Update File: ") {
            i += 1;
            if i < lines.len() && lines[i].starts_with("*** Move to: ") {
                if chunk_index == target_chunk {
                    return Err("cannot add an anchor to a pure move chunk".into());
                }
                i += 1;
            }
            while i < lines.len() && !is_hunk_header(&lines[i]) && lines[i] != "*** End Patch" {
                let insert_at = i;
                while i < lines.len() && lines[i].starts_with("@@") {
                    i += 1;
                }
                if i >= lines.len() || is_hunk_header(&lines[i]) || lines[i] == "*** End Patch" {
                    break;
                }
                if chunk_index == target_chunk {
                    lines.insert(insert_at, anchor);
                    return Ok(lines.join("\n") + "\n");
                }
                chunk_index += 1;
                while i < lines.len()
                    && !lines[i].starts_with("@@")
                    && !is_hunk_header(&lines[i])
                    && lines[i] != "*** End Patch"
                {
                    i += 1;
                }
            }
            continue;
        }
        i += 1;
    }
    Err(format!("chunk {target_chunk} not found").into())
}

fn normalize_anchor(anchor: &str) -> Result<String, Box<dyn std::error::Error>> {
    let anchor = anchor.trim();
    if anchor.is_empty() {
        return Err("anchor cannot be empty".into());
    }
    if anchor == "@@" {
        return Err("anchor must include context after @@".into());
    }
    let anchor = anchor.strip_prefix("@@").unwrap_or(anchor).trim();
    Ok(format!("@@ {anchor}"))
}

fn is_hunk_header(line: &str) -> bool {
    line.starts_with("*** Add File: ")
        || line.starts_with("*** Delete File: ")
        || line.starts_with("*** Update File: ")
}

fn patch_candidates(
    error: &crate::apply_patch::ApplyPatchError,
    root: &std::path::Path,
) -> Vec<PatchCandidate> {
    let crate::apply_patch::ApplyPatchError::AmbiguousContext {
        path,
        chunk,
        candidates,
        ..
    } = error
    else {
        return Vec::new();
    };
    let abs = root.join(path);
    let Ok(content) = std::fs::read_to_string(&abs) else {
        return candidates
            .iter()
            .map(|line| simple_candidate(*chunk as i64, *line as i64, None))
            .collect();
    };
    let lines = content.lines().collect::<Vec<_>>();
    let sym_store = sym_store(root).ok();
    candidates
        .iter()
        .map(|line| {
            semantic_candidate(
                *chunk as i64,
                *line as i64,
                &lines,
                sym_store.as_ref(),
                &abs,
            )
        })
        .collect()
}

fn semantic_candidate(
    chunk_index: i64,
    line: i64,
    lines: &[&str],
    sym_store: Option<&sym::store::Store>,
    abs_path: &std::path::Path,
) -> PatchCandidate {
    if let Some(candidate) = sym_candidate(chunk_index, line, sym_store, abs_path, lines) {
        return candidate;
    }
    let idx = line.saturating_sub(1) as usize;
    let start = idx.saturating_sub(40);
    for cursor in (start..=idx.min(lines.len().saturating_sub(1))).rev() {
        let trimmed = lines[cursor].trim();
        if looks_like_symbol_anchor(trimmed) {
            return PatchCandidate {
                chunk_index,
                line,
                suggested_anchor: Some(format!("@@ {trimmed}")),
                enclosing_symbol: symbol_name(trimmed),
                enclosing_kind: symbol_kind(trimmed).map(str::to_string),
                symbol_start: Some((cursor + 1) as i64),
                symbol_end: None,
            };
        }
    }
    let anchor = lines.get(idx).map(|line| format!("@@ {}", line.trim()));
    simple_candidate(chunk_index, line, anchor)
}

fn sym_store(root: &std::path::Path) -> anyhow::Result<sym::store::Store> {
    let db_path = sym::repo::configured_db_path(root, None)?;
    sym::indexer::ensure_fresh(root, &db_path)?;
    sym::store::Store::open(&db_path)
}

fn sym_candidate(
    chunk_index: i64,
    line: i64,
    store: Option<&sym::store::Store>,
    abs_path: &std::path::Path,
    lines: &[&str],
) -> Option<PatchCandidate> {
    let symbol = store?
        .enclosing_symbol_detail(&abs_path.to_string_lossy(), line as usize)
        .ok()??;
    let source_anchor = lines
        .get(symbol.start_line.saturating_sub(1))
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .map(|line| format!("@@ {line}"));
    Some(PatchCandidate {
        chunk_index,
        line,
        suggested_anchor: source_anchor
            .or_else(|| (!symbol.signature.is_empty()).then(|| format!("@@ {}", symbol.signature))),
        enclosing_symbol: Some(symbol.name),
        enclosing_kind: Some(symbol.kind),
        symbol_start: Some(symbol.start_line as i64),
        symbol_end: Some(symbol.end_line as i64),
    })
}

fn simple_candidate(
    chunk_index: i64,
    line: i64,
    suggested_anchor: Option<String>,
) -> PatchCandidate {
    PatchCandidate {
        chunk_index,
        line,
        suggested_anchor,
        enclosing_symbol: None,
        enclosing_kind: None,
        symbol_start: None,
        symbol_end: None,
    }
}

fn looks_like_symbol_anchor(line: &str) -> bool {
    line.starts_with("fn ")
        || line.starts_with("pub fn ")
        || line.starts_with("async fn ")
        || line.starts_with("pub async fn ")
        || line.starts_with("impl ")
        || line.starts_with("class ")
        || line.starts_with("function ")
        || line.starts_with("export function ")
}

fn symbol_kind(line: &str) -> Option<&'static str> {
    if line.contains("fn ") || line.contains("function ") {
        Some("function")
    } else if line.starts_with("impl ") {
        Some("impl")
    } else if line.starts_with("class ") {
        Some("class")
    } else {
        None
    }
}

fn symbol_name(line: &str) -> Option<String> {
    for marker in ["fn ", "function ", "class ", "impl "] {
        if let Some(rest) = line.split_once(marker).map(|(_, rest)| rest) {
            return rest
                .split(|ch: char| !(ch.is_alphanumeric() || ch == '_'))
                .find(|part| !part.is_empty())
                .map(str::to_string);
        }
    }
    None
}

fn print_out(_json: bool, value: &serde_json::Value) -> Result<(), Box<dyn std::error::Error>> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}
