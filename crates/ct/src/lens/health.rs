use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use rusqlite::params;
use serde::{Deserialize, Serialize};

use super::contract::{LensEnvelope, LensMessage, LensResponseStatus};
use super::store::LensStore;
use super::types::{
    Diagnostic, DiagnosticDeltaSet, DiagnosticSeverity, DiagnosticSource, LensTouchedFile,
};
use crate::lsp::registry::{SERVERS, probe_for_server_root};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnHealthStatus {
    Clean,
    Warnings,
    Errors,
}

impl TurnHealthStatus {
    pub fn is_warning_or_worse(&self) -> bool {
        matches!(self, Self::Warnings | Self::Errors)
    }

    fn envelope_status(&self) -> LensResponseStatus {
        match self {
            Self::Clean => LensResponseStatus::Ok,
            Self::Warnings => LensResponseStatus::Warning,
            Self::Errors => LensResponseStatus::Error,
        }
    }

    fn as_str(&self) -> &'static str {
        match self {
            Self::Clean => "clean",
            Self::Warnings => "warnings",
            Self::Errors => "errors",
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct TurnHealthOptions {
    pub session: String,
    pub turn: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TurnHealthData {
    pub project_id: i64,
    pub session: String,
    pub turn: String,
    pub status: TurnHealthStatus,
    pub compact: String,
    pub summary: TurnHealthSummary,
    pub issues: Vec<SessionDiagnosticIssue>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TurnHealthSummary {
    pub changed_files: ChangedFilesSummary,
    pub validation_plan: ValidationPlanSummary,
    pub lsp: LspSummary,
    pub diagnostics: DiagnosticSummary,
    pub checks: CheckSummary,
    pub sources: Vec<DiagnosticSourceSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LspSummary {
    pub connected: Vec<LspConnectionSummary>,
    pub missing: Vec<LspMissingSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LspConnectionSummary {
    pub id: String,
    pub name: String,
    pub command: String,
    pub root: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LspMissingSummary {
    pub id: String,
    pub name: String,
    pub commands: Vec<String>,
    pub root: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ValidationPlanSummary {
    pub turn_active: bool,
    pub automatic_checks: Vec<String>,
    pub automatic_scanners: Vec<String>,
    pub suggestions: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangedFilesSummary {
    pub count: usize,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiagnosticSummary {
    pub active: usize,
    pub errors: usize,
    pub warnings: usize,
    pub info: usize,
    pub hints: usize,
    pub deltas: DiagnosticDeltaSummary,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiagnosticDeltaSummary {
    pub new: usize,
    pub resolved: usize,
    pub unchanged: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiagnosticSourceSummary {
    pub source: String,
    pub name: String,
    pub connected: bool,
    pub errors: usize,
    pub warnings: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionDiagnosticIssue {
    pub source: String,
    pub severity: DiagnosticSeverity,
    pub path: String,
    pub line: Option<i64>,
    pub message: String,
    pub code: Option<String>,
    pub fingerprint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fix_instruction: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckSummary {
    pub snapshots: usize,
    pub latest: Vec<CheckSnapshotSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckSnapshotSummary {
    pub snapshot_id: i64,
    pub source: String,
    pub scope_kind: String,
    pub scope_key: String,
    pub diagnostic_count: usize,
    pub command: Option<String>,
    pub exit_code: Option<i64>,
}

pub fn build_turn_health_envelope(
    root: &Path,
    options: TurnHealthOptions,
) -> Result<LensEnvelope<TurnHealthData>, Box<dyn std::error::Error>> {
    let mut store = LensStore::open_for_project(root)?;
    let data = compute_turn_health(root, &mut store, &options)?;
    Ok(health_envelope(data))
}

pub fn compact_health_text(data: &TurnHealthData) -> String {
    data.compact.clone()
}

pub fn final_health_text(data: &TurnHealthData) -> String {
    let mut lines = vec![format!(
        "Lens final health: {} ({})",
        data.status.as_str(),
        data.compact
    )];
    lines.extend(session_issue_report_lines(data));
    lines.join("\n")
}

fn compute_turn_health(
    root: &Path,
    store: &mut LensStore,
    options: &TurnHealthOptions,
) -> Result<TurnHealthData, Box<dyn std::error::Error>> {
    let touched = store.list_session_touched_files(&options.session)?;
    let changed_paths = unique_changed_paths(&touched);
    let turn_active = store
        .turn_status(&options.session, &options.turn)?
        .as_deref()
        == Some("active");
    let validation_plan = validation_plan_summary(root, turn_active)?;
    let lsp = lsp_summary(root);
    let active_diagnostics = session_diagnostics(store, &changed_paths)?;
    let diagnostics =
        diagnostic_summary(&active_diagnostics, &session_deltas(store, &changed_paths)?);
    let checks = check_summary(store)?;
    let sources = diagnostic_sources(&lsp, &active_diagnostics);
    let status = compute_status(&diagnostics);
    let issues = diagnostic_issues(&active_diagnostics);
    let summary = TurnHealthSummary {
        changed_files: ChangedFilesSummary {
            count: changed_paths.len(),
            paths: changed_paths.iter().cloned().collect(),
        },
        validation_plan,
        lsp,
        diagnostics,
        checks,
        sources,
    };
    let compact = compact_summary(&status, &summary);
    Ok(TurnHealthData {
        project_id: store.project_id(),
        session: options.session.clone(),
        turn: options.turn.clone(),
        status,
        compact,
        summary,
        issues,
    })
}

fn health_envelope(data: TurnHealthData) -> LensEnvelope<TurnHealthData> {
    let messages = health_messages(&data);
    match data.status.envelope_status() {
        LensResponseStatus::Ok => LensEnvelope::ok(data),
        LensResponseStatus::Warning => LensEnvelope::warning(data, messages),
        LensResponseStatus::Error => LensEnvelope::error(data, messages),
    }
}

fn health_messages(data: &TurnHealthData) -> Vec<LensMessage> {
    match data.status {
        TurnHealthStatus::Clean => Vec::new(),
        TurnHealthStatus::Warnings => vec![LensMessage::warning_with_hint(
            "lens_health_warnings",
            data.compact.clone(),
            "fix the listed session diagnostics".to_string(),
        )],
        TurnHealthStatus::Errors => vec![LensMessage::error(
            "lens_health_errors",
            data.compact.clone(),
        )],
    }
}

fn unique_changed_paths(touched: &[LensTouchedFile]) -> BTreeSet<String> {
    touched
        .iter()
        .filter(|file| !file.ignored && !file.generated)
        .map(|file| file.path.clone())
        .collect()
}

fn diagnostic_summary(
    diagnostics: &[Diagnostic],
    deltas: &DiagnosticDeltaSet,
) -> DiagnosticSummary {
    let mut summary = DiagnosticSummary {
        active: diagnostics.len(),
        errors: 0,
        warnings: 0,
        info: 0,
        hints: 0,
        deltas: DiagnosticDeltaSummary {
            new: deltas.new.len(),
            resolved: deltas.resolved.len(),
            unchanged: deltas.unchanged.len(),
        },
    };
    for diagnostic in diagnostics {
        match diagnostic.severity {
            DiagnosticSeverity::Error => summary.errors += 1,
            DiagnosticSeverity::Warning => summary.warnings += 1,
            DiagnosticSeverity::Info => summary.info += 1,
            DiagnosticSeverity::Hint => summary.hints += 1,
        }
    }
    summary
}

fn session_diagnostics(
    store: &LensStore,
    changed_paths: &BTreeSet<String>,
) -> Result<Vec<Diagnostic>, Box<dyn std::error::Error>> {
    if changed_paths.is_empty() {
        return Ok(Vec::new());
    }
    Ok(store
        .list_diagnostics(None)?
        .into_iter()
        .filter(|diagnostic| {
            diagnostic.rel_path.is_none()
                || diagnostic
                    .rel_path
                    .as_ref()
                    .is_some_and(|path| changed_paths.contains(path))
        })
        .collect())
}

fn session_deltas(
    store: &LensStore,
    changed_paths: &BTreeSet<String>,
) -> Result<DiagnosticDeltaSet, Box<dyn std::error::Error>> {
    let mut deltas = store.list_diagnostics_data(None, true)?.deltas;
    retain_deltas_for_paths_or_workspace(&mut deltas.new, changed_paths);
    retain_deltas_for_paths(&mut deltas.resolved, changed_paths);
    retain_deltas_for_paths(&mut deltas.unchanged, changed_paths);
    Ok(deltas)
}

fn retain_deltas_for_paths_or_workspace(
    diagnostics: &mut Vec<Diagnostic>,
    changed_paths: &BTreeSet<String>,
) {
    diagnostics.retain(|diagnostic| {
        diagnostic.rel_path.is_none()
            || diagnostic
                .rel_path
                .as_ref()
                .is_some_and(|path| changed_paths.contains(path))
    });
}

fn retain_deltas_for_paths(diagnostics: &mut Vec<Diagnostic>, changed_paths: &BTreeSet<String>) {
    diagnostics.retain(|diagnostic| {
        diagnostic
            .rel_path
            .as_ref()
            .is_some_and(|path| changed_paths.contains(path))
    });
}

fn diagnostic_sources(
    lsp: &LspSummary,
    diagnostics: &[Diagnostic],
) -> Vec<DiagnosticSourceSummary> {
    let mut sources: BTreeMap<String, DiagnosticSourceSummary> = BTreeMap::new();
    if !lsp.connected.is_empty() || !lsp.missing.is_empty() {
        sources.insert(
            "lsp".to_string(),
            DiagnosticSourceSummary {
                source: "lsp".to_string(),
                name: "lsp".to_string(),
                connected: !lsp.connected.is_empty(),
                errors: 0,
                warnings: 0,
            },
        );
    }
    for diagnostic in diagnostics {
        let source = diagnostic_source_name(&diagnostic.source);
        let summary = sources
            .entry(source.clone())
            .or_insert(DiagnosticSourceSummary {
                source: source.clone(),
                name: source,
                connected: true,
                errors: 0,
                warnings: 0,
            });
        match diagnostic.severity {
            DiagnosticSeverity::Error => summary.errors += 1,
            DiagnosticSeverity::Warning => summary.warnings += 1,
            DiagnosticSeverity::Info | DiagnosticSeverity::Hint => {}
        }
    }
    sources.into_values().collect()
}

fn diagnostic_issues(diagnostics: &[Diagnostic]) -> Vec<SessionDiagnosticIssue> {
    diagnostics
        .iter()
        .filter(|diagnostic| {
            matches!(
                diagnostic.severity,
                DiagnosticSeverity::Error | DiagnosticSeverity::Warning
            )
        })
        .map(|diagnostic| {
            let path = diagnostic
                .rel_path
                .clone()
                .unwrap_or_else(|| format!("{}:{}", diagnostic.scope.kind, diagnostic.scope.key));
            SessionDiagnosticIssue {
                source: diagnostic_source_name(&diagnostic.source),
                severity: diagnostic.severity.clone(),
                path: path.clone(),
                line: diagnostic.start_line,
                message: diagnostic.message.clone(),
                code: diagnostic.code.clone(),
                fingerprint: diagnostic.fingerprint.clone(),
                fix_instruction: fix_instruction(diagnostic, &path),
            }
        })
        .collect()
}

pub fn session_issue_report_text(data: &TurnHealthData) -> Option<String> {
    let lines = session_issue_report_lines(data);
    (!lines.is_empty()).then(|| lines.join("\n"))
}

fn session_issue_report_lines(data: &TurnHealthData) -> Vec<String> {
    if data.issues.is_empty() {
        return Vec::new();
    }
    let mut lines = vec![format!(
        "Lens session diagnostics: {} issue(s) across {} edited file(s)",
        data.issues.len(),
        data.summary.changed_files.count
    )];
    for issue in &data.issues {
        let location = match issue.line {
            Some(line) => format!("{}:{line}", issue.path),
            None => issue.path.clone(),
        };
        let code = issue
            .code
            .as_ref()
            .map(|code| format!(" [{code}]"))
            .unwrap_or_default();
        lines.push(format!(
            "- {}/{} {}{}: {}",
            issue.source,
            diagnostic_severity_text(&issue.severity),
            location,
            code,
            issue.message
        ));
        if let Some(fix) = &issue.fix_instruction {
            lines.push(format!("  fix: {fix}"));
        }
    }
    lines
        .push("Fix the listed files or inspect with `ct lens diagnostics list --all`.".to_string());
    lines
}

fn fix_instruction(diagnostic: &Diagnostic, path: &str) -> Option<String> {
    match diagnostic.source {
        DiagnosticSource::Formatter | DiagnosticSource::Autofix => Some(format!(
            "run the project formatter for {} or inspect with `ct lens diagnostics list --path {} --all --json`",
            shell_word(path),
            shell_word(path)
        )),
        _ => None,
    }
}

fn diagnostic_source_name(source: &DiagnosticSource) -> String {
    match source {
        DiagnosticSource::Lsp => "lsp".to_string(),
        DiagnosticSource::AstGrep => "ast_grep".to_string(),
        DiagnosticSource::TreeSitter => "tree_sitter".to_string(),
        DiagnosticSource::Secrets => "secrets".to_string(),
        DiagnosticSource::Security => "security".to_string(),
        DiagnosticSource::Formatter => "formatter".to_string(),
        DiagnosticSource::Autofix => "autofix".to_string(),
        DiagnosticSource::Test => "test".to_string(),
        DiagnosticSource::Other(value) => value.clone(),
    }
}

fn diagnostic_severity_text(severity: &DiagnosticSeverity) -> &'static str {
    match severity {
        DiagnosticSeverity::Error => "error",
        DiagnosticSeverity::Warning => "warning",
        DiagnosticSeverity::Info => "info",
        DiagnosticSeverity::Hint => "hint",
    }
}

fn check_summary(store: &LensStore) -> Result<CheckSummary, Box<dyn std::error::Error>> {
    store.with_conn(|conn| {
        let snapshots: i64 = conn.query_row(
            "SELECT COUNT(*) FROM diagnostic_snapshots
             WHERE project_id=?1 AND scope_kind IN ('check', 'scanner')",
            params![store.project_id()],
            |row| row.get(0),
        )?;
        let mut stmt = conn.prepare(
            "SELECT id, source, scope_kind, scope_key, metadata_json, diagnostic_count
             FROM diagnostic_snapshots
             WHERE project_id=?1 AND scope_kind IN ('check', 'scanner')
             ORDER BY created_at DESC, id DESC
             LIMIT 50",
        )?;
        let rows = stmt.query_map(params![store.project_id()], |row| {
            let metadata: String = row.get(4)?;
            let metadata: serde_json::Value = serde_json::from_str(&metadata).unwrap_or_default();
            Ok(CheckSnapshotSummary {
                snapshot_id: row.get(0)?,
                source: row.get(1)?,
                scope_kind: row.get(2)?,
                scope_key: row.get(3)?,
                diagnostic_count: row.get::<_, i64>(5)?.max(0) as usize,
                command: metadata
                    .get("command")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string),
                exit_code: metadata
                    .get("exit_code")
                    .and_then(serde_json::Value::as_i64),
            })
        })?;
        let mut latest = Vec::new();
        let mut seen = BTreeSet::new();
        for row in rows {
            let summary = row?;
            if seen.insert((summary.scope_kind.clone(), summary.scope_key.clone())) {
                latest.push(summary);
            }
            if latest.len() >= 5 {
                break;
            }
        }
        Ok(CheckSummary {
            snapshots: snapshots.max(0) as usize,
            latest,
        })
    })
}

fn validation_plan_summary(
    root: &Path,
    turn_active: bool,
) -> Result<ValidationPlanSummary, Box<dyn std::error::Error>> {
    let planned = super::checks::planned_turn_checks_envelope(root)?.data;
    Ok(ValidationPlanSummary {
        turn_active,
        automatic_checks: planned
            .configured_checks
            .into_iter()
            .map(|check| check.command)
            .collect(),
        automatic_scanners: planned
            .configured_scanners
            .into_iter()
            .map(|scanner| scanner.command)
            .collect(),
        suggestions: planned
            .suggestions
            .into_iter()
            .map(|suggestion| suggestion.command)
            .collect(),
    })
}

fn lsp_summary(root: &Path) -> LspSummary {
    let mut connected = Vec::new();
    let mut missing = Vec::new();
    for server in SERVERS {
        if !project_uses_lsp(root, server.extensions, server.root_markers) {
            continue;
        }
        let probe = probe_for_server_root(server.clone(), root);
        if probe.available {
            connected.push(LspConnectionSummary {
                id: probe.server.id.to_string(),
                name: probe.server.name.to_string(),
                command: probe
                    .command
                    .as_ref()
                    .map(|command| command.display().to_string())
                    .unwrap_or_default(),
                root: probe.root.map(|root| root.display().to_string()),
            });
        } else {
            missing.push(LspMissingSummary {
                id: server.id.to_string(),
                name: server.name.to_string(),
                commands: server
                    .commands
                    .iter()
                    .map(|command| command.to_string())
                    .collect(),
                root: Some(root.display().to_string()),
            });
        }
    }
    LspSummary { connected, missing }
}

fn project_uses_lsp(root: &Path, extensions: &[&str], root_markers: &[&str]) -> bool {
    let has_root_marker = root_markers
        .iter()
        .any(|marker| *marker != ".git" && root.join(marker).exists());
    has_root_marker && project_has_extension(root, extensions)
}

fn project_has_extension(root: &Path, extensions: &[&str]) -> bool {
    fn visit(dir: &Path, extensions: &[&str], remaining: &mut usize) -> bool {
        if *remaining == 0 {
            return false;
        }
        *remaining -= 1;
        let Ok(entries) = std::fs::read_dir(dir) else {
            return false;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if path.is_dir() {
                if matches!(
                    name.as_ref(),
                    ".git" | ".pi" | ".cargo" | "node_modules" | "target"
                ) {
                    continue;
                }
                if visit(&path, extensions, remaining) {
                    return true;
                }
            } else if path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| {
                    extensions
                        .iter()
                        .any(|expected| expected.trim_start_matches('.') == extension)
                })
            {
                return true;
            }
        }
        false
    }
    let mut remaining = 10_000;
    visit(root, extensions, &mut remaining)
}

fn compute_status(diagnostics: &DiagnosticSummary) -> TurnHealthStatus {
    if diagnostics.errors > 0 {
        TurnHealthStatus::Errors
    } else if diagnostics.warnings > 0 {
        TurnHealthStatus::Warnings
    } else {
        TurnHealthStatus::Clean
    }
}

fn compact_summary(status: &TurnHealthStatus, summary: &TurnHealthSummary) -> String {
    let mut parts = vec![format!(
        "{} · {} session-edited",
        status.as_str(),
        summary.changed_files.count
    )];
    parts.push(format!(
        "diag {} ({} err/{} warn)",
        summary.diagnostics.active, summary.diagnostics.errors, summary.diagnostics.warnings
    ));
    if !summary.sources.is_empty() {
        parts.push(format!(
            "sources: {}",
            summary
                .sources
                .iter()
                .map(|source| format!(
                    "{} {} {}/{}",
                    source.name,
                    if source.connected {
                        "connected"
                    } else {
                        "unavailable"
                    },
                    source.errors,
                    source.warnings
                ))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    parts.join(" · ")
}

fn shell_word(value: &str) -> String {
    if value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.' | '/' | ':'))
    {
        value.to_string()
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lens::{
        DiagnosticScope, DiagnosticSource, LensToolEventPhase, LensTouchedFileInput, LensTurnEvent,
        LensTurnEventKind, LensTurnEventPolicy,
    };

    fn event(root: &Path) -> LensTurnEvent {
        LensTurnEvent {
            schema_version: crate::lens::LENS_TURN_EVENT_SCHEMA_VERSION.to_string(),
            session: "s".to_string(),
            turn: "t".to_string(),
            host: "test".to_string(),
            cwd: root.display().to_string(),
            event: LensTurnEventKind::ToolEnd,
            tool: "edit".to_string(),
            phase: LensToolEventPhase::PostTool,
            status: Some("success".to_string()),
            files: vec![LensTouchedFileInput {
                path: "main.rs".to_string(),
                operation: "modify".to_string(),
                start_line: None,
                end_line: None,
                generated: false,
                include_ignored: false,
            }],
            policy: LensTurnEventPolicy::default(),
        }
    }

    fn record_turn(root: &Path) {
        let mut store = LensStore::open_for_project(root).unwrap();
        let mut event = event(root);
        event.event = LensTurnEventKind::TurnEnd;
        let touched = crate::lens::turn::touched_files_from_event(root, root, &event).unwrap();
        store.record_turn_event(&event, &touched).unwrap();
    }

    fn record_turn_with(root: &Path, turn: &str, path: &str) {
        let mut store = LensStore::open_for_project(root).unwrap();
        let mut event = event(root);
        event.event = LensTurnEventKind::TurnEnd;
        event.turn = turn.to_string();
        event.files = vec![LensTouchedFileInput {
            path: path.to_string(),
            operation: "modify".to_string(),
            start_line: None,
            end_line: None,
            generated: false,
            include_ignored: false,
        }];
        let touched = crate::lens::turn::touched_files_from_event(root, root, &event).unwrap();
        store.record_turn_event(&event, &touched).unwrap();
    }

    fn warning_diagnostic() -> Diagnostic {
        Diagnostic {
            source: DiagnosticSource::Test,
            scope: DiagnosticScope::file("main.rs"),
            severity: DiagnosticSeverity::Warning,
            code: None,
            message: "warn".to_string(),
            rel_path: Some("main.rs".to_string()),
            start_line: Some(1),
            end_line: Some(1),
            fingerprint: "warn".to_string(),
            content_hash: None,
            raw_output_id: None,
            snapshot_id: None,
            first_seen_at: None,
            last_seen_at: None,
            resolved_at: None,
        }
    }

    #[test]
    fn health_status_ignores_missing_read_coverage() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("main.rs"), "fn main() {}\n").unwrap();
        record_turn(temp.path());

        let envelope = build_turn_health_envelope(
            temp.path(),
            TurnHealthOptions {
                session: "s".to_string(),
                turn: "t".to_string(),
            },
        )
        .unwrap();

        assert_eq!(envelope.data.status, TurnHealthStatus::Clean);
    }

    #[test]
    fn active_turn_reports_clean_when_session_diagnostics_are_clean() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("main.rs"), "fn main() {}\n").unwrap();
        let mut store = LensStore::open_for_project(temp.path()).unwrap();
        let event = event(temp.path());
        let touched =
            crate::lens::turn::touched_files_from_event(temp.path(), temp.path(), &event).unwrap();
        store.record_turn_event(&event, &touched).unwrap();

        let envelope = build_turn_health_envelope(
            temp.path(),
            TurnHealthOptions {
                session: "s".to_string(),
                turn: "t".to_string(),
            },
        )
        .unwrap();

        assert_eq!(envelope.data.status, TurnHealthStatus::Clean);
        assert!(envelope.data.summary.validation_plan.turn_active);
        assert!(envelope.data.compact.contains("clean"));
    }

    #[test]
    fn compact_and_final_output_stay_quiet_when_clean() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("main.rs"), "fn main() {}\n").unwrap();
        record_turn(temp.path());
        let health = build_turn_health_envelope(
            temp.path(),
            TurnHealthOptions {
                session: "s".to_string(),
                turn: "t".to_string(),
            },
        )
        .unwrap();

        assert!(compact_health_text(&health.data).contains("clean"));
        assert!(final_health_text(&health.data).contains("Lens final health: clean"));
        assert!(!final_health_text(&health.data).contains("Ack:"));
    }

    #[test]
    fn warning_diagnostics_report_warnings_without_action_context() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("main.rs"), "fn main() {}\n").unwrap();
        record_turn(temp.path());
        let mut store = LensStore::open_for_project(temp.path()).unwrap();
        store.record_diagnostics(&[warning_diagnostic()]).unwrap();

        let health = build_turn_health_envelope(
            temp.path(),
            TurnHealthOptions {
                session: "s".to_string(),
                turn: "t".to_string(),
            },
        )
        .unwrap();

        assert_eq!(health.data.status, TurnHealthStatus::Warnings);
        assert_eq!(health.data.issues.len(), 1);
        assert_eq!(health.data.summary.sources[0].warnings, 1);
    }

    #[test]
    fn turn_health_aggregates_diagnostics_from_session_edited_files() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("first.rs"), "fn first() {}\n").unwrap();
        std::fs::write(temp.path().join("second.rs"), "fn second() {}\n").unwrap();
        record_turn_with(temp.path(), "first", "first.rs");
        let mut store = LensStore::open_for_project(temp.path()).unwrap();
        store
            .record_diagnostics(&[Diagnostic {
                source: DiagnosticSource::Test,
                scope: DiagnosticScope::file("first.rs"),
                severity: DiagnosticSeverity::Warning,
                code: None,
                message: "old turn warning".to_string(),
                rel_path: Some("first.rs".to_string()),
                start_line: Some(1),
                end_line: Some(1),
                fingerprint: "old-turn-warning".to_string(),
                content_hash: None,
                raw_output_id: None,
                snapshot_id: None,
                first_seen_at: None,
                last_seen_at: None,
                resolved_at: None,
            }])
            .unwrap();
        record_turn_with(temp.path(), "second", "second.rs");

        let health = build_turn_health_envelope(
            temp.path(),
            TurnHealthOptions {
                session: "s".to_string(),
                turn: "second".to_string(),
            },
        )
        .unwrap();

        assert_eq!(
            health.data.summary.changed_files.paths,
            vec!["first.rs", "second.rs"]
        );
        assert_eq!(health.data.summary.diagnostics.active, 1);
        assert_eq!(health.data.status, TurnHealthStatus::Warnings);
    }
}
