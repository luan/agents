use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::contract::{LensEnvelope, LensMessage, LensResponseStatus};
use super::store::LensStore;
use super::types::{
    Diagnostic, DiagnosticDeltaSet, DiagnosticSeverity, GuardAction, GuardDecision, LensTouchedFile,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnHealthStatus {
    Clean,
    Warning,
    Error,
}

impl TurnHealthStatus {
    pub fn is_warning_or_worse(&self) -> bool {
        !matches!(self, Self::Clean)
    }

    fn envelope_status(&self) -> LensResponseStatus {
        match self {
            Self::Clean => LensResponseStatus::Ok,
            Self::Warning => LensResponseStatus::Warning,
            Self::Error => LensResponseStatus::Error,
        }
    }

    fn as_str(&self) -> &'static str {
        match self {
            Self::Clean => "clean",
            Self::Warning => "warning",
            Self::Error => "error",
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
    pub action_context: ActionContextState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TurnHealthSummary {
    pub changed_files: ChangedFilesSummary,
    pub reads: ReadSummary,
    pub guard: GuardSummary,
    pub cleanup: CleanupSummary,
    pub diagnostics: DiagnosticSummary,
    pub checks: CheckSummary,
    pub patch_refs: PatchRefSummary,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangedFilesSummary {
    pub count: usize,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadSummary {
    pub count: usize,
    pub files: Vec<String>,
    pub ranges: Vec<ReadFileRange>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadFileRange {
    pub path: String,
    pub start_line: i64,
    pub end_line: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GuardSummary {
    pub clean: usize,
    pub warnings: usize,
    pub blocked: usize,
    pub decisions: Vec<GuardDecision>,
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
    pub guard: Option<GuardDecision>,
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
    let mut context = health.action_context;
    if options.acknowledge && context.required && !context.acknowledged {
        acknowledge_context(&store, &options.session, &options.turn, &context)?;
        context.acknowledged = true;
        context.required = false;
        context.state = "acknowledged".to_string();
        context.ack_command = None;
    }
    Ok(context_envelope(context))
}

pub fn build_changed_file_report_envelope(
    root: &Path,
    options: TurnHealthOptions,
    path: Option<&str>,
) -> Result<LensEnvelope<ChangedFileReportData>, Box<dyn std::error::Error>> {
    let mut store = LensStore::open_for_project(root)?;
    let health = compute_turn_health(root, &mut store, &options)?;
    let touched = store.list_touched_files(&options.session, &options.turn)?;
    let mut by_path: BTreeMap<String, Vec<LensTouchedFile>> = BTreeMap::new();
    for file in touched {
        if path.is_none_or(|wanted| wanted == file.path) {
            by_path.entry(file.path.clone()).or_default().push(file);
        }
    }
    let mut files = Vec::new();
    for (file_path, touched) in by_path {
        let diagnostics = store.list_diagnostics(Some(&file_path))?;
        let guard = health
            .summary
            .guard
            .decisions
            .iter()
            .find(|decision| decision.file == file_path)
            .cloned();
        let cleanup_actions =
            cleanup_actions_for_file(&store, &options.session, &options.turn, &file_path)?;
        let patch_refs = patch_refs_for_file(&store, &options.session, &file_path)?;
        let symbol_context = symbol_context(root, &file_path, &diagnostics);
        let next_actions = report_next_actions(&options, &file_path, &diagnostics, guard.as_ref());
        files.push(ChangedFileReport {
            path: file_path,
            touched,
            diagnostics,
            guard,
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
    if data.action_context.required {
        lines.push(format!(
            "Next turn should review: {}",
            data.action_context.reason
        ));
        if let Some(command) = &data.action_context.ack_command {
            lines.push(format!("Ack: {command}"));
        }
    }
    for action in &data.action_context.remediation {
        lines.push(format!("Remediate: {action}"));
    }
    lines.join("\n")
}

fn compute_turn_health(
    root: &Path,
    store: &mut LensStore,
    options: &TurnHealthOptions,
) -> Result<TurnHealthData, Box<dyn std::error::Error>> {
    let touched = store.list_touched_files(&options.session, &options.turn)?;
    let changed_paths = unique_changed_paths(&touched);
    let reads = read_summary(store, &options.session)?;
    let guard = guard_summary(root, store, &options.session, &touched)?;
    let cleanup = cleanup_summary(store, &options.session, &options.turn)?;
    let diagnostics_data = store.list_diagnostics_data(None, false)?;
    let diagnostics = diagnostic_summary(&diagnostics_data.diagnostics, &diagnostics_data.deltas);
    let checks = check_summary(store)?;
    let patch_refs = patch_ref_summary(store, &options.session, &changed_paths)?;
    let status = compute_status(&guard, &cleanup, &diagnostics, &checks);
    let summary = TurnHealthSummary {
        changed_files: ChangedFilesSummary {
            count: changed_paths.len(),
            paths: changed_paths.iter().cloned().collect(),
        },
        reads,
        guard,
        cleanup,
        diagnostics,
        checks,
        patch_refs,
    };
    let compact = compact_summary(&status, &summary);
    let fingerprint = health_fingerprint(&status, &summary);
    let acknowledged = is_acknowledged(store, &options.session, &options.turn, &fingerprint)?;
    let action_context = action_context(
        &options.session,
        &options.turn,
        status.clone(),
        compact.clone(),
        fingerprint,
        acknowledged,
        &summary,
    );
    Ok(TurnHealthData {
        project_id: store.project_id(),
        session: options.session.clone(),
        turn: options.turn.clone(),
        status,
        compact,
        summary,
        action_context,
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
    if !data.status.is_warning_or_worse() {
        return Vec::new();
    }
    let hint = data
        .action_context
        .ack_command
        .clone()
        .unwrap_or_else(|| "remediate findings or acknowledge Lens context".to_string());
    let message = match data.status {
        TurnHealthStatus::Warning => LensMessage::warning_with_hint(
            "lens_health_warning",
            data.action_context.reason.clone(),
            hint,
        ),
        TurnHealthStatus::Error => {
            LensMessage::error("lens_health_error", data.action_context.reason.clone())
        }
        TurnHealthStatus::Clean => return Vec::new(),
    };
    vec![message]
}

fn unique_changed_paths(touched: &[LensTouchedFile]) -> BTreeSet<String> {
    touched
        .iter()
        .filter(|file| !file.ignored && !file.generated)
        .map(|file| file.path.clone())
        .collect()
}

fn read_summary(
    store: &LensStore,
    session: &str,
) -> Result<ReadSummary, Box<dyn std::error::Error>> {
    store.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT f.rel_path, rr.start_line, rr.end_line
             FROM read_events re
             JOIN read_ranges rr ON rr.read_event_id = re.id
             JOIN files f ON f.id = re.file_id
             WHERE f.project_id=?1 AND re.session_id=?2
             ORDER BY f.rel_path, rr.start_line, rr.end_line",
        )?;
        let rows = stmt.query_map(params![store.project_id(), session], |row| {
            Ok(ReadFileRange {
                path: row.get(0)?,
                start_line: row.get(1)?,
                end_line: row.get(2)?,
            })
        })?;
        let ranges = rows.collect::<Result<Vec<_>, _>>()?;
        let files = ranges
            .iter()
            .map(|range| range.path.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        Ok(ReadSummary {
            count: ranges.len(),
            files,
            ranges,
        })
    })
}

fn guard_summary(
    root: &Path,
    store: &mut LensStore,
    session: &str,
    touched: &[LensTouchedFile],
) -> Result<GuardSummary, Box<dyn std::error::Error>> {
    let requested = GuardAction::Warn;
    let mut seen = BTreeSet::new();
    let mut decisions = Vec::new();
    for file in touched {
        if !is_write_operation(&file.operation) || file.ignored || file.generated {
            continue;
        }
        if !seen.insert(file.path.clone()) {
            continue;
        }
        let end_line = known_line_count(store, root, &file.path)
            .unwrap_or(1)
            .max(1);
        let decision = store.check_guard(
            Some(session),
            Path::new(&file.path),
            1,
            end_line,
            requested.clone(),
        )?;
        decisions.push(decision);
    }
    let mut summary = GuardSummary {
        clean: 0,
        warnings: 0,
        blocked: 0,
        decisions,
    };
    for decision in &summary.decisions {
        match decision.decision {
            GuardAction::Allow => summary.clean += 1,
            GuardAction::Warn => summary.warnings += 1,
            GuardAction::Block => summary.blocked += 1,
        }
    }
    Ok(summary)
}

fn cleanup_summary(
    store: &LensStore,
    session: &str,
    turn: &str,
) -> Result<CleanupSummary, Box<dyn std::error::Error>> {
    store.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT status, mutation_count, diagnostic_snapshot_id, raw_output_id
             FROM cleanup_runs
             WHERE project_id=?1 AND session_id=?2 AND turn_id=?3
             ORDER BY created_at DESC, id DESC",
        )?;
        let rows = stmt.query_map(params![store.project_id(), session, turn], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Option<i64>>(2)?,
                row.get::<_, Option<i64>>(3)?,
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
        for row in rows {
            let (status, mutations, diagnostic_snapshot_id, raw_output_id) = row?;
            summary.runs += 1;
            summary.mutations += mutations.max(0) as usize;
            if diagnostic_snapshot_id.is_some() {
                summary.diagnostics +=
                    cleanup_snapshot_diagnostic_count(conn, diagnostic_snapshot_id)?;
            }
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
             LIMIT 5",
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
        Ok(CheckSummary {
            snapshots: snapshots.max(0) as usize,
            latest: rows.collect::<Result<Vec<_>, _>>()?,
        })
    })
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

fn compute_status(
    _guard: &GuardSummary,
    cleanup: &CleanupSummary,
    diagnostics: &DiagnosticSummary,
    checks: &CheckSummary,
) -> TurnHealthStatus {
    if diagnostics.errors > 0
        || cleanup.failed > 0
        || cleanup.timed_out > 0
        || check_errors(checks) > 0
    {
        TurnHealthStatus::Error
    } else if diagnostics.warnings > 0
        || diagnostics.deltas.new > 0
        || cleanup.diagnostics > 0
        || cleanup.skipped > 0
        || check_warnings(checks) > 0
    {
        TurnHealthStatus::Warning
    } else {
        TurnHealthStatus::Clean
    }
}

fn compact_summary(status: &TurnHealthStatus, summary: &TurnHealthSummary) -> String {
    let mut parts = vec![format!(
        "{} · {} changed",
        status.as_str(),
        summary.changed_files.count
    )];
    if summary.diagnostics.active > 0
        || summary.diagnostics.errors > 0
        || summary.diagnostics.warnings > 0
        || summary.diagnostics.deltas.new > 0
    {
        parts.push(format!(
            "diag {} ({} err/{} warn)",
            summary.diagnostics.active, summary.diagnostics.errors, summary.diagnostics.warnings
        ));
    }
    if summary.cleanup.failed > 0 || summary.cleanup.timed_out > 0 || summary.cleanup.skipped > 0 {
        parts.push(format!(
            "cleanup {} failed/{} timeout",
            summary.cleanup.failed, summary.cleanup.timed_out
        ));
    }
    let check_failures = check_errors(&summary.checks);
    let check_warnings = check_warnings(&summary.checks);
    if check_failures > 0 || check_warnings > 0 {
        parts.push(format!("checks {check_failures} err/{check_warnings} warn"));
    }
    if summary.patch_refs.hunks > 0 || summary.patch_refs.accepted_events > 0 {
        parts.push(format!(
            "patch {}/{}",
            summary.patch_refs.accepted_events, summary.patch_refs.hunks
        ));
    }
    parts.join(" · ")
}

fn health_fingerprint(status: &TurnHealthStatus, summary: &TurnHealthSummary) -> String {
    let value = serde_json::json!({
        "status": status,
        "changed": summary.changed_files.paths,
        "guard": {"warnings": summary.guard.warnings, "blocked": summary.guard.blocked},
        "diagnostics": summary.diagnostics,
        "cleanup": summary.cleanup,
        "checks": summary.checks,
        "patch_refs": summary.patch_refs,
    });
    crate::apply_patch::sha1_hex(value.to_string().as_bytes())
}

fn is_acknowledged(
    store: &LensStore,
    session: &str,
    turn: &str,
    fingerprint: &str,
) -> Result<bool, Box<dyn std::error::Error>> {
    store.with_conn(|conn| {
        let found: Option<i64> = conn
            .query_row(
                "SELECT id FROM lens_action_acknowledgements
                 WHERE project_id=?1 AND session_id=?2 AND turn_id=?3 AND health_fingerprint=?4
                 LIMIT 1",
                params![store.project_id(), session, turn, fingerprint],
                |row| row.get(0),
            )
            .optional()?;
        Ok(found.is_some())
    })
}

fn acknowledge_context(
    store: &LensStore,
    session: &str,
    turn: &str,
    context: &ActionContextState,
) -> Result<(), Box<dyn std::error::Error>> {
    store.with_conn(|conn| {
        conn.execute(
            "INSERT OR IGNORE INTO lens_action_acknowledgements(project_id, session_id, turn_id, health_fingerprint, status, created_at)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                store.project_id(),
                session,
                turn,
                context.fingerprint,
                context.status.as_str(),
                now_ms()
            ],
        )?;
        Ok(())
    })
}

fn action_context(
    session: &str,
    turn: &str,
    status: TurnHealthStatus,
    compact: String,
    fingerprint: String,
    acknowledged: bool,
    summary: &TurnHealthSummary,
) -> ActionContextState {
    let actionable = matches!(status, TurnHealthStatus::Error);
    let required = actionable && !acknowledged;
    let state = if !actionable {
        "clear"
    } else if acknowledged {
        "acknowledged"
    } else {
        "required"
    }
    .to_string();
    let mut remediation = Vec::new();
    if summary.diagnostics.errors > 0 || summary.diagnostics.warnings > 0 {
        remediation
            .push("fix or snapshot diagnostics with ct lens diagnostics list --all".to_string());
    }
    if summary.cleanup.failed > 0 || summary.cleanup.timed_out > 0 || summary.cleanup.skipped > 0 {
        remediation
            .push("inspect cleanup output and rerun ct lens cleanup run if safe".to_string());
    }
    if summary
        .checks
        .latest
        .iter()
        .any(|check| check.exit_code.unwrap_or(0) != 0)
    {
        remediation.push("rerun failing checks with ct lens checks run --all".to_string());
    }
    if remediation.is_empty() && status.is_warning_or_worse() {
        remediation.push("inspect ct lens report for changed-file details".to_string());
    }
    ActionContextState {
        required,
        acknowledged,
        state,
        fingerprint,
        status,
        reason: compact,
        instructions: "Review this Lens context or remediate the listed findings when useful."
            .to_string(),
        ack_command: required.then(|| {
            format!(
                "ct lens context --session {} --turn {} --ack --json",
                shell_word(session),
                shell_word(turn)
            )
        }),
        remediation,
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
    let command = format!("ct sym outline {}", shell_word(path));
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

fn report_next_actions(
    options: &TurnHealthOptions,
    path: &str,
    diagnostics: &[Diagnostic],
    guard: Option<&GuardDecision>,
) -> Vec<String> {
    let mut actions = vec![format!(
        "ct lens discover --intent source-context --path {} --session {} --json",
        shell_word(path),
        shell_word(&options.session)
    )];
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
    if guard.is_some_and(|decision| !matches!(decision.decision, GuardAction::Allow)) {
        actions.push(format!(
            "ct lens read record --path {} --start-line 1 --end-line <line> --session {} --json",
            shell_word(path),
            shell_word(&options.session)
        ));
    }
    actions
}

fn known_line_count(store: &LensStore, root: &Path, path: &str) -> Option<i64> {
    let from_store = store.with_conn(|conn| {
        conn.query_row(
            "SELECT line_count FROM files WHERE project_id=?1 AND rel_path=?2",
            params![store.project_id(), path],
            |row| row.get::<_, Option<i64>>(0),
        )
        .optional()
        .ok()
        .flatten()
        .flatten()
    });
    from_store.or_else(|| {
        std::fs::read_to_string(root.join(path))
            .ok()
            .map(|text| text.lines().count().max(1) as i64)
    })
}

fn is_write_operation(operation: &str) -> bool {
    matches!(
        operation,
        "create" | "write" | "modify" | "edit" | "delete" | "rename"
    )
}

fn check_errors(checks: &CheckSummary) -> usize {
    checks
        .latest
        .iter()
        .filter(|check| check.exit_code.is_some_and(|code| code != 0) && check.diagnostic_count > 0)
        .count()
}

fn check_warnings(checks: &CheckSummary) -> usize {
    checks
        .latest
        .iter()
        .filter(|check| check.exit_code.is_none() && check.diagnostic_count > 0)
        .count()
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

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
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
        let event = event(root);
        let (touched, _) = crate::lens::turn::touched_files_from_event(root, root, &event).unwrap();
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
    fn health_status_computation_keeps_guard_findings_advisory() {
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
        assert_eq!(envelope.data.summary.guard.warnings, 1);
        assert_eq!(envelope.data.summary.guard.blocked, 0);
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
    fn compact_and_final_output_stay_quiet_for_guard_advisory() {
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
    fn deep_report_includes_diagnostics_guard_and_symbol_context() {
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
        assert!(report.data.files[0].guard.is_some());
        assert!(!report.data.files[0].symbol_context.command.is_empty());
    }

    #[test]
    fn warning_diagnostics_do_not_force_action_context() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("main.rs"), "fn main() {}\n").unwrap();
        let mut store = LensStore::open_for_project(temp.path()).unwrap();
        store
            .record_read(Some("s"), Path::new("main.rs"), 1, 1)
            .unwrap();
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

        assert_eq!(health.data.status, TurnHealthStatus::Warning);
        assert!(!health.data.action_context.required);
        assert!(health.data.action_context.ack_command.is_none());
    }
}
