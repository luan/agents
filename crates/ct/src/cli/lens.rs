use std::io::Read;

use serde::Serialize;

use crate::cli::args::{
    GuardAction, LensAction, LensChecksAction, LensCleanupAction, LensDiagnosticsAction,
    LensGuardAction, LensReadAction, LensTurnAction,
};
use crate::lens::{
    Diagnostic, DiagnosticSeverity, DiagnosticSource, DiscoveryIntent, DiscoveryOptions,
    LensEnvelope, LensGuardMode, LensResponseStatus, LensStatusOptions, LensStore,
    RuntimePolicyOverrides, build_discovery_envelope, build_status_envelope, retention,
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
        LensAction::Checks { action } => checks(action),
        LensAction::Read { action } => read(action),
        LensAction::Guard { action } => guard(action),
        LensAction::Turn { action } => turn(action),
        LensAction::Cleanup { action } => cleanup(action),
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
            let policy = crate::lens::resolve_policy(&root).policy.guard;
            let requested = effective_guard_action(policy.mode, mode, policy.allow_overrides)?;
            let mut store = LensStore::open_for_project(&root)?;
            let decision = store.check_guard_with_overrides(
                session.as_deref(),
                std::path::Path::new(&path),
                start_line,
                end_line,
                requested,
                policy.allow_overrides,
            )?;
            let envelope = guard_envelope(store.project_id(), session, decision);
            if json {
                print_json(&envelope)?;
            } else {
                print_guard_human(&envelope.data)?;
            }
        }
        LensGuardAction::AllowOnce {
            json,
            path,
            session,
        } => {
            let root = std::env::current_dir()?;
            let policy = crate::lens::resolve_policy(&root).policy.guard;
            if !policy.allow_overrides {
                let out = serde_json::json!({
                    "session": session,
                    "path": path,
                    "allowed_once": false,
                    "reason": "overrides_disabled"
                });
                let envelope = LensEnvelope::error(
                    out,
                    vec![crate::lens::LensMessage::error(
                        "guard_overrides_disabled",
                        "guard overrides are disabled by policy",
                    )],
                );
                if json {
                    print_json(&envelope)?;
                } else {
                    eprintln!("guard overrides are disabled by policy");
                }
                std::process::exit(2);
            }
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

fn effective_guard_action(
    policy_mode: LensGuardMode,
    requested: Option<GuardAction>,
    allow_overrides: bool,
) -> Result<crate::lens::GuardAction, Box<dyn std::error::Error>> {
    let action = requested.map(cli_guard_mode).unwrap_or(policy_mode);
    if !allow_overrides && guard_mode_rank(action) < guard_mode_rank(policy_mode) {
        return Err("guard mode override weakens policy but allow_overrides is false".into());
    }
    Ok(match action {
        LensGuardMode::Off => crate::lens::GuardAction::Allow,
        LensGuardMode::Warn => crate::lens::GuardAction::Warn,
        LensGuardMode::Block => crate::lens::GuardAction::Block,
    })
}

fn guard_mode_rank(mode: LensGuardMode) -> u8 {
    match mode {
        LensGuardMode::Off => 0,
        LensGuardMode::Warn => 1,
        LensGuardMode::Block => 2,
    }
}

fn guard_envelope(
    project_id: i64,
    session: Option<String>,
    decision: crate::lens::GuardDecision,
) -> LensEnvelope<serde_json::Value> {
    let status = match decision.decision {
        crate::lens::GuardAction::Allow => LensResponseStatus::Ok,
        crate::lens::GuardAction::Warn => LensResponseStatus::Warning,
        crate::lens::GuardAction::Block => LensResponseStatus::Error,
    };
    let code = serde_json::to_value(&decision.reason)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_else(|| "unknown".to_string());
    let message = crate::lens::LensMessage {
        code: format!("guard_{code}"),
        message: decision.message.clone(),
        hint: Some(
            "read the required range with ct lens read record or lens discover before editing"
                .to_string(),
        ),
    };
    let data = serde_json::json!({
        "project_id": project_id,
        "session": session,
        "guard": decision
    });
    match status {
        LensResponseStatus::Ok => LensEnvelope::ok(data),
        LensResponseStatus::Warning => LensEnvelope::warning(data, vec![message]),
        LensResponseStatus::Error => LensEnvelope::error(data, vec![message]),
    }
}

fn print_guard_human(envelope: &serde_json::Value) -> Result<(), Box<dyn std::error::Error>> {
    let guard = &envelope["guard"];
    println!(
        "{}: {} ({})",
        guard["decision"].as_str().unwrap_or("unknown"),
        guard["reason"].as_str().unwrap_or("unknown"),
        guard["message"].as_str().unwrap_or("")
    );
    println!("required: {}", guard["required_ranges"]);
    println!("covered: {}", guard["covered_ranges"]);
    if guard["stale_ranges"]
        .as_array()
        .is_some_and(|ranges| !ranges.is_empty())
    {
        println!("stale: {}", guard["stale_ranges"]);
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
