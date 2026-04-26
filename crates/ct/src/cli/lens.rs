use serde::Serialize;

use crate::cli::args::{
    GuardAction, LensAction, LensDiagnosticsAction, LensGuardAction, LensReadAction,
};
use crate::lens::{Diagnostic, DiagnosticSeverity, DiagnosticSource, LensStore, retention};

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
    match action {
        LensDiagnosticsAction::List {
            cwd,
            json,
            path,
            all: _,
        } => {
            let root = cwd.map(Into::into).unwrap_or(std::env::current_dir()?);
            let store = LensStore::open_for_project(&root)?;
            let diagnostics = store.list_diagnostics(path.as_deref())?;
            let out = serde_json::json!({
                "project_id": store.project_id(),
                "path": path,
                "diagnostics": diagnostics,
                "diagnostic_count": diagnostics.len()
            });
            if json {
                println!("{}", serde_json::to_string_pretty(&out)?);
            } else {
                println!("{} diagnostics recorded", diagnostics.len());
            }
        }
        LensDiagnosticsAction::Record {
            cwd,
            json,
            source,
            severity,
            path,
            code,
            message,
            start_line,
            end_line,
            fingerprint,
        } => {
            let root = cwd.map(Into::into).unwrap_or(std::env::current_dir()?);
            let mut store = LensStore::open_for_project(&root)?;
            let fingerprint = fingerprint.unwrap_or_else(|| {
                crate::apply_patch::sha1_hex(
                    format!("{source}:{severity}:{path:?}:{start_line:?}:{end_line:?}:{code:?}:{message}").as_bytes(),
                )
            });
            let diagnostic = Diagnostic {
                source: parse_source(&source),
                severity: parse_severity(&severity)?,
                code,
                message,
                rel_path: path,
                start_line,
                end_line,
                fingerprint,
                content_hash: None,
            };
            store.record_diagnostics(std::slice::from_ref(&diagnostic))?;
            let out = serde_json::json!({
                "project_id": store.project_id(),
                "recorded": true,
                "diagnostic": diagnostic
            });
            if json {
                println!("{}", serde_json::to_string_pretty(&out)?);
            } else {
                println!("diagnostic recorded");
            }
        }
    }
    Ok(())
}

fn parse_source(source: &str) -> DiagnosticSource {
    match source {
        "lsp" => DiagnosticSource::Lsp,
        "ast_grep" => DiagnosticSource::AstGrep,
        "tree_sitter" => DiagnosticSource::TreeSitter,
        "secrets" => DiagnosticSource::Secrets,
        "formatter" => DiagnosticSource::Formatter,
        "autofix" => DiagnosticSource::Autofix,
        "test" => DiagnosticSource::Test,
        other => DiagnosticSource::Other(other.to_string()),
    }
}

fn parse_severity(severity: &str) -> Result<DiagnosticSeverity, Box<dyn std::error::Error>> {
    match severity {
        "error" => Ok(DiagnosticSeverity::Error),
        "warning" => Ok(DiagnosticSeverity::Warning),
        "info" => Ok(DiagnosticSeverity::Info),
        "hint" => Ok(DiagnosticSeverity::Hint),
        other => Err(format!("invalid diagnostic severity: {other}").into()),
    }
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
    let mut store = LensStore::open_for_project(&root)?;
    let range = store.record_read(
        session.as_deref(),
        std::path::Path::new(&path),
        start_line,
        end_line,
    )?;
    let out = serde_json::json!({
        "project_id": store.project_id(),
        "session": session,
        "path": path,
        "range": range,
        "recorded": true
    });
    if json {
        println!("{}", serde_json::to_string_pretty(&out)?);
    } else {
        println!(
            "recorded read for {path}:{}-{}",
            range.start_line, range.end_line
        );
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
            let mut store = LensStore::open_for_project(&root)?;
            let requested = match mode {
                GuardAction::Off => crate::lens::GuardAction::Allow,
                GuardAction::Warn => crate::lens::GuardAction::Warn,
                GuardAction::Block => crate::lens::GuardAction::Block,
            };
            let decision = store.check_guard(
                session.as_deref(),
                std::path::Path::new(&path),
                start_line,
                end_line,
                requested,
            )?;
            let out = serde_json::json!({
                "project_id": store.project_id(),
                "session": session,
                "decision": decision.decision,
                "reason": decision.reason,
                "file": decision.file,
                "required_ranges": decision.required_ranges,
                "covered_ranges": decision.covered_ranges
            });
            if json {
                println!("{}", serde_json::to_string_pretty(&out)?);
            } else {
                println!("{:?}: {:?}", decision.decision, decision.reason);
            }
        }
        LensGuardAction::AllowOnce {
            json,
            path,
            session,
        } => {
            let root = std::env::current_dir()?;
            let store = LensStore::open_for_project(&root)?;
            store.allow_once(session.as_deref(), std::path::Path::new(&path))?;
            let out = serde_json::json!({ "session": session, "path": path, "allowed_once": true });
            if json {
                println!("{}", serde_json::to_string_pretty(&out)?);
            } else {
                println!("allow-once recorded for {path}");
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
