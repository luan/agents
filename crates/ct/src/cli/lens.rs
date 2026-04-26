use serde::Serialize;

use crate::cli::args::{
    GuardAction, LensAction, LensDiagnosticsAction, LensGuardAction, LensReadAction,
};
use crate::lens::{LensStore, retention};

pub fn run_lens(action: LensAction) -> Result<(), Box<dyn std::error::Error>> {
    match action {
        LensAction::Status { cwd, json, disk } => status(cwd, json, disk),
        LensAction::Diagnostics { action } => diagnostics(action),
        LensAction::Read { action } => read(action),
        LensAction::Guard { action } => guard(action),
        LensAction::Prune { cwd, json, dry_run } => prune(cwd, json, dry_run),
    }
}

fn status(cwd: Option<String>, json: bool, disk: bool) -> Result<(), Box<dyn std::error::Error>> {
    let root = cwd.map(Into::into).unwrap_or(std::env::current_dir()?);
    let store = LensStore::open_for_project(&root)?;
    let db_path = crate::lens::project_db_path(&root)?;
    let counts = store.counts()?;
    let bytes = if disk && db_path.exists() {
        Some(std::fs::metadata(&db_path)?.len())
    } else {
        None
    };
    let out = StatusOut {
        project_id: store.project_id(),
        db_path: db_path.display().to_string(),
        counts,
        db_bytes: bytes,
    };
    if json {
        println!("{}", serde_json::to_string_pretty(&out)?);
    } else {
        println!("lens db: {}", out.db_path);
        println!("project id: {}", out.project_id);
        println!("diagnostics: {}", out.counts.diagnostics);
    }
    Ok(())
}

fn diagnostics(action: LensDiagnosticsAction) -> Result<(), Box<dyn std::error::Error>> {
    let LensDiagnosticsAction::List {
        cwd,
        json,
        path: _,
        all: _,
    } = action;
    let root = cwd.map(Into::into).unwrap_or(std::env::current_dir()?);
    let store = LensStore::open_for_project(&root)?;
    let out = serde_json::json!({
        "project_id": store.project_id(),
        "diagnostics": [],
        "note": "diagnostic collection is not populated yet"
    });
    if json {
        println!("{}", serde_json::to_string_pretty(&out)?);
    } else {
        println!("no diagnostics recorded");
    }
    Ok(())
}

fn read(action: LensReadAction) -> Result<(), Box<dyn std::error::Error>> {
    let LensReadAction::Record {
        cwd,
        json,
        path,
        start_line,
        end_line,
        session,
    } = action;
    let root = cwd.map(Into::into).unwrap_or(std::env::current_dir()?);
    let store = LensStore::open_for_project(&root)?;
    let out = serde_json::json!({
        "project_id": store.project_id(),
        "session": session,
        "path": path,
        "range": { "start_line": start_line, "end_line": end_line },
        "recorded": false,
        "note": "read ledger storage is scaffolded but recording is not populated yet"
    });
    if json {
        println!("{}", serde_json::to_string_pretty(&out)?);
    } else {
        println!("read ledger scaffolded for {path}:{start_line}-{end_line}");
    }
    Ok(())
}

fn guard(action: LensGuardAction) -> Result<(), Box<dyn std::error::Error>> {
    match action {
        LensGuardAction::Check {
            cwd,
            json,
            path,
            start_line,
            end_line,
            session,
            mode,
        } => {
            let root = cwd.map(Into::into).unwrap_or(std::env::current_dir()?);
            let store = LensStore::open_for_project(&root)?;
            let decision = match mode {
                GuardAction::Off => "allow",
                GuardAction::Warn => "warn",
                GuardAction::Block => "block",
            };
            let out = serde_json::json!({
                "project_id": store.project_id(),
                "session": session,
                "decision": decision,
                "reason": "zero_read",
                "file": path,
                "required_ranges": [{ "start_line": start_line, "end_line": end_line }],
                "covered_ranges": []
            });
            if json {
                println!("{}", serde_json::to_string_pretty(&out)?);
            } else {
                println!("{decision}: zero_read");
            }
        }
        LensGuardAction::AllowOnce {
            json,
            path,
            session,
        } => {
            let out = serde_json::json!({ "session": session, "path": path, "allowed_once": false, "note": "override ledger is scaffolded but not populated yet" });
            if json {
                println!("{}", serde_json::to_string_pretty(&out)?);
            } else {
                println!("allow-once scaffolded for {path}");
            }
        }
    }
    Ok(())
}

fn prune(cwd: Option<String>, json: bool, dry_run: bool) -> Result<(), Box<dyn std::error::Error>> {
    let root = cwd.map(Into::into).unwrap_or(std::env::current_dir()?);
    let store = LensStore::open_for_project(&root)?;
    let report = retention::prune(&store, &retention::RetentionPolicy::default(), dry_run)?;
    if json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        println!(
            "pruned: {} diagnostics, {} tool runs, {} sessions, {} patch drafts, {} patch draft bodies",
            report.diagnostics_deleted,
            report.tool_runs_deleted,
            report.sessions_deleted,
            report.patch_drafts_deleted,
            report.patch_draft_bodies_deleted
        );
    }
    Ok(())
}

#[derive(Serialize)]
struct StatusOut {
    project_id: i64,
    db_path: String,
    counts: crate::lens::store::StoreCounts,
    db_bytes: Option<u64>,
}
