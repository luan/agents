use std::io::Read;

use serde::Serialize;

use crate::cli::args::{
    GuardAction, LensAction, LensDiagnosticsAction, LensGuardAction, LensReadAction, LensTurnAction,
};
use crate::lens::{
    Diagnostic, DiagnosticSeverity, DiagnosticSource, DiscoveryIntent, DiscoveryOptions,
    LensEnvelope, LensGuardMode, LensStatusOptions, LensStore, RuntimePolicyOverrides,
    build_discovery_envelope, build_status_envelope, retention,
};

pub fn run_lens(action: LensAction) -> Result<(), Box<dyn std::error::Error>> {
    match action {
        LensAction::Discover {
            cwd,
            json,
            intent,
            query,
            path,
            line,
            end_line,
            character,
            lang,
            limit,
            context,
            session,
            lsp_operation,
            debug,
            raw,
        } => discover(DiscoverCliOptions {
            cwd,
            json,
            intent,
            query,
            path,
            line,
            end_line,
            character,
            lang,
            limit,
            context,
            session,
            lsp_operation,
            debug,
            raw,
        }),
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
        LensAction::Turn { action } => turn(action),
        LensAction::Prune { cwd, json, dry_run } => prune(cwd, json, dry_run),
    }
}

struct DiscoverCliOptions {
    cwd: Option<String>,
    json: bool,
    intent: String,
    query: Option<String>,
    path: Option<String>,
    line: Option<usize>,
    end_line: Option<usize>,
    character: Option<usize>,
    lang: Option<String>,
    limit: usize,
    context: usize,
    session: Option<String>,
    lsp_operation: Option<String>,
    debug: bool,
    raw: bool,
}

fn discover(options: DiscoverCliOptions) -> Result<(), Box<dyn std::error::Error>> {
    let root = options
        .cwd
        .map(Into::into)
        .unwrap_or(std::env::current_dir()?);
    let mut discovery_options =
        DiscoveryOptions::new(root, DiscoveryIntent::parse(&options.intent)?);
    discovery_options.query = options.query;
    discovery_options.path = options.path;
    discovery_options.line = options.line;
    discovery_options.end_line = options.end_line;
    discovery_options.character = options.character;
    discovery_options.lang = options.lang;
    discovery_options.limit = options.limit;
    discovery_options.context = options.context;
    discovery_options.session = options.session;
    discovery_options.lsp_operation = options.lsp_operation;
    discovery_options.include_debug = options.debug;
    discovery_options.include_raw = options.raw;
    let envelope = build_discovery_envelope(discovery_options)?;
    if options.json {
        print_json(&envelope)?;
    } else {
        println!(
            "lens discover: {} via {} ({} results)",
            envelope.data.route.intent, envelope.data.route.backend, envelope.data.item_count
        );
        for item in &envelope.data.items {
            println!("- {}", item.summary);
        }
        for warning in &envelope.warnings {
            println!("warning: {}", warning.message);
        }
        for action in &envelope.data.next_actions {
            println!("next: {}: {}", action.label, action.command);
        }
    }
    Ok(())
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

fn turn(action: LensTurnAction) -> Result<(), Box<dyn std::error::Error>> {
    match action {
        LensTurnAction::Record { cwd, json } => {
            let fallback_cwd = cwd.map(Into::into).unwrap_or(std::env::current_dir()?);
            let mut input = String::new();
            std::io::stdin().read_to_string(&mut input)?;
            let event: crate::lens::LensTurnEvent = serde_json::from_str(&input)?;
            let envelope = crate::lens::record_turn_event_envelope(&fallback_cwd, event)?;
            if json {
                print_json(&envelope)?;
            } else {
                println!(
                    "recorded {} touched files for {}/{}",
                    envelope.data.file_count, envelope.data.session, envelope.data.turn
                );
            }
        }
        LensTurnAction::Touched {
            cwd,
            session,
            turn,
            json,
        } => {
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
