use std::io::Read;

use serde::Serialize;

use crate::cli::args::{LensAction, LensChecksAction, LensDiagnosticsAction};
use crate::lens::{
    Diagnostic, DiagnosticSeverity, DiagnosticSource, LensEnvelope, LensStatusOptions, LensStore,
    build_status_envelope,
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
        LensAction::Health {
            cwd,
            session,
            turn,
            json,
            final_output,
        } => health(cwd, session, turn, json, final_output),
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
                println!("{} diagnostics", data.diagnostic_count);
                println!(
                    "deltas: {} new, {} resolved, {} unchanged",
                    data.deltas.new.len(),
                    data.deltas.resolved.len(),
                    data.deltas.unchanged.len()
                );
                for diagnostic in &data.diagnostics {
                    println!("{}", format_diagnostic(diagnostic));
                }
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
        crate::lens::TurnHealthOptions { session, turn },
    )?;
    if json {
        print_json(&envelope)?;
    } else if final_output {
        println!("{}", crate::lens::final_health_text(&envelope.data));
    } else {
        println!("{}", crate::lens::compact_health_text(&envelope.data));
    }
    Ok(())
}

fn print_json<T: Serialize>(value: &T) -> Result<(), Box<dyn std::error::Error>> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

fn format_diagnostic(diagnostic: &Diagnostic) -> String {
    let severity = match diagnostic.severity {
        DiagnosticSeverity::Error => "error",
        DiagnosticSeverity::Warning => "warning",
        DiagnosticSeverity::Info => "info",
        DiagnosticSeverity::Hint => "hint",
    };
    let source = match &diagnostic.source {
        DiagnosticSource::Lsp => "lsp".to_string(),
        DiagnosticSource::AstGrep => "ast_grep".to_string(),
        DiagnosticSource::TreeSitter => "tree_sitter".to_string(),
        DiagnosticSource::Secrets => "secrets".to_string(),
        DiagnosticSource::Security => "security".to_string(),
        DiagnosticSource::Formatter => "formatter".to_string(),
        DiagnosticSource::Autofix => "autofix".to_string(),
        DiagnosticSource::Test => "test".to_string(),
        DiagnosticSource::Other(value) => value.clone(),
    };
    let location = diagnostic
        .rel_path
        .as_ref()
        .map(|path| match diagnostic.start_line {
            Some(line) => format!("{path}:{line}"),
            None => path.clone(),
        })
        .unwrap_or_else(|| format!("{}:{}", diagnostic.scope.kind, diagnostic.scope.key));
    let code = diagnostic
        .code
        .as_ref()
        .map(|code| format!(" [{code}]"))
        .unwrap_or_default();
    format!(
        "- {severity} {source}{code} {location}: {}",
        diagnostic.message
    )
}
