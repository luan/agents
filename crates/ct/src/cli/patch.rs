use std::io::IsTerminal;
use std::io::Read;

use crate::cli::args::{PatchAction, PatchDraftAction};

pub fn run_patch(action: PatchAction) -> Result<(), Box<dyn std::error::Error>> {
    match action {
        PatchAction::Draft { action } => run_draft(action),
    }
}

fn run_draft(action: PatchDraftAction) -> Result<(), Box<dyn std::error::Error>> {
    match action {
        PatchDraftAction::Create { cwd, json } => {
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
            let patch_id = crate::apply_patch::sha1_hex(body.as_bytes());
            let root = std::path::PathBuf::from(&cwd).canonicalize()?;
            let store = crate::lens::LensStore::open_for_project(&root)?;
            let status = match crate::apply_patch::apply(&body, &root, true) {
                Ok(_) => "applicable",
                Err(_) => "blocked",
            };
            let summary = store.create_patch_draft(
                &patch_id,
                &root.to_string_lossy(),
                None,
                status,
                &patch_id,
                &body,
            )?;
            let out = serde_json::json!({
                "patch_id": summary.id,
                "cwd": root,
                "status": summary.status,
                "body_bytes": summary.body_bytes,
                "stored": true
            });
            print_out(json, &out)?;
        }
        PatchDraftAction::Status { patch_id, json } => {
            let root = std::env::current_dir()?;
            let store = crate::lens::LensStore::open_for_project(&root)?;
            let out = match store.patch_draft_status(&patch_id)? {
                Some(summary) => serde_json::json!({
                    "patch_id": summary.id,
                    "status": summary.status,
                    "patch_sha": summary.patch_sha,
                    "body_bytes": summary.body_bytes,
                    "chunks": []
                }),
                None => serde_json::json!({
                    "patch_id": patch_id,
                    "status": "not_found",
                    "chunks": []
                }),
            };
            print_out(json, &out)?;
        }
        PatchDraftAction::Show {
            patch_id,
            chunk,
            json,
        } => {
            let out = serde_json::json!({
                "patch_id": patch_id,
                "chunk": chunk,
                "status": "not_found"
            });
            print_out(json, &out)?;
        }
        PatchDraftAction::Amend {
            patch_id,
            chunk,
            anchor,
            json,
        } => {
            let out = serde_json::json!({
                "patch_id": patch_id,
                "chunk": chunk,
                "anchor": anchor,
                "amended": false,
                "note": "patch draft amendments are scaffolded but not populated yet"
            });
            print_out(json, &out)?;
        }
        PatchDraftAction::Apply { patch_id, json } => {
            let out = serde_json::json!({
                "patch_id": patch_id,
                "applied": false,
                "status": "not_found"
            });
            print_out(json, &out)?;
        }
        PatchDraftAction::Discard { patch_id, json } => {
            let out = serde_json::json!({
                "patch_id": patch_id,
                "discarded": false,
                "status": "not_found"
            });
            print_out(json, &out)?;
        }
    }
    Ok(())
}

fn print_out(_json: bool, value: &serde_json::Value) -> Result<(), Box<dyn std::error::Error>> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}
