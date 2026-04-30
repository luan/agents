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
    pub acknowledge: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TurnHealthData {
    pub project_id: i64,
    pub session: String,
    pub turn: String,
    pub status: TurnHealthStatus,
    pub compact: String,
    pub summary: TurnHealthSummary,
    #[serde(skip_serializing)]
    pub action_context: ActionContextState,
    pub issues: Vec<SessionDiagnosticIssue>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TurnHealthSummary {
    pub changed_files: ChangedFilesSummary,
    pub validation_plan: ValidationPlanSummary,
    pub lsp: LspSummary,
    pub cleanup: CleanupSummary,
    pub diagnostics: DiagnosticSummary,
    pub checks: CheckSummary,
    pub patch_refs: PatchRefSummary,
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
    pub cleanup_pending: bool,
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
pub struct CleanupSummary {
    pub runs: usize,
    pub mutations: usize,
    pub diagnostics: usize,
    pub failed: usize,
    pub timed_out: usize,
    pub skipped: usize,
    pub raw_output_refs: Vec<i64>,
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
    pub raw_output_ref: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PatchRefSummary {
    pub accepted_events: usize,
    pub hunks: usize,
    pub draft_refs: usize,
    pub affected_symbols: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActionContextState {
    pub required: bool,
    pub acknowledged: bool,
    pub state: String,
    pub fingerprint: String,
    pub status: TurnHealthStatus,
    pub reason: String,
    pub instructions: String,
    pub ack_command: Option<String>,
    pub remediation: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangedFileReportData {
    pub project_id: i64,
    pub session: String,
    pub turn: String,
    pub status: TurnHealthStatus,
    pub files: Vec<ChangedFileReport>,
    pub file_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangedFileReport {
    pub path: String,
    pub touched: Vec<LensTouchedFile>,
    pub diagnostics: Vec<Diagnostic>,
    pub cleanup_actions: Vec<CleanupActionReport>,
    pub patch_refs: FilePatchRefs,
    pub symbol_context: SymbolGraphContext,
    pub next_actions: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CleanupActionReport {
    pub tool: String,
    pub status: String,
    pub operation: String,
    pub generated: bool,
    pub raw_output_ref: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FilePatchRefs {
    pub accepted_events: usize,
    pub hunks: usize,
    pub draft_chunks: usize,
    pub affected_symbols: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SymbolGraphContext {
    pub status: String,
    pub command: String,
    pub symbols: Vec<SymbolContextItem>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SymbolContextItem {
    pub name: String,
    pub kind: String,
    pub parent: String,
    pub start_line: usize,
    pub end_line: usize,
}

pub fn build_turn_health_envelope(
    root: &Path,
    options: TurnHealthOptions,
) -> Result<LensEnvelope<TurnHealthData>, Box<dyn std::error::Error>> {
    let mut store = LensStore::open_for_project(root)?;
    let data = compute_turn_health(root, &mut store, &options)?;
    Ok(health_envelope(data))
}

pub fn build_action_context_envelope(
    root: &Path,
    options: TurnHealthOptions,
) -> Result<LensEnvelope<ActionContextState>, Box<dyn std::error::Error>> {
    let mut store = LensStore::open_for_project(root)?;
    let health = compute_turn_health(root, &mut store, &options)?;
    Ok(context_envelope(health.action_context))
}

pub fn build_changed_file_report_envelope(
    root: &Path,
    options: TurnHealthOptions,
    path: Option<&str>,
) -> Result<LensEnvelope<ChangedFileReportData>, Box<dyn std::error::Error>> {
    let mut store = LensStore::open_for_project(root)?;
    let health = compute_turn_health(root, &mut store, &options)?;
    let touched = store.list_session_touched_files(&options.session)?;
    let mut by_path: BTreeMap<String, Vec<LensTouchedFile>> = BTreeMap::new();
    for file in touched {
        if path.is_none_or(|wanted| wanted == file.path) {
            by_path.entry(file.path.clone()).or_default().push(file);
        }
    }
    let mut files = Vec::new();
    for (file_path, touched) in by_path {
        let diagnostics = store.list_diagnostics(Some(&file_path))?;
        let cleanup_actions =
            cleanup_actions_for_file(&store, &options.session, &options.turn, &file_path)?;
        let patch_refs = patch_refs_for_file(&store, &options.session, &file_path)?;
        let symbol_context = symbol_context(root, &file_path, &diagnostics);
        let next_actions = report_next_actions(&file_path, &diagnostics);
        files.push(ChangedFileReport {
            path: file_path,
            touched,
            diagnostics,
            cleanup_actions,
            patch_refs,
            symbol_context,
            next_actions,
        });
    }
    let data = ChangedFileReportData {
        project_id: health.project_id,
        session: options.session,
        turn: options.turn,
        status: health.status.clone(),
        file_count: files.len(),
        files,
    };
    Ok(report_envelope(data))
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
    let cleanup = cleanup_summary(store, &options.session, &options.turn)?;
    let active_diagnostics = session_diagnostics(store, &changed_paths)?;
    let diagnostics =
        diagnostic_summary(&active_diagnostics, &session_deltas(store, &changed_paths)?);
    let checks = check_summary(store)?;
    let patch_refs = patch_ref_summary(store, &options.session, &changed_paths)?;
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
        cleanup,
        diagnostics,
        checks,
        patch_refs,
        sources,
    };
    let compact = compact_summary(&status, &summary);
    let action_context = action_context(status.clone(), compact.clone());
    Ok(TurnHealthData {
        project_id: store.project_id(),
        session: options.session.clone(),
        turn: options.turn.clone(),
        status,
        compact,
        summary,
        action_context,
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

fn context_envelope(data: ActionContextState) -> LensEnvelope<ActionContextState> {
    if data.required {
        LensEnvelope::warning(
            data.clone(),
            vec![LensMessage::warning_with_hint(
                "lens_action_required",
                data.reason.clone(),
                data.instructions.clone(),
            )],
        )
    } else {
        LensEnvelope::ok(data)
    }
}

fn report_envelope(data: ChangedFileReportData) -> LensEnvelope<ChangedFileReportData> {
    match data.status.envelope_status() {
        LensResponseStatus::Ok => LensEnvelope::ok(data),
        LensResponseStatus::Warning => LensEnvelope::warning(
            data,
            vec![LensMessage::warning(
                "lens_report_findings",
                "changed-file report includes warning-or-worse findings",
            )],
        ),
        LensResponseStatus::Error => LensEnvelope::error(
            data,
            vec![LensMessage::error(
                "lens_report_errors",
                "changed-file report includes error findings",
            )],
        ),
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

fn cleanup_summary(
    store: &LensStore,
    session: &str,
    turn: &str,
) -> Result<CleanupSummary, Box<dyn std::error::Error>> {
    store.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT tool, status, mutation_count, diagnostic_snapshot_id, raw_output_id
              FROM cleanup_runs
              WHERE project_id=?1 AND session_id=?2 AND turn_id=?3
              ORDER BY created_at DESC, id DESC",
        )?;
        let rows = stmt.query_map(params![store.project_id(), session, turn], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, Option<i64>>(3)?,
                row.get::<_, Option<i64>>(4)?,
            ))
        })?;
        let mut summary = CleanupSummary {
            runs: 0,
            mutations: 0,
            diagnostics: 0,
            failed: 0,
            timed_out: 0,
            skipped: 0,
            raw_output_refs: Vec::new(),
        };
        let mut latest_by_tool = BTreeSet::new();
        for row in rows {
            let (tool, status, mutations, diagnostic_snapshot_id, raw_output_id) = row?;
            summary.runs += 1;
            summary.mutations += mutations.max(0) as usize;
            if diagnostic_snapshot_id.is_some() {
                summary.diagnostics +=
                    cleanup_snapshot_diagnostic_count(conn, diagnostic_snapshot_id)?;
            }
            if latest_by_tool.insert(tool) {
                if let Some(raw_output_id) = raw_output_id {
                    summary.raw_output_refs.push(raw_output_id);
                }
                match status.as_str() {
                    "failed" => summary.failed += 1,
                    "timed_out" => summary.timed_out += 1,
                    status if status.starts_with("skipped_") => summary.skipped += 1,
                    _ => {}
                }
            }
        }
        Ok(summary)
    })
}

fn cleanup_snapshot_diagnostic_count(
    conn: &rusqlite::Connection,
    snapshot_id: Option<i64>,
) -> Result<usize, rusqlite::Error> {
    let Some(snapshot_id) = snapshot_id else {
        return Ok(0);
    };
    let count: i64 = conn.query_row(
        "SELECT diagnostic_count FROM diagnostic_snapshots WHERE id=?1",
        params![snapshot_id],
        |row| row.get(0),
    )?;
    Ok(count.max(0) as usize)
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
    let mut diagnostics = Vec::new();
    for path in changed_paths {
        diagnostics.extend(store.list_diagnostics(Some(path))?);
    }
    Ok(diagnostics)
}

fn session_deltas(
    store: &LensStore,
    changed_paths: &BTreeSet<String>,
) -> Result<DiagnosticDeltaSet, Box<dyn std::error::Error>> {
    let mut deltas = store.list_diagnostics_data(None, true)?.deltas;
    retain_deltas_for_paths(&mut deltas.new, changed_paths);
    retain_deltas_for_paths(&mut deltas.resolved, changed_paths);
    retain_deltas_for_paths(&mut deltas.unchanged, changed_paths);
    Ok(deltas)
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
        .filter_map(|diagnostic| {
            let path = diagnostic.rel_path.clone()?;
            Some(SessionDiagnosticIssue {
                source: diagnostic_source_name(&diagnostic.source),
                severity: diagnostic.severity.clone(),
                path: path.clone(),
                line: diagnostic.start_line,
                message: diagnostic.message.clone(),
                code: diagnostic.code.clone(),
                fingerprint: diagnostic.fingerprint.clone(),
                fix_instruction: fix_instruction(diagnostic, &path),
            })
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
    lines.push(
        "Fix the listed files or inspect with `ct lens diagnostics list --all --json`.".to_string(),
    );
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
            "SELECT id, source, scope_kind, scope_key, raw_output_id, metadata_json, diagnostic_count
             FROM diagnostic_snapshots
             WHERE project_id=?1 AND scope_kind IN ('check', 'scanner')
             ORDER BY created_at DESC, id DESC
             LIMIT 50",
        )?;
        let rows = stmt.query_map(params![store.project_id()], |row| {
            let metadata: String = row.get(5)?;
            let metadata: serde_json::Value = serde_json::from_str(&metadata).unwrap_or_default();
            Ok(CheckSnapshotSummary {
                snapshot_id: row.get(0)?,
                source: row.get(1)?,
                scope_kind: row.get(2)?,
                scope_key: row.get(3)?,
                raw_output_ref: row.get(4)?,
                diagnostic_count: row.get::<_, i64>(6)?.max(0) as usize,
                command: metadata
                    .get("command")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string),
                exit_code: metadata.get("exit_code").and_then(serde_json::Value::as_i64),
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
        cleanup_pending: false,
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

fn patch_ref_summary(
    store: &LensStore,
    session: &str,
    changed_paths: &BTreeSet<String>,
) -> Result<PatchRefSummary, Box<dyn std::error::Error>> {
    if changed_paths.is_empty() {
        return Ok(PatchRefSummary {
            accepted_events: 0,
            hunks: 0,
            draft_refs: 0,
            affected_symbols: 0,
        });
    }
    let mut summary = PatchRefSummary {
        accepted_events: 0,
        hunks: 0,
        draft_refs: 0,
        affected_symbols: 0,
    };
    for path in changed_paths {
        let refs = patch_refs_for_file(store, session, path)?;
        summary.accepted_events += refs.accepted_events;
        summary.hunks += refs.hunks;
        summary.draft_refs += refs.draft_chunks;
        summary.affected_symbols += refs.affected_symbols.len();
    }
    Ok(summary)
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

fn action_context(status: TurnHealthStatus, compact: String) -> ActionContextState {
    ActionContextState {
        required: false,
        acknowledged: false,
        state: "clear".to_string(),
        fingerprint: String::new(),
        status,
        reason: compact,
        instructions:
            "Lens action acknowledgement is disabled; use the diagnostics report directly."
                .to_string(),
        ack_command: None,
        remediation: Vec::new(),
    }
}

fn cleanup_actions_for_file(
    store: &LensStore,
    session: &str,
    turn: &str,
    path: &str,
) -> Result<Vec<CleanupActionReport>, Box<dyn std::error::Error>> {
    store.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT cr.tool, cr.status, cm.operation, cm.generated, cr.raw_output_id
             FROM cleanup_mutations cm
             JOIN cleanup_runs cr ON cr.id = cm.cleanup_run_id
             WHERE cr.project_id=?1 AND cr.session_id=?2 AND cr.turn_id=?3 AND cm.rel_path=?4
             ORDER BY cr.created_at DESC, cr.id DESC",
        )?;
        let rows = stmt.query_map(params![store.project_id(), session, turn, path], |row| {
            Ok(CleanupActionReport {
                tool: row.get(0)?,
                status: row.get(1)?,
                operation: row.get(2)?,
                generated: row.get(3)?,
                raw_output_ref: row.get(4)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    })
}

fn patch_refs_for_file(
    store: &LensStore,
    session: &str,
    path: &str,
) -> Result<FilePatchRefs, Box<dyn std::error::Error>> {
    store.with_conn(|conn| {
        let accepted_events: i64 = conn.query_row(
            "SELECT COUNT(*)
             FROM patch_events pe
             JOIN files f ON f.id = pe.file_id
             WHERE f.project_id=?1 AND f.rel_path=?2 AND pe.session_id=?3 AND pe.accepted=1",
            params![store.project_id(), path, session],
            |row| row.get(0),
        )?;
        let hunks: i64 = conn.query_row(
            "SELECT COUNT(*)
             FROM patch_hunks ph
             JOIN patch_events pe ON pe.id = ph.patch_event_id
             JOIN files f ON f.id = pe.file_id
             WHERE f.project_id=?1 AND f.rel_path=?2 AND pe.session_id=?3",
            params![store.project_id(), path, session],
            |row| row.get(0),
        )?;
        let draft_chunks: i64 = conn.query_row(
            "SELECT COUNT(*)
             FROM patch_draft_chunks pdc
             JOIN patch_drafts pd ON pd.id = pdc.patch_id
             WHERE pd.project_id=?1 AND pdc.file_path=?2 AND (pd.session_id=?3 OR pd.session_id IS NULL)",
            params![store.project_id(), path, session],
            |row| row.get(0),
        )?;
        let mut stmt = conn.prepare(
            "SELECT DISTINCT COALESCE(symbol_name, '<unknown>')
             FROM patch_affected_symbols pas
             JOIN patch_events pe ON pe.id = pas.patch_event_id
             JOIN files f ON f.id = pe.file_id
             WHERE f.project_id=?1 AND pas.file_path=?2 AND pe.session_id=?3
             ORDER BY 1
             LIMIT 20",
        )?;
        let rows = stmt.query_map(params![store.project_id(), path, session], |row| row.get(0))?;
        Ok(FilePatchRefs {
            accepted_events: accepted_events.max(0) as usize,
            hunks: hunks.max(0) as usize,
            draft_chunks: draft_chunks.max(0) as usize,
            affected_symbols: rows.collect::<Result<Vec<_>, _>>()?,
        })
    })
}

fn symbol_context(root: &Path, path: &str, diagnostics: &[Diagnostic]) -> SymbolGraphContext {
    let command = format!("ct source outline {} --json", shell_word(path));
    let full_path = root.join(path);
    match sym::outline::file_outline(root, &full_path) {
        Ok(outline) => {
            let wanted_lines = diagnostics
                .iter()
                .filter_map(|diagnostic| diagnostic.start_line.map(|line| line as usize))
                .collect::<BTreeSet<_>>();
            let mut symbols = outline
                .into_iter()
                .filter(|symbol| {
                    wanted_lines.is_empty()
                        || wanted_lines
                            .iter()
                            .any(|line| (*line >= symbol.start_line) && (*line <= symbol.end_line))
                })
                .take(8)
                .map(|symbol| SymbolContextItem {
                    name: symbol.name,
                    kind: symbol.kind,
                    parent: symbol.parent,
                    start_line: symbol.start_line,
                    end_line: symbol.end_line,
                })
                .collect::<Vec<_>>();
            if symbols.is_empty() && wanted_lines.is_empty() {
                symbols = Vec::new();
            }
            SymbolGraphContext {
                status: "available".to_string(),
                command,
                symbols,
                error: None,
            }
        }
        Err(error) => SymbolGraphContext {
            status: "unavailable".to_string(),
            command,
            symbols: Vec::new(),
            error: Some(error.to_string()),
        },
    }
}

fn report_next_actions(path: &str, diagnostics: &[Diagnostic]) -> Vec<String> {
    let mut actions = vec![format!("ct source outline {} --json", shell_word(path))];
    if diagnostics.iter().any(|diagnostic| {
        matches!(
            diagnostic.severity,
            DiagnosticSeverity::Error | DiagnosticSeverity::Warning
        )
    }) {
        actions.push(format!(
            "ct lens diagnostics list --path {} --all --json",
            shell_word(path)
        ));
    }
    actions
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
                acknowledge: false,
            },
        )
        .unwrap();

        assert_eq!(envelope.data.status, TurnHealthStatus::Clean);
        assert!(!envelope.data.action_context.required);
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
                acknowledge: false,
            },
        )
        .unwrap();

        assert_eq!(envelope.data.status, TurnHealthStatus::Clean);
        assert!(envelope.data.summary.validation_plan.turn_active);
        assert!(!envelope.data.summary.validation_plan.cleanup_pending);
        assert!(envelope.data.compact.contains("clean"));
        assert!(!envelope.data.action_context.required);
    }

    #[test]
    fn context_acknowledgement_clears_required_state_for_same_fingerprint() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("main.rs"), "fn main() {}\n").unwrap();
        record_turn(temp.path());

        let context = build_action_context_envelope(
            temp.path(),
            TurnHealthOptions {
                session: "s".to_string(),
                turn: "t".to_string(),
                acknowledge: true,
            },
        )
        .unwrap();
        assert_eq!(context.data.state, "clear");
        assert!(!context.data.required);

        let health = build_turn_health_envelope(
            temp.path(),
            TurnHealthOptions {
                session: "s".to_string(),
                turn: "t".to_string(),
                acknowledge: false,
            },
        )
        .unwrap();
        assert!(!health.data.action_context.acknowledged);
        assert!(!health.data.action_context.required);
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
                acknowledge: false,
            },
        )
        .unwrap();

        assert!(compact_health_text(&health.data).contains("clean"));
        assert!(final_health_text(&health.data).contains("Lens final health: clean"));
        assert!(!final_health_text(&health.data).contains("Ack:"));
    }

    #[test]
    fn deep_report_includes_diagnostics_and_symbol_context() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("main.rs"), "fn target() {}\n").unwrap();
        record_turn(temp.path());
        let mut store = LensStore::open_for_project(temp.path()).unwrap();
        store.record_diagnostics(&[warning_diagnostic()]).unwrap();

        let report = build_changed_file_report_envelope(
            temp.path(),
            TurnHealthOptions {
                session: "s".to_string(),
                turn: "t".to_string(),
                acknowledge: false,
            },
            Some("main.rs"),
        )
        .unwrap();

        assert_eq!(report.data.file_count, 1);
        assert_eq!(report.data.files[0].diagnostics.len(), 1);
        assert!(!report.data.files[0].symbol_context.command.is_empty());
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
                acknowledge: false,
            },
        )
        .unwrap();

        assert_eq!(health.data.status, TurnHealthStatus::Warnings);
        assert!(!health.data.action_context.required);
        assert!(health.data.action_context.ack_command.is_none());
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
                acknowledge: false,
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
