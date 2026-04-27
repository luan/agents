use std::io::Read;

use serde::Serialize;

use crate::cli::args::{
    LensAction, LensChecksAction, LensCleanupAction, LensDiagnosticsAction, LensRawOutputAction,
};
use crate::lens::{
    Diagnostic, DiagnosticSeverity, DiagnosticSource, LensEnvelope, LensStatusOptions, LensStore,
    build_status_envelope, retention,
};

pub fn run_lens(action: LensAction) -> Result<(), Box<dyn std::error::Error>> {
    match action {
        LensAction::Status {
            cwd,
            json,
            disk,
            debug,
            raw,
        } => status(cwd, json, disk, debug, raw),
        LensAction::Diagnostics { action } => diagnostics(action),
        LensAction::Checks { action } => checks(action),
        LensAction::Touched {
            cwd,
            session,
            turn,
            json,
        } => touched(cwd, session, turn, json),
        LensAction::Cleanup { action } => cleanup(action),
        LensAction::Health {
            cwd,
            session,
            turn,
            json,
            final_output,
        } => health(cwd, session, turn, json, final_output),
        LensAction::Context {
            cwd,
            session,
            turn,
            json,
            ack,
        } => context(cwd, session, turn, json, ack),
        LensAction::Report {
            cwd,
            session,
            turn,
            path,
            json,
        } => report(cwd, session, turn, path, json),
        LensAction::RawOutput { action } => raw_output(action),
        LensAction::Prune { cwd, json, dry_run } => prune(cwd, json, dry_run),
    }
}

fn status(
    cwd: Option<String>,
    json: bool,
    disk: bool,
    debug: bool,
    raw: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let root = cwd.map(Into::into).unwrap_or(std::env::current_dir()?);
    let envelope = build_status_envelope(
        &root,
        LensStatusOptions {
            include_disk: disk,
            include_debug: debug,
            include_raw: raw,
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

fn checks(action: LensChecksAction) -> Result<(), Box<dyn std::error::Error>> {
    match action {
        LensChecksAction::List { cwd, json } => {
            let root = cwd.map(Into::into).unwrap_or(std::env::current_dir()?);
            let envelope = crate::lens::list_checks_envelope(&root)?;
            if json {
                print_json(&envelope)?;
            } else {
                println!(
                    "{} checks, {} scanners configured",
                    envelope.data.configured_checks.len(),
                    envelope.data.configured_scanners.len()
                );
                for suggestion in &envelope.data.suggestions {
                    println!("suggested: {} ({})", suggestion.name, suggestion.command);
                }
            }
        }
        LensChecksAction::Run {
            cwd,
            json,
            automatic,
            all,
            name,
            scanners,
        } => {
            let root = cwd.map(Into::into).unwrap_or(std::env::current_dir()?);
            let envelope = crate::lens::run_checks_envelope(
                &root,
                crate::lens::LensCheckRunOptions {
                    automatic_only: automatic || !all && name.is_empty(),
                    names: name,
                    include_scanners: scanners || all,
                },
            )?;
            if json {
                print_json(&envelope)?;
            } else {
                for run in &envelope.data.runs {
                    println!(
                        "{} {}: {} ({} diagnostics)",
                        run.kind, run.name, run.status, run.diagnostic_count
                    );
                }
                for warning in &envelope.warnings {
                    println!("warning: {}", warning.message);
                }
            }
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
            all,
        } => {
            let root = cwd.map(Into::into).unwrap_or(std::env::current_dir()?);
            let store = LensStore::open_for_project(&root)?;
            let data = store.list_diagnostics_data(path.as_deref(), all)?;
            if json {
                print_json(&LensEnvelope::ok(data))?;
            } else {
                println!("{} diagnostics recorded", data.diagnostic_count);
                println!(
                    "deltas: {} new, {} resolved, {} unchanged",
                    data.deltas.new.len(),
                    data.deltas.resolved.len(),
                    data.deltas.unchanged.len()
                );
            }
        }
        LensDiagnosticsAction::Record {
            cwd,
            json,
            source,
            scope_kind,
            scope_key,
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
            let scope = diagnostic_scope(scope_kind, scope_key, path.as_deref());
            let fingerprint = fingerprint.unwrap_or_else(|| {
                crate::apply_patch::sha1_hex(
                    format!("{source}:{}:{}:{severity}:{path:?}:{start_line:?}:{end_line:?}:{code:?}:{message}", scope.kind, scope.key).as_bytes(),
                )
            });
            let diagnostic = Diagnostic {
                source: parse_source(&source),
                scope,
                severity: parse_severity(&severity)?,
                code,
                message,
                rel_path: path,
                start_line,
                end_line,
                fingerprint,
                content_hash: None,
                raw_output_id: None,
                snapshot_id: None,
                first_seen_at: None,
                last_seen_at: None,
                resolved_at: None,
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
        LensDiagnosticsAction::Snapshot { cwd, json } => {
            let root = cwd.map(Into::into).unwrap_or(std::env::current_dir()?);
            let mut input = String::new();
            std::io::stdin().read_to_string(&mut input)?;
            let snapshot: crate::lens::DiagnosticSnapshotInput = serde_json::from_str(&input)?;
            let mut store = LensStore::open_for_project(&root)?;
            let result = store.record_diagnostic_snapshot(snapshot)?;
            if json {
                print_json(&LensEnvelope::ok(result))?;
            } else {
                println!(
                    "diagnostic snapshot recorded: {} new, {} resolved, {} unchanged",
                    result.deltas.new.len(),
                    result.deltas.resolved.len(),
                    result.deltas.unchanged.len()
                );
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
        "security" => DiagnosticSource::Security,
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

fn diagnostic_scope(
    kind: Option<String>,
    key: Option<String>,
    path: Option<&str>,
) -> crate::lens::DiagnosticScope {
    match (kind.as_deref(), key) {
        (Some("file"), Some(key)) => crate::lens::DiagnosticScope::file(key),
        (Some("file"), None) => crate::lens::DiagnosticScope::file(path.unwrap_or_default()),
        (Some("command"), Some(key)) => crate::lens::DiagnosticScope::command(key),
        (Some(other), Some(key)) => crate::lens::DiagnosticScope {
            kind: other.to_string(),
            key,
        },
        (Some(other), None) => crate::lens::DiagnosticScope {
            kind: other.to_string(),
            key: String::new(),
        },
        (None, Some(key)) => crate::lens::DiagnosticScope {
            kind: "workspace".to_string(),
            key,
        },
        (None, None) => path
            .map(crate::lens::DiagnosticScope::file)
            .unwrap_or_else(crate::lens::DiagnosticScope::workspace),
    }
}

fn touched(
    cwd: Option<String>,
    session: String,
    turn: String,
    json: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let root = cwd.map(Into::into).unwrap_or(std::env::current_dir()?);
    let envelope = crate::lens::touched_files_envelope(&root, &session, &turn)?;
    if json {
        print_json(&envelope)?;
    } else {
        println!(
            "{} touched files for {}/{}",
            envelope.data.file_count, envelope.data.session, envelope.data.turn
        );
        for file in &envelope.data.files {
            println!("- {} ({:?})", file.path, file.source);
        }
    }
    Ok(())
}

fn cleanup(action: LensCleanupAction) -> Result<(), Box<dyn std::error::Error>> {
    let LensCleanupAction::Run {
        cwd,
        session,
        turn,
        json,
        allow_unsafe,
    } = action;
    let root = cwd.map(Into::into).unwrap_or(std::env::current_dir()?);
    let envelope = crate::lens::cleanup_turn_envelope(
        &root,
        &session,
        &turn,
        crate::lens::CleanupOptions {
            allow_unsafe,
            ..crate::lens::CleanupOptions::default()
        },
    )?;
    if json {
        print_json(&envelope)?;
    } else {
        println!(
            "cleanup: {} runs, {} mutations, {} diagnostic regressions",
            envelope.data.runs.len(),
            envelope.data.mutation_count,
            envelope.data.diagnostics.regression_count
        );
        for warning in &envelope.warnings {
            println!("warning: {}", warning.message);
        }
    }
    Ok(())
}

fn health(
    cwd: Option<String>,
    session: String,
    turn: String,
    json: bool,
    final_output: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let root = cwd.map(Into::into).unwrap_or(std::env::current_dir()?);
    let envelope = crate::lens::build_turn_health_envelope(
        &root,
        crate::lens::TurnHealthOptions {
            session,
            turn,
            acknowledge: false,
        },
    )?;
    if json {
        print_json(&envelope)?;
    } else if final_output {
        println!("{}", crate::lens::final_health_text(&envelope.data));
    } else {
        println!("{}", crate::lens::compact_health_text(&envelope.data));
        if envelope.data.action_context.required {
            println!(
                "action recommended: {}",
                envelope.data.action_context.instructions
            );
            if let Some(command) = &envelope.data.action_context.ack_command {
                println!("ack: {command}");
            }
        }
    }
    Ok(())
}

fn context(
    cwd: Option<String>,
    session: String,
    turn: String,
    json: bool,
    ack: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let root = cwd.map(Into::into).unwrap_or(std::env::current_dir()?);
    let envelope = crate::lens::build_action_context_envelope(
        &root,
        crate::lens::TurnHealthOptions {
            session,
            turn,
            acknowledge: ack,
        },
    )?;
    if json {
        print_json(&envelope)?;
    } else {
        println!("lens context: {}", envelope.data.state);
        println!("{}", envelope.data.reason);
        for action in &envelope.data.remediation {
            println!("remediate: {action}");
        }
        if let Some(command) = &envelope.data.ack_command {
            println!("ack: {command}");
        }
    }
    Ok(())
}

fn report(
    cwd: Option<String>,
    session: String,
    turn: String,
    path: Option<String>,
    json: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let root = cwd.map(Into::into).unwrap_or(std::env::current_dir()?);
    let envelope = crate::lens::build_changed_file_report_envelope(
        &root,
        crate::lens::TurnHealthOptions {
            session,
            turn,
            acknowledge: false,
        },
        path.as_deref(),
    )?;
    if json {
        print_json(&envelope)?;
    } else {
        println!(
            "lens report: {:?}, {} changed files",
            envelope.data.status, envelope.data.file_count
        );
        for file in &envelope.data.files {
            println!("- {}: {} diagnostics", file.path, file.diagnostics.len());
            for action in &file.next_actions {
                println!("  next: {action}");
            }
        }
    }
    Ok(())
}

fn raw_output(action: LensRawOutputAction) -> Result<(), Box<dyn std::error::Error>> {
    match action {
        LensRawOutputAction::List { cwd, limit, json } => {
            let root = cwd.map(Into::into).unwrap_or(std::env::current_dir()?);
            let envelope = crate::lens::raw_output::list_envelope(&root, limit)?;
            if json {
                print_json(&envelope)?;
            } else {
                println!("{} raw outputs retained", envelope.data.output_count);
                for output in &envelope.data.outputs {
                    println!(
                        "#{} {} {}:{} retained={}/{} redacted={} truncated={}",
                        output.id,
                        output.source,
                        output.scope.kind,
                        output.scope.key,
                        output.retained_bytes,
                        output.original_bytes,
                        output.redacted,
                        output.truncated
                    );
                }
            }
        }
        LensRawOutputAction::Show { id, cwd, json } => {
            let root = cwd.map(Into::into).unwrap_or(std::env::current_dir()?);
            let envelope = crate::lens::raw_output::show_envelope(&root, id)?;
            if json {
                print_json(&envelope)?;
            } else {
                println!(
                    "raw output #{} {} {}:{} retained={}/{} redacted={} truncated={}",
                    envelope.data.output.summary.id,
                    envelope.data.output.summary.source,
                    envelope.data.output.summary.scope.kind,
                    envelope.data.output.summary.scope.key,
                    envelope.data.output.summary.retained_bytes,
                    envelope.data.output.summary.original_bytes,
                    envelope.data.output.summary.redacted,
                    envelope.data.output.summary.truncated
                );
                println!("{}", envelope.data.output.body);
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
            "pruned: {} diagnostics, {} tool runs, {} sessions, {} patch drafts, {} patch draft bodies, {} raw outputs",
            report.diagnostics_deleted,
            report.tool_runs_deleted,
            report.sessions_deleted,
            report.patch_drafts_deleted,
            report.patch_draft_bodies_deleted,
            report.raw_outputs_deleted
        );
    }
    Ok(())
}

fn print_json<T: Serialize>(value: &T) -> Result<(), Box<dyn std::error::Error>> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}
