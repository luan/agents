use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::contract::{LensEnvelope, LensMessage};
use super::policy::{LensCheckConfig, LensCheckParser, LensScannerConfig, resolve_policy};
use super::store::LensStore;
use super::types::{
    Diagnostic, DiagnosticScope, DiagnosticSeverity, DiagnosticSnapshotInput,
    DiagnosticSnapshotMetadata, DiagnosticSnapshotResult, DiagnosticSource,
};

#[derive(Debug, Clone, Default)]
pub struct LensCheckRunOptions {
    pub automatic_only: bool,
    pub names: Vec<String>,
    pub include_scanners: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LensChecksData {
    pub project_id: i64,
    pub configured_checks: Vec<LensConfiguredCheckSummary>,
    pub configured_scanners: Vec<LensConfiguredCheckSummary>,
    pub suggestions: Vec<LensCheckSuggestion>,
    pub runs: Vec<LensCheckRunSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LensConfiguredCheckSummary {
    pub name: String,
    pub kind: String,
    pub command: String,
    pub scope: String,
    pub automatic: bool,
    pub timeout_ms: u64,
    pub parser: LensCheckParser,
    pub raw_output_max_bytes: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LensCheckSuggestion {
    pub name: String,
    pub command: String,
    pub reason: String,
    pub hint: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LensCheckRunSummary {
    pub name: String,
    pub kind: String,
    pub command: String,
    pub scope: DiagnosticScope,
    pub automatic: bool,
    pub status: String,
    pub exit_code: Option<i64>,
    pub duration_ms: u64,
    pub diagnostic_count: usize,
    pub snapshot: Option<DiagnosticSnapshotResult>,
    pub message: Option<String>,
}

struct RunnableConfig<'a> {
    name: &'a str,
    kind: &'static str,
    command: &'a str,
    config_scope: &'a str,
    automatic: bool,
    timeout_ms: u64,
    parser: LensCheckParser,
    raw_output_max_bytes: Option<usize>,
    source: DiagnosticSource,
}

struct CommandOutcome {
    status: String,
    exit_code: Option<i64>,
    duration_ms: u64,
    stdout: String,
    stderr: String,
    message: Option<String>,
}

pub fn list_checks_envelope(
    root: &Path,
) -> Result<LensEnvelope<LensChecksData>, Box<dyn std::error::Error>> {
    let policy = resolve_policy(root).policy;
    let store = LensStore::open_for_project(root)?;
    let data = LensChecksData {
        project_id: store.project_id(),
        configured_checks: configured_check_summaries(&policy.checks),
        configured_scanners: configured_scanner_summaries(&policy.scanners),
        suggestions: detected_suggestions(root, &policy.checks),
        runs: Vec::new(),
    };
    let warnings = check_warnings(&data);
    if warnings.is_empty() {
        Ok(LensEnvelope::ok(data))
    } else {
        Ok(LensEnvelope::warning(data, warnings))
    }
}

pub fn planned_turn_checks_envelope(
    root: &Path,
) -> Result<LensEnvelope<LensChecksData>, Box<dyn std::error::Error>> {
    let policy = resolve_policy(root).policy;
    let store = LensStore::open_for_project(root)?;
    Ok(LensEnvelope::ok(LensChecksData {
        project_id: store.project_id(),
        configured_checks: configured_check_summaries(&policy.checks)
            .into_iter()
            .filter(|check| check.automatic)
            .collect(),
        configured_scanners: configured_scanner_summaries(&policy.scanners)
            .into_iter()
            .filter(|scanner| scanner.automatic)
            .collect(),
        suggestions: detected_suggestions(root, &policy.checks),
        runs: Vec::new(),
    }))
}

pub fn run_checks_envelope(
    root: &Path,
    options: LensCheckRunOptions,
) -> Result<LensEnvelope<LensChecksData>, Box<dyn std::error::Error>> {
    let policy = resolve_policy(root).policy;
    let mut store = LensStore::open_for_project(root)?;
    let suggestions = detected_suggestions(root, &policy.checks);
    let configured_checks = configured_check_summaries(&policy.checks);
    let configured_scanners = configured_scanner_summaries(&policy.scanners);
    let mut runs = Vec::new();

    for (name, config) in &policy.checks {
        if should_run(name, config.automatic, &options) {
            runs.push(run_one(
                root,
                &mut store,
                RunnableConfig {
                    name,
                    kind: "check",
                    command: &config.command,
                    config_scope: &config.scope,
                    automatic: config.automatic,
                    timeout_ms: config.timeout_ms,
                    parser: config.parser,
                    raw_output_max_bytes: config.raw_output_max_bytes,
                    source: DiagnosticSource::Test,
                },
            )?);
        }
    }

    if options.include_scanners {
        for (name, config) in &policy.scanners {
            if should_run(name, config.automatic, &options) {
                runs.push(run_one(
                    root,
                    &mut store,
                    RunnableConfig {
                        name,
                        kind: "scanner",
                        command: &config.command,
                        config_scope: &config.scope,
                        automatic: config.automatic,
                        timeout_ms: config.timeout_ms,
                        parser: config.parser,
                        raw_output_max_bytes: config.raw_output_max_bytes,
                        source: scanner_source(&config.source),
                    },
                )?);
            }
        }
    }

    let project_id = store.project_id();
    let data = LensChecksData {
        project_id,
        configured_checks,
        configured_scanners,
        suggestions,
        runs,
    };
    let warnings = check_warnings(&data);
    if warnings.is_empty() {
        Ok(LensEnvelope::ok(data))
    } else {
        Ok(LensEnvelope::warning(data, warnings))
    }
}

pub fn automatic_turn_checks_envelope(
    root: &Path,
) -> Result<LensEnvelope<LensChecksData>, Box<dyn std::error::Error>> {
    run_checks_envelope(
        root,
        LensCheckRunOptions {
            automatic_only: true,
            names: Vec::new(),
            include_scanners: true,
        },
    )
}

fn should_run(name: &str, automatic: bool, options: &LensCheckRunOptions) -> bool {
    if !options.names.is_empty() {
        return options.names.iter().any(|wanted| wanted == name);
    }
    !options.automatic_only || automatic
}

fn configured_check_summaries(
    checks: &BTreeMap<String, LensCheckConfig>,
) -> Vec<LensConfiguredCheckSummary> {
    checks
        .iter()
        .map(|(name, config)| check_summary(name, "check", config))
        .collect()
}

fn configured_scanner_summaries(
    scanners: &BTreeMap<String, LensScannerConfig>,
) -> Vec<LensConfiguredCheckSummary> {
    scanners
        .iter()
        .map(|(name, config)| scanner_summary(name, config))
        .collect()
}

fn check_summary(name: &str, kind: &str, config: &LensCheckConfig) -> LensConfiguredCheckSummary {
    LensConfiguredCheckSummary {
        name: name.to_string(),
        kind: kind.to_string(),
        command: config.command.clone(),
        scope: config.scope.clone(),
        automatic: config.automatic,
        timeout_ms: config.timeout_ms,
        parser: config.parser,
        raw_output_max_bytes: config.raw_output_max_bytes,
    }
}

fn scanner_summary(name: &str, config: &LensScannerConfig) -> LensConfiguredCheckSummary {
    LensConfiguredCheckSummary {
        name: name.to_string(),
        kind: "scanner".to_string(),
        command: config.command.clone(),
        scope: config.scope.clone(),
        automatic: config.automatic,
        timeout_ms: config.timeout_ms,
        parser: config.parser,
        raw_output_max_bytes: config.raw_output_max_bytes,
    }
}

fn run_one(
    root: &Path,
    store: &mut LensStore,
    config: RunnableConfig<'_>,
) -> Result<LensCheckRunSummary, Box<dyn std::error::Error>> {
    let scope = run_scope(config.kind, config.name, config.config_scope);
    if let Some(missing) = missing_command(root, config.command) {
        return Ok(LensCheckRunSummary {
            name: config.name.to_string(),
            kind: config.kind.to_string(),
            command: config.command.to_string(),
            scope,
            automatic: config.automatic,
            status: "missing_tool".to_string(),
            exit_code: None,
            duration_ms: 0,
            diagnostic_count: 0,
            snapshot: None,
            message: Some(format!("required tool '{missing}' is not available")),
        });
    }

    let outcome = run_command(
        root,
        config.command,
        effective_timeout_ms(config.timeout_ms),
    );
    let raw = join_raw_output(&outcome.stdout, &outcome.stderr);
    let diagnostics = parse_diagnostics(DiagnosticParseInput {
        name: config.name,
        kind: config.kind,
        parser: config.parser,
        source: config.source.clone(),
        scope: scope.clone(),
        exit_code: outcome.exit_code,
        stdout: &outcome.stdout,
        stderr: &outcome.stderr,
    });
    let diagnostic_count = diagnostics.len();
    let snapshot = store.record_diagnostic_snapshot(DiagnosticSnapshotInput {
        source: config.source,
        scope: scope.clone(),
        diagnostics,
        raw_output: Some(raw),
        raw_output_max_bytes: config.raw_output_max_bytes,
        metadata: DiagnosticSnapshotMetadata {
            command: Some(config.command.to_string()),
            exit_code: outcome.exit_code,
            duration_ms: Some(outcome.duration_ms),
        },
    })?;

    Ok(LensCheckRunSummary {
        name: config.name.to_string(),
        kind: config.kind.to_string(),
        command: config.command.to_string(),
        scope,
        automatic: config.automatic,
        status: outcome.status,
        exit_code: outcome.exit_code,
        duration_ms: outcome.duration_ms,
        diagnostic_count,
        snapshot: Some(snapshot),
        message: outcome.message,
    })
}

fn effective_timeout_ms(timeout: u64) -> u64 {
    if timeout < 1_000 {
        timeout.saturating_mul(1_000)
    } else {
        timeout
    }
}

fn run_scope(kind: &str, name: &str, config_scope: &str) -> DiagnosticScope {
    let key = if config_scope.trim().is_empty() || config_scope == "workspace" {
        name.to_string()
    } else {
        format!("{name}:{}", config_scope.trim())
    };
    match kind {
        "scanner" => DiagnosticScope::scanner(key),
        _ => DiagnosticScope::check(key),
    }
}

fn run_command(root: &Path, command: &str, timeout_ms: u64) -> CommandOutcome {
    let start = Instant::now();
    let mut child = match Command::new("sh")
        .arg("-c")
        .arg(command)
        .current_dir(root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            return CommandOutcome {
                status: "missing_tool".to_string(),
                exit_code: None,
                duration_ms: 0,
                stdout: String::new(),
                stderr: String::new(),
                message: Some(error.to_string()),
            };
        }
    };

    let timeout = Duration::from_millis(timeout_ms);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let output = child.wait_with_output().ok();
                    return CommandOutcome {
                        status: "timed_out".to_string(),
                        exit_code: None,
                        duration_ms: start.elapsed().as_millis() as u64,
                        stdout: output
                            .as_ref()
                            .map(|output| String::from_utf8_lossy(&output.stdout).to_string())
                            .unwrap_or_default(),
                        stderr: output
                            .as_ref()
                            .map(|output| String::from_utf8_lossy(&output.stderr).to_string())
                            .unwrap_or_default(),
                        message: Some(format!("command timed out after {timeout_ms} ms")),
                    };
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(error) => {
                return CommandOutcome {
                    status: "failed_to_run".to_string(),
                    exit_code: None,
                    duration_ms: start.elapsed().as_millis() as u64,
                    stdout: String::new(),
                    stderr: String::new(),
                    message: Some(error.to_string()),
                };
            }
        }
    }

    match child.wait_with_output() {
        Ok(output) => {
            let exit_code = output.status.code().map(i64::from);
            CommandOutcome {
                status: if output.status.success() {
                    "passed".to_string()
                } else {
                    "failed".to_string()
                },
                exit_code,
                duration_ms: start.elapsed().as_millis() as u64,
                stdout: String::from_utf8_lossy(&output.stdout).to_string(),
                stderr: String::from_utf8_lossy(&output.stderr).to_string(),
                message: None,
            }
        }
        Err(error) => CommandOutcome {
            status: "failed_to_run".to_string(),
            exit_code: None,
            duration_ms: start.elapsed().as_millis() as u64,
            stdout: String::new(),
            stderr: String::new(),
            message: Some(error.to_string()),
        },
    }
}

fn parse_diagnostics(input: DiagnosticParseInput<'_>) -> Vec<Diagnostic> {
    match input.parser {
        LensCheckParser::Line => {
            let diagnostics = parse_line_diagnostics(
                input.name,
                input.kind,
                input.source.clone(),
                input.scope.clone(),
                input.stdout,
                input.stderr,
            );
            if diagnostics.is_empty() && input.kind == "check" && input.exit_code != Some(0) {
                generic_diagnostic(
                    input.name,
                    input.kind,
                    input.source,
                    input.scope,
                    input.exit_code,
                )
            } else {
                diagnostics
            }
        }
        LensCheckParser::Generic => generic_diagnostic(
            input.name,
            input.kind,
            input.source,
            input.scope,
            input.exit_code,
        ),
    }
}

struct DiagnosticParseInput<'a> {
    name: &'a str,
    kind: &'a str,
    parser: LensCheckParser,
    source: DiagnosticSource,
    scope: DiagnosticScope,
    exit_code: Option<i64>,
    stdout: &'a str,
    stderr: &'a str,
}

fn generic_diagnostic(
    name: &str,
    kind: &str,
    source: DiagnosticSource,
    scope: DiagnosticScope,
    exit_code: Option<i64>,
) -> Vec<Diagnostic> {
    if exit_code == Some(0) {
        return Vec::new();
    }
    let code = exit_code
        .map(|code| format!("exit_{code}"))
        .unwrap_or_else(|| "run_failed".to_string());
    vec![Diagnostic {
        source,
        scope: scope.clone(),
        severity: DiagnosticSeverity::Error,
        code: Some(code.clone()),
        message: format!("{kind} '{name}' failed ({code})"),
        rel_path: None,
        start_line: None,
        end_line: None,
        fingerprint: format!("{kind}:{name}:{code}"),
        content_hash: None,
        raw_output_id: None,
        snapshot_id: None,
        first_seen_at: None,
        last_seen_at: None,
        resolved_at: None,
    }]
}

fn parse_line_diagnostics(
    name: &str,
    kind: &str,
    source: DiagnosticSource,
    scope: DiagnosticScope,
    stdout: &str,
    stderr: &str,
) -> Vec<Diagnostic> {
    stdout
        .lines()
        .chain(stderr.lines())
        .filter_map(|line| line_diagnostic(name, kind, source.clone(), scope.clone(), line))
        .collect()
}

pub fn diagnostics_from_output_lines(
    root: &Path,
    name: &str,
    source: DiagnosticSource,
    scope: DiagnosticScope,
    output: &str,
) -> Vec<Diagnostic> {
    output
        .lines()
        .filter_map(|line| path_line_diagnostic(root, name, source.clone(), scope.clone(), line))
        .collect()
}

fn path_line_diagnostic(
    root: &Path,
    name: &str,
    source: DiagnosticSource,
    scope: DiagnosticScope,
    line: &str,
) -> Option<Diagnostic> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let parts = line.splitn(5, ':').collect::<Vec<_>>();
    let (rel_path, start_line, severity, message) = match parts.as_slice() {
        [path, line, severity, message] if line.parse::<i64>().is_ok() => (
            (*path).to_string(),
            line.parse::<i64>().ok()?,
            parse_explicit_output_severity(severity)?,
            (*message).trim().to_string(),
        ),
        [path, line, column, message]
            if line.parse::<i64>().is_ok() && column.parse::<i64>().is_ok() =>
        {
            (
                (*path).to_string(),
                line.parse::<i64>().ok()?,
                parse_prefixed_output_severity(message)?,
                (*message).trim().to_string(),
            )
        }
        [path, line, column, severity, message]
            if line.parse::<i64>().is_ok() && column.parse::<i64>().is_ok() =>
        {
            (
                (*path).to_string(),
                line.parse::<i64>().ok()?,
                parse_explicit_output_severity(severity)?,
                (*message).trim().to_string(),
            )
        }
        _ => return None,
    };
    let rel_path = normalize_output_diagnostic_path(root, &rel_path)?;
    let fingerprint = crate::apply_patch::sha1_hex(
        format!("tool:{name}:{rel_path:?}:{start_line:?}:{message}").as_bytes(),
    );
    Some(Diagnostic {
        source,
        scope,
        severity,
        code: None,
        message,
        rel_path: Some(rel_path),
        start_line: Some(start_line),
        end_line: Some(start_line),
        fingerprint,
        content_hash: None,
        raw_output_id: None,
        snapshot_id: None,
        first_seen_at: None,
        last_seen_at: None,
        resolved_at: None,
    })
}

fn parse_explicit_output_severity(value: &str) -> Option<DiagnosticSeverity> {
    match value.trim().to_ascii_lowercase().as_str() {
        "error" => Some(DiagnosticSeverity::Error),
        "warning" | "warn" => Some(DiagnosticSeverity::Warning),
        "info" | "note" => Some(DiagnosticSeverity::Info),
        "hint" | "help" => Some(DiagnosticSeverity::Hint),
        _ => None,
    }
}

fn parse_prefixed_output_severity(message: &str) -> Option<DiagnosticSeverity> {
    let prefix = message
        .trim_start()
        .split(|c: char| c == ':' || c.is_whitespace())
        .next()?;
    parse_explicit_output_severity(prefix)
}

fn normalize_output_diagnostic_path(root: &Path, path: &str) -> Option<String> {
    let path = path.trim();
    if path.is_empty()
        || path.starts_with('-')
        || path
            .chars()
            .any(|c| c.is_whitespace() || matches!(c, '"' | '\'' | '`' | '<' | '>' | '|'))
    {
        return None;
    }
    let path = Path::new(path);
    if path.components().any(|component| {
        matches!(
            component,
            std::path::Component::ParentDir | std::path::Component::Prefix(_)
        )
    }) {
        return None;
    }
    let relative = if path.is_absolute() {
        path.strip_prefix(root).ok()?
    } else {
        path
    };
    if relative.as_os_str().is_empty() {
        return None;
    }
    let candidate = root.join(relative);
    if candidate.exists() || relative.components().count() > 1 || relative.extension().is_some() {
        Some(relative.to_string_lossy().into_owned())
    } else {
        None
    }
}

fn line_diagnostic(
    name: &str,
    kind: &str,
    source: DiagnosticSource,
    scope: DiagnosticScope,
    line: &str,
) -> Option<Diagnostic> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let parts = line.splitn(4, ':').collect::<Vec<_>>();
    let (rel_path, start_line, severity, message) = match parts.as_slice() {
        [path, line, severity, message] if line.parse::<i64>().is_ok() => (
            Some((*path).to_string()),
            line.parse::<i64>().ok(),
            parse_line_severity(severity),
            (*message).trim().to_string(),
        ),
        [path, line, message] if line.parse::<i64>().is_ok() => (
            Some((*path).to_string()),
            line.parse::<i64>().ok(),
            DiagnosticSeverity::Warning,
            (*message).trim().to_string(),
        ),
        _ => (None, None, DiagnosticSeverity::Warning, line.to_string()),
    };
    let fingerprint = crate::apply_patch::sha1_hex(
        format!("{kind}:{name}:{rel_path:?}:{start_line:?}:{message}").as_bytes(),
    );
    Some(Diagnostic {
        source,
        scope,
        severity,
        code: None,
        message,
        rel_path,
        start_line,
        end_line: start_line,
        fingerprint,
        content_hash: None,
        raw_output_id: None,
        snapshot_id: None,
        first_seen_at: None,
        last_seen_at: None,
        resolved_at: None,
    })
}

fn parse_line_severity(value: &str) -> DiagnosticSeverity {
    match value.trim().to_ascii_lowercase().as_str() {
        "error" => DiagnosticSeverity::Error,
        "info" => DiagnosticSeverity::Info,
        "hint" => DiagnosticSeverity::Hint,
        _ => DiagnosticSeverity::Warning,
    }
}

fn scanner_source(source: &str) -> DiagnosticSource {
    match source {
        "secrets" => DiagnosticSource::Secrets,
        "security" => DiagnosticSource::Security,
        "test" => DiagnosticSource::Test,
        other => DiagnosticSource::Other(other.to_string()),
    }
}

fn join_raw_output(stdout: &str, stderr: &str) -> String {
    match (stdout.is_empty(), stderr.is_empty()) {
        (true, true) => String::new(),
        (false, true) => stdout.to_string(),
        (true, false) => stderr.to_string(),
        (false, false) => format!("{stdout}\n{stderr}"),
    }
}

fn missing_command(root: &Path, command: &str) -> Option<String> {
    let first = first_command_word(command)?;
    if command_available(root, &first) {
        None
    } else {
        Some(first)
    }
}

fn first_command_word(command: &str) -> Option<String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut out = String::new();
    let mut quote = None;
    let mut escaped = false;
    for character in trimmed.chars() {
        if escaped {
            out.push(character);
            escaped = false;
            continue;
        }
        if character == '\\' {
            escaped = true;
            continue;
        }
        if let Some(active) = quote {
            if character == active {
                quote = None;
            } else {
                out.push(character);
            }
            continue;
        }
        if character == '\'' || character == '"' {
            quote = Some(character);
            continue;
        }
        if character.is_whitespace() {
            break;
        }
        out.push(character);
    }
    (!out.is_empty()).then_some(out)
}

fn command_available(root: &Path, command: &str) -> bool {
    let path = Path::new(command);
    if path.components().count() > 1 {
        let full = if path.is_absolute() {
            PathBuf::from(path)
        } else {
            root.join(path)
        };
        return full.is_file();
    }
    let Some(paths) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&paths).any(|dir| dir.join(command).is_file())
}

fn detected_suggestions(
    root: &Path,
    configured: &BTreeMap<String, LensCheckConfig>,
) -> Vec<LensCheckSuggestion> {
    let mut suggestions = Vec::new();
    push_suggestion(
        root,
        configured,
        &mut suggestions,
        "cargo-fmt",
        "cargo fmt --check",
        "Cargo.toml detected",
    );
    push_suggestion(
        root,
        configured,
        &mut suggestions,
        "cargo-clippy",
        "cargo clippy -- -D warnings",
        "Cargo.toml detected",
    );
    push_suggestion(
        root,
        configured,
        &mut suggestions,
        "pytest",
        "pytest",
        "pyproject.toml detected",
    );
    push_suggestion(
        root,
        configured,
        &mut suggestions,
        "make-test",
        "make test",
        "Makefile detected",
    );
    suggestions
}

fn push_suggestion(
    root: &Path,
    configured: &BTreeMap<String, LensCheckConfig>,
    suggestions: &mut Vec<LensCheckSuggestion>,
    name: &str,
    command: &str,
    reason: &str,
) {
    let file = match name {
        "cargo-fmt" | "cargo-clippy" => "Cargo.toml",
        "pytest" => "pyproject.toml",
        "make-test" => "Makefile",
        _ => return,
    };
    if !root.join(file).is_file() || configured.contains_key(name) {
        return;
    }
    suggestions.push(LensCheckSuggestion {
        name: name.to_string(),
        command: command.to_string(),
        reason: reason.to_string(),
        hint: format!(
            "add checks.{name} to .ct/lens.json to allow Lens to run `{command}` automatically"
        ),
    });
}

fn check_warnings(data: &LensChecksData) -> Vec<LensMessage> {
    let mut warnings = Vec::new();
    for suggestion in &data.suggestions {
        warnings.push(LensMessage::warning_with_hint(
            "check_suggested",
            format!(
                "detected unconfigured Lens check '{}' ({})",
                suggestion.name, suggestion.command
            ),
            suggestion.hint.clone(),
        ));
    }
    for run in &data.runs {
        match run.status.as_str() {
            "passed" => {}
            "missing_tool" => warnings.push(LensMessage::warning_with_hint(
                "check_tool_missing",
                format!("Lens {} '{}' could not run", run.kind, run.name),
                run.message.clone().unwrap_or_else(|| {
                    "install the tool or remove the configured check".to_string()
                }),
            )),
            "timed_out" => warnings.push(LensMessage::warning_with_hint(
                "check_timed_out",
                format!("Lens {} '{}' timed out", run.kind, run.name),
                run.message
                    .clone()
                    .unwrap_or_else(|| "increase timeout_ms or fix the check".to_string()),
            )),
            _ => warnings.push(LensMessage::warning(
                "check_failed",
                format!("Lens {} '{}' reported diagnostics", run.kind, run.name),
            )),
        }
    }
    warnings
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_executable(path: &Path, content: &str) {
        std::fs::write(path, content).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(path).unwrap().permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(path, perms).unwrap();
        }
    }

    fn write_config(root: &Path, body: &str) {
        std::fs::create_dir_all(root.join(".ct")).unwrap();
        std::fs::write(root.join(".ct/lens.json"), body).unwrap();
    }

    #[test]
    fn automatic_runs_only_configured_automatic_checks() {
        let temp = tempfile::tempdir().unwrap();
        write_executable(
            &temp.path().join("auto.sh"),
            "#!/bin/sh\necho auto > auto-ran\nexit 0\n",
        );
        write_executable(
            &temp.path().join("manual.sh"),
            "#!/bin/sh\necho manual > manual-ran\nexit 0\n",
        );
        write_config(
            temp.path(),
            r#"{"checks":{"auto":{"command":"./auto.sh","automatic":true},"manual":{"command":"./manual.sh","automatic":false}}}"#,
        );

        let envelope = automatic_turn_checks_envelope(temp.path()).unwrap();

        assert_eq!(envelope.data.runs.len(), 1);
        assert_eq!(envelope.data.runs[0].name, "auto");
        assert!(temp.path().join("auto-ran").is_file());
        assert!(!temp.path().join("manual-ran").exists());
    }

    #[test]
    fn built_in_cargo_checks_are_planned_without_config() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("Cargo.toml"), "[package]\nname='x'\n").unwrap();

        let envelope = planned_turn_checks_envelope(temp.path()).unwrap();

        assert_eq!(envelope.data.configured_checks.len(), 2);
        assert!(
            envelope
                .data
                .configured_checks
                .iter()
                .all(|check| check.automatic)
        );
        assert!(envelope.data.suggestions.is_empty());
    }

    #[test]
    fn missing_tools_are_structured_warnings() {
        let temp = tempfile::tempdir().unwrap();
        write_config(
            temp.path(),
            r#"{"checks":{"missing":{"command":"ct-lens-missing-fixture --version","automatic":true}}}"#,
        );

        let envelope = automatic_turn_checks_envelope(temp.path()).unwrap();

        assert_eq!(envelope.data.runs[0].status, "missing_tool");
        assert_eq!(envelope.warnings[0].code, "check_tool_missing");
    }

    #[test]
    fn scanner_line_output_records_security_diagnostics_without_autofix() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("main.rs"), "fn main() {}\n").unwrap();
        write_executable(
            &temp.path().join("scan.sh"),
            "#!/bin/sh\necho 'main.rs:1:error:hard-coded secret'\nexit 0\n",
        );
        write_config(
            temp.path(),
            r#"{"scanners":{"secrets":{"command":"./scan.sh","automatic":true,"parser":"line","source":"security"}}}"#,
        );

        let envelope = automatic_turn_checks_envelope(temp.path()).unwrap();
        let diagnostics = LensStore::open_for_project(temp.path())
            .unwrap()
            .list_diagnostics(None)
            .unwrap();

        assert_eq!(envelope.data.runs[0].kind, "scanner");
        assert_eq!(diagnostics.len(), 1);
        assert_eq!(diagnostics[0].source, DiagnosticSource::Security);
        assert_ne!(diagnostics[0].source, DiagnosticSource::Autofix);
        assert_eq!(diagnostics[0].scope.kind, "scanner");
    }

    #[test]
    fn command_output_diagnostics_ignore_shell_transcript_noise() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("main.rs"), "fn main() {}\n").unwrap();

        let diagnostics = diagnostics_from_output_lines(
            temp.path(),
            "exec_command",
            DiagnosticSource::Other("hook_output".to_string()),
            DiagnosticScope::command("exec_command:cargo test"),
            "Command: cargo test\nzsh:1: command not found\nmain.rs:1:warning:real warning\nif echo 'main.rs:1:warning:not a diagnostic command'; then true; fi",
        );

        assert_eq!(diagnostics.len(), 1);
        assert_eq!(diagnostics[0].rel_path.as_deref(), Some("main.rs"));
        assert_eq!(diagnostics[0].message, "real warning");
    }

    #[test]
    fn command_output_diagnostics_ignore_ripgrep_matches() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temp.path().join("src")).unwrap();
        std::fs::write(
            temp.path().join("src/main.ts"),
            "pi.registerTool({\n  name: \"read\",\n});\n",
        )
        .unwrap();

        let diagnostics = diagnostics_from_output_lines(
            temp.path(),
            "exec_command",
            DiagnosticSource::Other("hook_output".to_string()),
            DiagnosticScope::command("exec_command:rg registerTool"),
            "src/main.ts:1:pi.registerTool({\nsrc/main.ts:2:  name: \"read\",\nsrc/main.ts:3:10: warning: real warning",
        );

        assert_eq!(diagnostics.len(), 1);
        assert_eq!(diagnostics[0].rel_path.as_deref(), Some("src/main.ts"));
        assert_eq!(diagnostics[0].start_line, Some(3));
        assert_eq!(diagnostics[0].message, "real warning");
    }

    #[test]
    fn snapshots_replace_by_check_scope_and_obey_raw_cap() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("main.rs"), "fn main() {}\n").unwrap();
        write_executable(
            &temp.path().join("check.sh"),
            "#!/bin/sh\nif [ -f pass ]; then exit 0; fi\nprintf 'main.rs:1:error:%s\n' broken\nprintf '%0500d\n' 1\nexit 1\n",
        );
        write_config(
            temp.path(),
            r#"{"checks":{"fixture":{"command":"./check.sh","automatic":true,"parser":"line","raw_output_max_bytes":64}}}"#,
        );

        let first = automatic_turn_checks_envelope(temp.path()).unwrap();
        assert_eq!(first.data.runs[0].diagnostic_count, 2);
        assert!(
            first.data.runs[0]
                .snapshot
                .as_ref()
                .unwrap()
                .raw_output
                .as_ref()
                .unwrap()
                .retained_bytes
                <= 64
        );

        std::fs::write(temp.path().join("pass"), "").unwrap();
        let second = automatic_turn_checks_envelope(temp.path()).unwrap();
        let snapshot = second.data.runs[0].snapshot.as_ref().unwrap();
        assert_eq!(snapshot.deltas.resolved.len(), 2);
        assert_eq!(
            LensStore::open_for_project(temp.path())
                .unwrap()
                .list_diagnostics(None)
                .unwrap()
                .len(),
            0
        );
    }
}
