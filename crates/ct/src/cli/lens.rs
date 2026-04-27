use serde::Serialize;

use crate::cli::args::{
    GuardAction, LensAction, LensDiagnosticsAction, LensGuardAction, LensReadAction,
};
use crate::lens::{
    Diagnostic, DiagnosticSeverity, DiagnosticSource, LensEnvelope, LensGuardMode,
    LensStatusOptions, LensStore, RuntimePolicyOverrides, build_status_envelope, retention,
};

pub fn run_lens(action: LensAction) -> Result<(), Box<dyn std::error::Error>> {
    match action {
        LensAction::Status {
            cwd,
            json,
            disk,
            debug,
            raw,
            guard_mode,
        } => status(cwd, json, disk, debug, raw, guard_mode),
        LensAction::Diagnostics { action } => diagnostics(action),
        LensAction::Read { action } => read(action),
        LensAction::Guard { action } => guard(action),
        LensAction::Prune { cwd, json, dry_run } => prune(cwd, json, dry_run),
    }
}

fn status(
    cwd: Option<String>,
    json: bool,
    disk: bool,
    debug: bool,
    raw: bool,
    guard_mode: Option<GuardAction>,
) -> Result<(), Box<dyn std::error::Error>> {
    let root = cwd.map(Into::into).unwrap_or(std::env::current_dir()?);
    let envelope = build_status_envelope(
        &root,
        LensStatusOptions {
            include_disk: disk,
            include_debug: debug,
            include_raw: raw,
            runtime_policy: RuntimePolicyOverrides {
                guard_mode: guard_mode.map(cli_guard_mode),
                allow_overrides: None,
            },
            ..LensStatusOptions::default()
        },
    )?;
    if json {
        print_json(&envelope)?;
    } else {
        println!("lens status: {:?}", envelope.status);
        println!("lens db: {}", envelope.data.state.db_path);
        println!("project id: {}", envelope.data.project_id);
        println!("diagnostics: {}", envelope.data.state.counts.diagnostics);
        for warning in &envelope.warnings {
            println!("warning: {}", warning.message);
        }
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
                print_json(&LensEnvelope::ok(out))?;
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
                print_json(&LensEnvelope::ok(out))?;
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
        print_json(&LensEnvelope::ok(out))?;
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
                print_json(&LensEnvelope::ok(out))?;
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
                print_json(&LensEnvelope::ok(out))?;
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
    let policy = crate::lens::resolve_policy(&root);
    let report = retention::prune(&store, &policy.policy.retention, dry_run)?;
    if json {
        print_json(&LensEnvelope::ok(report))?;
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

fn cli_guard_mode(action: GuardAction) -> LensGuardMode {
    match action {
        GuardAction::Off => LensGuardMode::Off,
        GuardAction::Warn => LensGuardMode::Warn,
        GuardAction::Block => LensGuardMode::Block,
    }
}

fn print_json<T: Serialize>(value: &T) -> Result<(), Box<dyn std::error::Error>> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}
