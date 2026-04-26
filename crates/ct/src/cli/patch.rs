use std::io::IsTerminal;
use std::io::Read;

use crate::cli::args::{PatchAction, PatchDraftAction};
use crate::lens::PatchDraftChunk;

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
    let (status, error_kind, error_message) = match crate::apply_patch::apply(&body, &root, true) {
        Ok(_) => ("applicable", None, None),
        Err(failure) => (
            "blocked",
            Some(crate::apply_patch::draft::error_kind(&failure.error).to_string()),
            Some(failure.error.to_string()),
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
    })?;
    print_out(
        json,
        &serde_json::json!({
            "patch_id": summary.id,
            "cwd": root,
            "status": summary.status,
            "body_bytes": summary.body_bytes,
            "stored": true,
            "chunks": chunks
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
            "chunks": store.patch_draft_chunks(patch_id)?
        }),
        None => serde_json::json!({
            "patch_id": patch_id,
            "status": "not_found",
            "chunks": []
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
    let chunks = store.patch_draft_chunks(patch_id)?;
    let selected = match chunk {
        Some(index) => chunks
            .into_iter()
            .filter(|item| item.chunk_index == index as i64)
            .collect::<Vec<_>>(),
        None => chunks,
    };
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
            "chunks": selected,
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
    print_out(
        json,
        &serde_json::json!({
            "patch_id": patch_id,
            "chunk": chunk,
            "anchor": anchor,
            "amended": false,
            "note": "patch draft chunk amendment is not wired yet"
        }),
    )
}

fn apply(patch_id: &str, json: bool) -> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::current_dir()?;
    let store = crate::lens::LensStore::open_for_project(&root)?;
    let Some(body) = store.patch_draft_body(patch_id)? else {
        return print_out(
            json,
            &serde_json::json!({ "patch_id": patch_id, "applied": false, "status": "not_found" }),
        );
    };
    match crate::apply_patch::apply(&body, &root, false) {
        Ok(outcome) => print_out(
            json,
            &serde_json::json!({
                "patch_id": patch_id,
                "applied": true,
                "status": "applied",
                "changes": outcome.changes
            }),
        ),
        Err(failure) => print_out(
            json,
            &serde_json::json!({
                "patch_id": patch_id,
                "applied": false,
                "status": "blocked",
                "error_kind": crate::apply_patch::draft::error_kind(&failure.error),
                "error": failure.error.to_string()
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

fn print_out(_json: bool, value: &serde_json::Value) -> Result<(), Box<dyn std::error::Error>> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}
