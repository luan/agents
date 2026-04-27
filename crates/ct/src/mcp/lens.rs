use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ErrorData};
use rmcp::schemars::{self, JsonSchema};
use rmcp::{ServerHandler, tool, tool_handler, tool_router};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::json_success;

const LENS_MCP_RESPONSE_SCHEMA_VERSION: &str = "lens.mcp.response.v1";
const DEFAULT_LIMIT: usize = 10;

#[derive(Debug, Clone, Copy, Default)]
struct McpView {
    detail: bool,
    raw: bool,
}

#[derive(Debug, Clone, Serialize)]
struct LensMcpEnvelope {
    schema_version: &'static str,
    status: crate::lens::LensResponseStatus,
    summary: String,
    next_actions: Vec<String>,
    data: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    raw: Option<Value>,
    warnings: Vec<crate::lens::LensMessage>,
    errors: Vec<crate::lens::LensMessage>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct DiagnosticsIn {
    cwd: Option<String>,
    #[serde(default)]
    action: Option<String>,
    path: Option<String>,
    all: Option<bool>,
    source: Option<String>,
    scope_kind: Option<String>,
    scope_key: Option<String>,
    severity: Option<String>,
    code: Option<String>,
    message: Option<String>,
    start_line: Option<i64>,
    end_line: Option<i64>,
    fingerprint: Option<String>,
    snapshot: Option<Value>,
    detail: Option<bool>,
    raw: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct ChecksIn {
    cwd: Option<String>,
    #[serde(default)]
    action: Option<String>,
    automatic: Option<bool>,
    all: Option<bool>,
    #[serde(default)]
    name: Vec<String>,
    scanners: Option<bool>,
    detail: Option<bool>,
    raw: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct CleanupIn {
    cwd: Option<String>,
    session: String,
    turn: String,
    allow_unsafe: Option<bool>,
    detail: Option<bool>,
    raw: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct StatusIn {
    cwd: Option<String>,
    disk: Option<bool>,
    detail: Option<bool>,
    raw: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct HealthIn {
    cwd: Option<String>,
    session: String,
    turn: String,
    detail: Option<bool>,
    raw: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct TouchedIn {
    cwd: Option<String>,
    session: String,
    turn: String,
    detail: Option<bool>,
    raw: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct ContextIn {
    cwd: Option<String>,
    session: String,
    turn: String,
    ack: Option<bool>,
    detail: Option<bool>,
    raw: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct ReportIn {
    cwd: Option<String>,
    session: String,
    turn: String,
    path: Option<String>,
    detail: Option<bool>,
    raw: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct RawOutputIn {
    cwd: Option<String>,
    #[serde(default)]
    action: Option<String>,
    id: Option<i64>,
    limit: Option<usize>,
    detail: Option<bool>,
    raw: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct PruneIn {
    cwd: Option<String>,
    dry_run: Option<bool>,
    detail: Option<bool>,
    raw: Option<bool>,
}

#[derive(Clone)]
pub(super) struct LensMcpServer {
    tool_router: ToolRouter<Self>,
}

impl LensMcpServer {
    pub(super) fn new() -> Self {
        Self {
            tool_router: Self::tool_router(),
        }
    }
}

#[tool_router(router = tool_router)]
impl LensMcpServer {
    #[tool(
        name = "diagnostics",
        description = "List, record, or snapshot Lens diagnostics. action: list (default), record, snapshot."
    )]
    async fn diagnostics(
        &self,
        Parameters(input): Parameters<DiagnosticsIn>,
    ) -> Result<CallToolResult, ErrorData> {
        json_success(&diagnostics_mcp_response(input)?)
    }

    #[tool(
        name = "checks",
        description = "List or run repository-configured Lens checks and scanners. action: list (default), run."
    )]
    async fn checks(
        &self,
        Parameters(input): Parameters<ChecksIn>,
    ) -> Result<CallToolResult, ErrorData> {
        json_success(&checks_mcp_response(input)?)
    }

    #[tool(name = "status", description = "Show repository Lens status.")]
    async fn status(
        &self,
        Parameters(input): Parameters<StatusIn>,
    ) -> Result<CallToolResult, ErrorData> {
        json_success(&status_mcp_response(input)?)
    }

    #[tool(name = "health", description = "Show turn-scoped Lens health.")]
    async fn health(
        &self,
        Parameters(input): Parameters<HealthIn>,
    ) -> Result<CallToolResult, ErrorData> {
        json_success(&health_mcp_response(input)?)
    }

    #[tool(name = "touched", description = "List files touched during a turn.")]
    async fn touched(
        &self,
        Parameters(input): Parameters<TouchedIn>,
    ) -> Result<CallToolResult, ErrorData> {
        json_success(&touched_mcp_response(input)?)
    }

    #[tool(
        name = "cleanup",
        description = "Run Lens turn-end cleanup for touched files. Missing cleanup tools are returned as structured warnings."
    )]
    async fn cleanup(
        &self,
        Parameters(input): Parameters<CleanupIn>,
    ) -> Result<CallToolResult, ErrorData> {
        json_success(&cleanup_mcp_response(input)?)
    }

    #[tool(
        name = "report",
        description = "Show Lens changed-file reports for a turn, including diagnostics, cleanup, patch refs, and symbol context."
    )]
    async fn report(
        &self,
        Parameters(input): Parameters<ReportIn>,
    ) -> Result<CallToolResult, ErrorData> {
        json_success(&report_mcp_response(input)?)
    }

    #[tool(
        name = "context",
        description = "Show or acknowledge action-forcing Lens next-turn context."
    )]
    async fn context(
        &self,
        Parameters(input): Parameters<ContextIn>,
    ) -> Result<CallToolResult, ErrorData> {
        json_success(&context_mcp_response(input)?)
    }

    #[tool(
        name = "raw_output",
        description = "List or show retained sanitized Lens raw output. action: list (default), show."
    )]
    async fn raw_output(
        &self,
        Parameters(input): Parameters<RawOutputIn>,
    ) -> Result<CallToolResult, ErrorData> {
        json_success(&raw_output_mcp_response(input)?)
    }

    #[tool(
        name = "prune",
        description = "Prune Lens telemetry using retention policy."
    )]
    async fn prune(
        &self,
        Parameters(input): Parameters<PruneIn>,
    ) -> Result<CallToolResult, ErrorData> {
        json_success(&prune_mcp_response(input)?)
    }
}

fn diagnostics_mcp_response(input: DiagnosticsIn) -> Result<LensMcpEnvelope, ErrorData> {
    let view = view(input.detail, input.raw);
    let action = input.action.as_deref().unwrap_or("list");
    let envelope = match action {
        "list" => diagnostics_list_envelope(&input).and_then(value_envelope),
        "record" => diagnostics_record_envelope(&input),
        "snapshot" => diagnostics_snapshot_envelope(&input),
        other => {
            return Err(ErrorData::invalid_params(
                format!("invalid diagnostics action: {other}"),
                None,
            ));
        }
    }?;
    let summary = diagnostics_summary(action, &envelope.data);
    let next_actions = diagnostics_next_actions(action, &envelope.data, &envelope.warnings);
    let compact = compact_diagnostics_data(action, &envelope.data);
    mcp_from_lens(envelope, view, summary, next_actions, compact)
}

fn checks_mcp_response(input: ChecksIn) -> Result<LensMcpEnvelope, ErrorData> {
    let view = view(input.detail, input.raw);
    let action = input.action.as_deref().unwrap_or("list");
    let envelope = match action {
        "list" => checks_list_envelope(&input),
        "run" => checks_run_envelope(&input),
        other => {
            return Err(ErrorData::invalid_params(
                format!("invalid checks action: {other}"),
                None,
            ));
        }
    }?;
    let summary = checks_summary(action, &envelope.data);
    let next_actions = checks_next_actions(action, &envelope.data, &envelope.warnings);
    let compact = compact_checks_data(action, &envelope.data);
    mcp_from_lens(envelope, view, summary, next_actions, compact)
}

fn cleanup_mcp_response(input: CleanupIn) -> Result<LensMcpEnvelope, ErrorData> {
    let view = view(input.detail, input.raw);
    let envelope = cleanup_envelope(input)?;
    let summary = format!(
        "cleanup: {} run(s), {} mutation(s), {} diagnostic regression(s)",
        envelope.data.runs.len(),
        envelope.data.mutation_count,
        envelope.data.diagnostics.regression_count
    );
    let mut next_actions = hints(&envelope.warnings);
    next_actions.extend(envelope.data.suggestions.iter().map(|suggestion| {
        format!(
            "run {} manually if this wider cleanup is desired",
            suggestion.tool
        )
    }));
    let compact = json!({
        "project_id": envelope.data.project_id,
        "session": envelope.data.session,
        "turn": envelope.data.turn,
        "scoped_file_count": envelope.data.scoped_files.len(),
        "runs": envelope.data.runs.iter().map(compact_cleanup_run).collect::<Vec<_>>(),
        "suggestion_count": envelope.data.suggestions.len(),
        "mutation_count": envelope.data.mutation_count,
        "diagnostics": {
            "regression_count": envelope.data.diagnostics.regression_count,
            "post_cleanup_count": envelope.data.diagnostics.post_cleanup.diagnostic_count
        }
    });
    mcp_from_lens(envelope, view, summary, next_actions, compact)
}

fn health_mcp_response(input: HealthIn) -> Result<LensMcpEnvelope, ErrorData> {
    let view = view(input.detail, input.raw);
    turn_health_mcp_response(input, view)
}

fn turn_health_mcp_response(input: HealthIn, view: McpView) -> Result<LensMcpEnvelope, ErrorData> {
    let envelope = health_envelope(input)?;
    let summary = envelope.data.compact.clone();
    let mut next_actions = envelope.data.action_context.remediation.clone();
    if let Some(command) = &envelope.data.action_context.ack_command {
        next_actions.push(command.clone());
    }
    let compact = json!({
        "project_id": envelope.data.project_id,
        "session": envelope.data.session,
        "turn": envelope.data.turn,
        "status": envelope.data.status,
        "compact": envelope.data.compact,
        "action_required": envelope.data.action_context.required,
        "summary": {
            "changed_files": envelope.data.summary.changed_files.count,
            "diagnostics": envelope.data.summary.diagnostics,
            "cleanup": envelope.data.summary.cleanup,
            "checks": envelope.data.summary.checks,
            "patch_refs": envelope.data.summary.patch_refs
        }
    });
    mcp_from_lens(envelope, view, summary, next_actions, compact)
}

fn status_mcp_response(input: StatusIn) -> Result<LensMcpEnvelope, ErrorData> {
    let view = view(input.detail, input.raw);
    let envelope = status_envelope(input, view)?;
    let summary = format!(
        "lens status {:?}: {} diagnostic(s), {} patch draft(s)",
        envelope.status,
        envelope.data.state.counts.diagnostics,
        envelope.data.state.counts.patch_drafts
    );
    let next_actions = hints(&envelope.warnings);
    let compact = json!({
        "project_id": envelope.data.project_id,
        "state": {
            "stored_outside_repository": envelope.data.state.stored_outside_repository,
            "db_path": envelope.data.state.db_path,
            "counts": envelope.data.state.counts,
        },
        "health": envelope.data.health,
    });
    mcp_from_lens(envelope, view, summary, next_actions, compact)
}

fn report_mcp_response(input: ReportIn) -> Result<LensMcpEnvelope, ErrorData> {
    let view = view(input.detail, input.raw);
    let envelope = report_envelope(input)?;
    let summary = format!(
        "lens report {:?}: {} changed file(s)",
        envelope.data.status, envelope.data.file_count
    );
    let next_actions = envelope
        .data
        .files
        .iter()
        .flat_map(|file| file.next_actions.iter().cloned())
        .collect();
    let compact = json!({
        "project_id": envelope.data.project_id,
        "session": envelope.data.session,
        "turn": envelope.data.turn,
        "status": envelope.data.status,
        "file_count": envelope.data.file_count,
        "files": envelope.data.files.iter().map(compact_report_file).collect::<Vec<_>>()
    });
    mcp_from_lens(envelope, view, summary, next_actions, compact)
}

fn touched_mcp_response(input: TouchedIn) -> Result<LensMcpEnvelope, ErrorData> {
    let view = view(input.detail, input.raw);
    let envelope = touched_envelope(input)?;
    let summary = format!(
        "touched: {} file(s) for {}/{}",
        envelope.data.file_count, envelope.data.session, envelope.data.turn
    );
    let compact = json!({
        "project_id": envelope.data.project_id,
        "session": envelope.data.session,
        "turn": envelope.data.turn,
        "file_count": envelope.data.file_count,
        "files": envelope.data.files.clone(),
    });
    mcp_from_lens(envelope, view, summary, Vec::new(), compact)
}

fn context_mcp_response(input: ContextIn) -> Result<LensMcpEnvelope, ErrorData> {
    let view = view(input.detail, input.raw);
    let envelope = context_envelope(input)?;
    let summary = format!(
        "lens context: {} ({})",
        envelope.data.state, envelope.data.reason
    );
    let mut next_actions = envelope.data.remediation.clone();
    if let Some(command) = &envelope.data.ack_command {
        next_actions.push(command.clone());
    }
    let compact = json!({
        "required": envelope.data.required,
        "acknowledged": envelope.data.acknowledged,
        "state": envelope.data.state,
        "status": envelope.data.status,
        "reason": envelope.data.reason,
        "instructions": envelope.data.instructions,
        "ack_command": envelope.data.ack_command
    });
    mcp_from_lens(envelope, view, summary, next_actions, compact)
}

fn raw_output_mcp_response(input: RawOutputIn) -> Result<LensMcpEnvelope, ErrorData> {
    let view = view(input.detail, input.raw);
    let action = input.action.as_deref().unwrap_or("list");
    match action {
        "list" => {
            let envelope = raw_output_list_envelope(&input)?;
            let summary = format!(
                "raw output: {} retained item(s)",
                envelope.data.output_count
            );
            let compact = json!({
                "project_id": envelope.data.project_id,
                "output_count": envelope.data.output_count,
                "outputs": &envelope.data.outputs,
            });
            mcp_from_lens(envelope, view, summary, Vec::new(), compact)
        }
        "show" => {
            let envelope = raw_output_show_envelope(&input)?;
            let summary = format!(
                "raw output #{}: {} retained byte(s)",
                envelope.data.output.summary.id, envelope.data.output.summary.retained_bytes
            );
            let compact = json!({
                "project_id": envelope.data.project_id,
                "output": &envelope.data.output,
            });
            mcp_from_lens(envelope, view, summary, Vec::new(), compact)
        }
        other => Err(ErrorData::invalid_params(
            format!("invalid raw_output action: {other}"),
            None,
        )),
    }
}

fn prune_mcp_response(input: PruneIn) -> Result<LensMcpEnvelope, ErrorData> {
    let view = view(input.detail, input.raw);
    let envelope = prune_envelope(&input)?;
    let summary = format!(
        "prune: {} diagnostics, {} tool runs, {} sessions, {} raw outputs{}",
        envelope.data.diagnostics_deleted,
        envelope.data.tool_runs_deleted,
        envelope.data.sessions_deleted,
        envelope.data.raw_outputs_deleted,
        if envelope.data.dry_run {
            " (dry run)"
        } else {
            ""
        }
    );
    let compact = json!({
        "diagnostics_deleted": envelope.data.diagnostics_deleted,
        "tool_runs_deleted": envelope.data.tool_runs_deleted,
        "sessions_deleted": envelope.data.sessions_deleted,
        "patch_drafts_deleted": envelope.data.patch_drafts_deleted,
        "patch_draft_bodies_deleted": envelope.data.patch_draft_bodies_deleted,
        "raw_outputs_deleted": envelope.data.raw_outputs_deleted,
        "dry_run": envelope.data.dry_run,
    });
    mcp_from_lens(envelope, view, summary, Vec::new(), compact)
}

fn health_envelope(
    input: HealthIn,
) -> Result<crate::lens::LensEnvelope<crate::lens::TurnHealthData>, ErrorData> {
    let root = cwd(input.cwd)?;
    crate::lens::build_turn_health_envelope(
        &root,
        crate::lens::TurnHealthOptions {
            session: input.session,
            turn: input.turn,
            acknowledge: false,
        },
    )
    .map_err(|error| ErrorData::internal_error(error.to_string(), None))
}

fn context_envelope(
    input: ContextIn,
) -> Result<crate::lens::LensEnvelope<crate::lens::ActionContextState>, ErrorData> {
    let root = cwd(input.cwd)?;
    crate::lens::build_action_context_envelope(
        &root,
        crate::lens::TurnHealthOptions {
            session: input.session,
            turn: input.turn,
            acknowledge: input.ack.unwrap_or(false),
        },
    )
    .map_err(|error| ErrorData::internal_error(error.to_string(), None))
}

fn report_envelope(
    input: ReportIn,
) -> Result<crate::lens::LensEnvelope<crate::lens::ChangedFileReportData>, ErrorData> {
    let root = cwd(input.cwd)?;
    crate::lens::build_changed_file_report_envelope(
        &root,
        crate::lens::TurnHealthOptions {
            session: input.session,
            turn: input.turn,
            acknowledge: false,
        },
        input.path.as_deref(),
    )
    .map_err(|error| ErrorData::internal_error(error.to_string(), None))
}

fn raw_output_list_envelope(
    input: &RawOutputIn,
) -> Result<crate::lens::LensEnvelope<crate::lens::raw_output::RawOutputListData>, ErrorData> {
    let root = cwd(input.cwd.clone())?;
    crate::lens::raw_output::list_envelope(&root, input.limit.unwrap_or(DEFAULT_LIMIT))
        .map_err(|error| ErrorData::internal_error(error.to_string(), None))
}

fn raw_output_show_envelope(
    input: &RawOutputIn,
) -> Result<crate::lens::LensEnvelope<crate::lens::raw_output::RawOutputShowData>, ErrorData> {
    let root = cwd(input.cwd.clone())?;
    crate::lens::raw_output::show_envelope(&root, required(input.id, "id")?)
        .map_err(|error| ErrorData::internal_error(error.to_string(), None))
}

fn prune_envelope(
    input: &PruneIn,
) -> Result<crate::lens::LensEnvelope<crate::lens::retention::PruneReport>, ErrorData> {
    let root = cwd(input.cwd.clone())?;
    let store = crate::lens::LensStore::open_for_project(&root)
        .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
    let policy = crate::lens::resolve_policy(&root);
    let report = crate::lens::retention::prune(
        &store,
        &policy.policy.retention,
        input.dry_run.unwrap_or(false),
    )
    .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
    Ok(crate::lens::LensEnvelope::ok(report))
}

fn touched_envelope(
    input: TouchedIn,
) -> Result<crate::lens::LensEnvelope<crate::lens::LensTurnTouchedData>, ErrorData> {
    let root = cwd(input.cwd)?;
    crate::lens::touched_files_envelope(&root, &input.session, &input.turn)
        .map_err(|error| ErrorData::internal_error(error.to_string(), None))
}

fn cleanup_envelope(
    input: CleanupIn,
) -> Result<crate::lens::LensEnvelope<crate::lens::CleanupReport>, ErrorData> {
    let root = cwd(input.cwd)?;
    crate::lens::cleanup_turn_envelope(
        &root,
        &input.session,
        &input.turn,
        crate::lens::CleanupOptions {
            allow_unsafe: input.allow_unsafe.unwrap_or(false),
            ..crate::lens::CleanupOptions::default()
        },
    )
    .map_err(|error| ErrorData::internal_error(error.to_string(), None))
}

fn diagnostics_list_envelope(
    input: &DiagnosticsIn,
) -> Result<crate::lens::LensEnvelope<crate::lens::DiagnosticListData>, ErrorData> {
    let root = cwd(input.cwd.clone())?;
    let store = crate::lens::LensStore::open_for_project(&root)
        .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
    let data = store
        .list_diagnostics_data(input.path.as_deref(), input.all.unwrap_or(false))
        .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
    Ok(crate::lens::LensEnvelope::ok(data))
}

fn diagnostics_record_envelope(
    input: &DiagnosticsIn,
) -> Result<crate::lens::LensEnvelope<Value>, ErrorData> {
    let root = cwd(input.cwd.clone())?;
    let mut store = crate::lens::LensStore::open_for_project(&root)
        .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
    let source = required(input.source.clone(), "source")?;
    let severity = required(input.severity.clone(), "severity")?;
    let message = required(input.message.clone(), "message")?;
    let scope = diagnostic_scope(
        input.scope_kind.clone(),
        input.scope_key.clone(),
        input.path.as_deref(),
    );
    let fingerprint = input.fingerprint.clone().unwrap_or_else(|| {
        crate::apply_patch::sha1_hex(
            format!(
                "{}:{}:{}:{}:{:?}:{:?}:{:?}:{:?}:{}",
                source,
                scope.kind,
                scope.key,
                severity,
                input.path,
                input.start_line,
                input.end_line,
                input.code,
                message
            )
            .as_bytes(),
        )
    });
    let diagnostic = crate::lens::Diagnostic {
        source: parse_source(&source),
        scope,
        severity: parse_severity(&severity)?,
        code: input.code.clone(),
        message,
        rel_path: input.path.clone(),
        start_line: input.start_line,
        end_line: input.end_line,
        fingerprint,
        content_hash: None,
        raw_output_id: None,
        snapshot_id: None,
        first_seen_at: None,
        last_seen_at: None,
        resolved_at: None,
    };
    store
        .record_diagnostics(std::slice::from_ref(&diagnostic))
        .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
    Ok(crate::lens::LensEnvelope::ok(json!({
        "project_id": store.project_id(),
        "recorded": true,
        "diagnostic": diagnostic
    })))
}

fn diagnostics_snapshot_envelope(
    input: &DiagnosticsIn,
) -> Result<crate::lens::LensEnvelope<Value>, ErrorData> {
    let root = cwd(input.cwd.clone())?;
    let mut store = crate::lens::LensStore::open_for_project(&root)
        .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
    let snapshot_value = required(input.snapshot.clone(), "snapshot")?;
    let snapshot: crate::lens::DiagnosticSnapshotInput = serde_json::from_value(snapshot_value)
        .map_err(|error| ErrorData::invalid_params(error.to_string(), None))?;
    let result = store
        .record_diagnostic_snapshot(snapshot)
        .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
    Ok(crate::lens::LensEnvelope::ok(
        serde_json::to_value(result)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?,
    ))
}

fn checks_list_envelope(
    input: &ChecksIn,
) -> Result<crate::lens::LensEnvelope<crate::lens::LensChecksData>, ErrorData> {
    let root = cwd(input.cwd.clone())?;
    crate::lens::list_checks_envelope(&root)
        .map_err(|error| ErrorData::internal_error(error.to_string(), None))
}

fn checks_run_envelope(
    input: &ChecksIn,
) -> Result<crate::lens::LensEnvelope<crate::lens::LensChecksData>, ErrorData> {
    let root = cwd(input.cwd.clone())?;
    crate::lens::run_checks_envelope(
        &root,
        crate::lens::LensCheckRunOptions {
            automatic_only: input.automatic.unwrap_or(false)
                || (!input.all.unwrap_or(false) && input.name.is_empty()),
            names: input.name.clone(),
            include_scanners: input.scanners.unwrap_or(false) || input.all.unwrap_or(false),
        },
    )
    .map_err(|error| ErrorData::internal_error(error.to_string(), None))
}

fn status_envelope(
    input: StatusIn,
    view: McpView,
) -> Result<crate::lens::LensEnvelope<crate::lens::LensStatusData>, ErrorData> {
    let root = cwd(input.cwd)?;
    crate::lens::build_status_envelope(
        &root,
        crate::lens::LensStatusOptions {
            include_disk: input.disk.unwrap_or(false),
            include_debug: view.raw,
            include_raw: view.raw,
            ..crate::lens::LensStatusOptions::default()
        },
    )
    .map_err(|error| ErrorData::internal_error(error.to_string(), None))
}

fn mcp_from_lens<T: Serialize>(
    envelope: crate::lens::LensEnvelope<T>,
    view: McpView,
    summary: String,
    next_actions: Vec<String>,
    compact_data: Value,
) -> Result<LensMcpEnvelope, ErrorData> {
    let data = if view.detail {
        serde_json::to_value(&envelope.data)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?
    } else {
        compact_data
    };
    let raw = if view.raw {
        Some(
            serde_json::to_value(&envelope)
                .map_err(|error| ErrorData::internal_error(error.to_string(), None))?,
        )
    } else {
        None
    };
    Ok(LensMcpEnvelope {
        schema_version: LENS_MCP_RESPONSE_SCHEMA_VERSION,
        status: envelope.status,
        summary,
        next_actions,
        data,
        raw,
        warnings: envelope.warnings,
        errors: envelope.errors,
    })
}

fn value_envelope<T: Serialize>(
    envelope: crate::lens::LensEnvelope<T>,
) -> Result<crate::lens::LensEnvelope<Value>, ErrorData> {
    let data = serde_json::to_value(envelope.data)
        .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
    let mut out = match envelope.status {
        crate::lens::LensResponseStatus::Ok => crate::lens::LensEnvelope::ok(data),
        crate::lens::LensResponseStatus::Warning => {
            crate::lens::LensEnvelope::warning(data, envelope.warnings)
        }
        crate::lens::LensResponseStatus::Error => {
            crate::lens::LensEnvelope::error(data, envelope.errors)
        }
    };
    if let Some(debug) = envelope.debug {
        out = out.with_debug(debug);
    }
    if let Some(raw) = envelope.raw {
        out = out.with_raw(raw);
    }
    Ok(out)
}

fn compact_diagnostic(diagnostic: &Value) -> Value {
    json!({
        "source": diagnostic.get("source").cloned().unwrap_or(Value::Null),
        "severity": diagnostic.get("severity").cloned().unwrap_or(Value::Null),
        "path": diagnostic.get("rel_path").cloned().unwrap_or(Value::Null),
        "start_line": diagnostic.get("start_line").cloned().unwrap_or(Value::Null),
        "end_line": diagnostic.get("end_line").cloned().unwrap_or(Value::Null),
        "code": diagnostic.get("code").cloned().unwrap_or(Value::Null),
        "message": diagnostic.get("message").cloned().unwrap_or(Value::Null),
        "scope": diagnostic.get("scope").cloned().unwrap_or(Value::Null)
    })
}

fn compact_cleanup_run(run: &crate::lens::CleanupRunReport) -> Value {
    json!({
        "tool": run.tool,
        "status": run.status,
        "safety": run.safety,
        "mutability": run.mutability,
        "file_count": run.files.len(),
        "diagnostic_count": run.diagnostic_snapshot.as_ref().map(|snapshot| snapshot.diagnostic_count).unwrap_or(0),
        "mutation_count": run.mutations.len(),
        "timed_out": run.timed_out,
        "exit_code": run.exit_code
    })
}

fn compact_report_file(file: &crate::lens::ChangedFileReport) -> Value {
    json!({
        "path": file.path,
        "diagnostic_count": file.diagnostics.len(),
        "cleanup_action_count": file.cleanup_actions.len(),
        "patch_refs": file.patch_refs,
        "symbol_context": {
            "status": file.symbol_context.status,
            "command": file.symbol_context.command,
            "symbol_count": file.symbol_context.symbols.len(),
            "error": file.symbol_context.error
        },
        "next_actions": file.next_actions
    })
}

fn compact_diagnostics_data(action: &str, data: &Value) -> Value {
    match action {
        "list" => json!({
            "project_id": data.get("project_id").cloned().unwrap_or(Value::Null),
            "path": data.get("path").cloned().unwrap_or(Value::Null),
            "diagnostic_count": data.get("diagnostic_count").cloned().unwrap_or(Value::Null),
            "delta_count": data.get("delta_count").cloned().unwrap_or(Value::Null),
            "relevance": data.get("relevance").cloned().unwrap_or(Value::Null),
            "diagnostics": data.get("diagnostics")
                .and_then(Value::as_array)
                .map(|diagnostics| diagnostics.iter().take(DEFAULT_LIMIT).map(compact_diagnostic).collect::<Vec<_>>())
                .unwrap_or_default()
        }),
        "record" => json!({
            "project_id": data.get("project_id").cloned().unwrap_or(Value::Null),
            "recorded": data.get("recorded").cloned().unwrap_or(Value::Null),
            "diagnostic": data.get("diagnostic").map(compact_diagnostic).unwrap_or(Value::Null)
        }),
        "snapshot" => json!({
            "project_id": data.get("project_id").cloned().unwrap_or(Value::Null),
            "snapshot_id": data.get("snapshot_id").cloned().unwrap_or(Value::Null),
            "diagnostic_count": data.get("diagnostic_count").cloned().unwrap_or(Value::Null),
            "raw_output": data.get("raw_output").cloned().unwrap_or(Value::Null),
            "delta_counts": {
                "new": data.pointer("/deltas/new").and_then(Value::as_array).map(Vec::len).unwrap_or(0),
                "resolved": data.pointer("/deltas/resolved").and_then(Value::as_array).map(Vec::len).unwrap_or(0),
                "unchanged": data.pointer("/deltas/unchanged").and_then(Value::as_array).map(Vec::len).unwrap_or(0)
            }
        }),
        _ => data.clone(),
    }
}

fn compact_checks_data(action: &str, data: &crate::lens::LensChecksData) -> Value {
    json!({
        "project_id": data.project_id,
        "configured_check_count": data.configured_checks.len(),
        "configured_scanner_count": data.configured_scanners.len(),
        "suggestion_count": data.suggestions.len(),
        "runs": data.runs.iter().take(DEFAULT_LIMIT).map(compact_check_run).collect::<Vec<_>>(),
        "action": action,
    })
}

fn compact_check_run(run: &crate::lens::LensCheckRunSummary) -> Value {
    json!({
        "name": run.name,
        "kind": run.kind,
        "status": run.status,
        "exit_code": run.exit_code,
        "diagnostic_count": run.diagnostic_count,
        "snapshot_id": run.snapshot.as_ref().map(|snapshot| snapshot.snapshot_id),
        "raw_output": run.snapshot.as_ref().and_then(|snapshot| snapshot.raw_output.as_ref()),
    })
}

fn diagnostics_summary(action: &str, data: &Value) -> String {
    match action {
        "list" => format!(
            "diagnostics: {} active/relevant, {} delta(s)",
            data.get("diagnostic_count")
                .and_then(Value::as_u64)
                .unwrap_or(0),
            data.get("delta_count").and_then(Value::as_u64).unwrap_or(0)
        ),
        "record" => "diagnostic recorded".to_string(),
        "snapshot" => format!(
            "diagnostic snapshot: {} diagnostic(s), {} new, {} resolved",
            data.get("diagnostic_count")
                .and_then(Value::as_u64)
                .unwrap_or(0),
            data.pointer("/deltas/new")
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or(0),
            data.pointer("/deltas/resolved")
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or(0)
        ),
        _ => "diagnostics".to_string(),
    }
}

fn diagnostics_next_actions(
    action: &str,
    data: &Value,
    warnings: &[crate::lens::LensMessage],
) -> Vec<String> {
    let mut actions = hints(warnings);
    if action == "list"
        && data
            .get("diagnostic_count")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            > 0
    {
        actions.push("fix listed diagnostics or record a fresh diagnostic snapshot".to_string());
    }
    actions
}

fn checks_summary(action: &str, data: &crate::lens::LensChecksData) -> String {
    match action {
        "run" => format!(
            "checks: {} run(s), {} diagnostic(s)",
            data.runs.len(),
            data.runs
                .iter()
                .map(|run| run.diagnostic_count)
                .sum::<usize>()
        ),
        _ => format!(
            "checks: {} configured check(s), {} scanner(s), {} suggestion(s)",
            data.configured_checks.len(),
            data.configured_scanners.len(),
            data.suggestions.len()
        ),
    }
}

fn checks_next_actions(
    action: &str,
    data: &crate::lens::LensChecksData,
    warnings: &[crate::lens::LensMessage],
) -> Vec<String> {
    let mut actions = hints(warnings);
    if action == "run" && data.runs.iter().any(|run| run.diagnostic_count > 0) {
        actions.push("fix reported diagnostics or rerun ct lens checks run --all".to_string());
    }
    actions
}

fn hints(messages: &[crate::lens::LensMessage]) -> Vec<String> {
    messages
        .iter()
        .map(|message| {
            message
                .hint
                .clone()
                .unwrap_or_else(|| message.message.clone())
        })
        .collect()
}

fn view(detail: Option<bool>, raw: Option<bool>) -> McpView {
    McpView {
        detail: detail.unwrap_or(false),
        raw: raw.unwrap_or(false),
    }
}

fn required<T>(value: Option<T>, name: &str) -> Result<T, ErrorData> {
    value.ok_or_else(|| ErrorData::invalid_params(format!("missing required field: {name}"), None))
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

fn parse_source(source: &str) -> crate::lens::DiagnosticSource {
    match source {
        "lsp" => crate::lens::DiagnosticSource::Lsp,
        "ast_grep" => crate::lens::DiagnosticSource::AstGrep,
        "tree_sitter" => crate::lens::DiagnosticSource::TreeSitter,
        "secrets" => crate::lens::DiagnosticSource::Secrets,
        "security" => crate::lens::DiagnosticSource::Security,
        "formatter" => crate::lens::DiagnosticSource::Formatter,
        "autofix" => crate::lens::DiagnosticSource::Autofix,
        "test" => crate::lens::DiagnosticSource::Test,
        other => crate::lens::DiagnosticSource::Other(other.to_string()),
    }
}

fn parse_severity(severity: &str) -> Result<crate::lens::DiagnosticSeverity, ErrorData> {
    match severity {
        "error" => Ok(crate::lens::DiagnosticSeverity::Error),
        "warning" => Ok(crate::lens::DiagnosticSeverity::Warning),
        "info" => Ok(crate::lens::DiagnosticSeverity::Info),
        "hint" => Ok(crate::lens::DiagnosticSeverity::Hint),
        other => Err(ErrorData::invalid_params(
            format!("invalid diagnostic severity: {other}"),
            None,
        )),
    }
}

fn cwd(input: Option<String>) -> Result<std::path::PathBuf, ErrorData> {
    match input {
        Some(cwd) => Ok(std::path::PathBuf::from(cwd)),
        None => std::env::current_dir()
            .map_err(|error| ErrorData::internal_error(error.to_string(), None)),
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for LensMcpServer {
    fn get_info(&self) -> rmcp::model::ServerInfo {
        rmcp::model::ServerInfo::new(
            rmcp::model::ServerCapabilities::builder()
                .enable_tools()
                .build(),
        )
        .with_server_info(rmcp::model::Implementation::new(
            "lens",
            env!("CARGO_PKG_VERSION"),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_checks_and_diagnostics_responses_omit_read_guard_fields() {
        let temp = tempfile::tempdir().unwrap();
        let checks = checks_mcp_response(ChecksIn {
            cwd: Some(temp.path().display().to_string()),
            action: Some("list".to_string()),
            automatic: None,
            all: None,
            name: Vec::new(),
            scanners: None,
            detail: Some(true),
            raw: None,
        })
        .unwrap();
        assert_eq!(checks.schema_version, LENS_MCP_RESPONSE_SCHEMA_VERSION);
        assert!(checks.data.get("configured_checks").is_some());
        assert!(checks.data.get("read_files").is_none());
        assert!(checks.data.get("guard").is_none());

        let diagnostics = diagnostics_mcp_response(DiagnosticsIn {
            cwd: Some(temp.path().display().to_string()),
            action: Some("list".to_string()),
            path: None,
            all: None,
            source: None,
            scope_kind: None,
            scope_key: None,
            severity: None,
            code: None,
            message: None,
            start_line: None,
            end_line: None,
            fingerprint: None,
            snapshot: None,
            detail: Some(true),
            raw: None,
        })
        .unwrap();
        assert!(diagnostics.data.get("relevance").is_some());
        assert!(diagnostics.data.get("read_files").is_none());
        assert!(diagnostics.data.get("guard").is_none());
        assert!(diagnostics.data["relevance"].get("read_files").is_none());
    }

    #[test]
    fn mcp_tool_names_omit_discovery_and_guard() {
        let server = LensMcpServer::new();
        let names = server
            .tool_router
            .list_all()
            .into_iter()
            .map(|tool| tool.name.to_string())
            .collect::<Vec<_>>();

        assert_eq!(
            names,
            vec![
                "checks",
                "cleanup",
                "context",
                "diagnostics",
                "health",
                "prune",
                "raw_output",
                "report",
                "status",
                "touched"
            ]
        );
        assert!(
            !names
                .iter()
                .any(|name| name == "discover" || name == "guard")
        );
        assert!(names.iter().all(|name| !name.starts_with("lens_")));
    }
}
