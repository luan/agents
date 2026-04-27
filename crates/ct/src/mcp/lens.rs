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
const DEFAULT_CONTEXT: usize = 2;

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
struct DiscoverIn {
    cwd: Option<String>,
    intent: String,
    query: Option<String>,
    path: Option<String>,
    line: Option<usize>,
    end_line: Option<usize>,
    character: Option<usize>,
    lang: Option<String>,
    limit: Option<usize>,
    context: Option<usize>,
    session: Option<String>,
    lsp_operation: Option<String>,
    detail: Option<bool>,
    raw: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct GuardIn {
    cwd: Option<String>,
    #[serde(default)]
    action: Option<String>,
    path: String,
    start_line: Option<i64>,
    end_line: Option<i64>,
    session: Option<String>,
    mode: Option<String>,
    detail: Option<bool>,
    raw: Option<bool>,
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
struct CleanupIn {
    cwd: Option<String>,
    session: String,
    turn: String,
    allow_unsafe: Option<bool>,
    detail: Option<bool>,
    raw: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct HealthIn {
    cwd: Option<String>,
    operation: Option<String>,
    session: Option<String>,
    turn: Option<String>,
    disk: Option<bool>,
    guard_mode: Option<String>,
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
        name = "discover",
        description = "Discover Lens code context through symbol, source, AST, and LSP backends. Compact by default; pass detail/raw for full backend JSON."
    )]
    async fn discover(
        &self,
        Parameters(input): Parameters<DiscoverIn>,
    ) -> Result<CallToolResult, ErrorData> {
        json_success(&discover_mcp_response(input)?)
    }

    #[tool(
        name = "guard",
        description = "Check Lens read-before-write guard coverage or record a read range. action: check (default), record_read/read, allow_once."
    )]
    async fn guard(
        &self,
        Parameters(input): Parameters<GuardIn>,
    ) -> Result<CallToolResult, ErrorData> {
        json_success(&guard_mcp_response(input)?)
    }

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
        name = "health",
        description = "Show Lens health. With session+turn returns turn health; with operation=status returns repository Lens status."
    )]
    async fn health(
        &self,
        Parameters(input): Parameters<HealthIn>,
    ) -> Result<CallToolResult, ErrorData> {
        json_success(&health_mcp_response(input)?)
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
        description = "Show Lens changed-file reports for a turn, including diagnostics, guard, cleanup, patch refs, and symbol context."
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
}

fn discover_mcp_response(input: DiscoverIn) -> Result<LensMcpEnvelope, ErrorData> {
    let view = view(input.detail, input.raw);
    let envelope = discover_envelope(input, view)?;
    let summary = format!(
        "discover {} via {}: {} result(s)",
        envelope.data.route.intent, envelope.data.route.backend, envelope.data.item_count
    );
    let next_actions = envelope
        .data
        .next_actions
        .iter()
        .map(|action| format!("{}: {}", action.label, action.command))
        .collect();
    let compact = json!({
        "route": envelope.data.route,
        "item_count": envelope.data.item_count,
        "items": envelope.data.items.iter().map(compact_discovery_item).collect::<Vec<_>>(),
        "coverage": envelope.data.coverage,
        "alternative_count": envelope.data.alternatives.len()
    });
    mcp_from_lens(envelope, view, summary, next_actions, compact)
}

fn guard_mcp_response(input: GuardIn) -> Result<LensMcpEnvelope, ErrorData> {
    let view = view(input.detail, input.raw);
    let action = input.action.as_deref().unwrap_or("check");
    let envelope = match action {
        "check" => guard_check_envelope(&input)?,
        "record_read" | "read" => guard_record_read_envelope(&input)?,
        "allow_once" => guard_allow_once_envelope(&input)?,
        other => {
            return Err(ErrorData::invalid_params(
                format!("invalid guard action: {other}"),
                None,
            ));
        }
    };
    let summary = guard_summary(action, &envelope.data);
    let next_actions = guard_next_actions(&envelope.data, &envelope.warnings, &envelope.errors);
    let compact = compact_guard_data(action, &envelope.data);
    mcp_from_lens(envelope, view, summary, next_actions, compact)
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
    let operation = input.operation.as_deref().unwrap_or_else(|| {
        if input.session.is_some() || input.turn.is_some() {
            "turn"
        } else {
            "status"
        }
    });
    match operation {
        "turn" => turn_health_mcp_response(input, view),
        "status" => status_mcp_response(input, view),
        other => Err(ErrorData::invalid_params(
            format!("invalid health operation: {other}"),
            None,
        )),
    }
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
            "reads": envelope.data.summary.reads.count,
            "guard": {
                "clean": envelope.data.summary.guard.clean,
                "warnings": envelope.data.summary.guard.warnings,
                "blocked": envelope.data.summary.guard.blocked
            },
            "diagnostics": envelope.data.summary.diagnostics,
            "cleanup": envelope.data.summary.cleanup,
            "checks": envelope.data.summary.checks,
            "patch_refs": envelope.data.summary.patch_refs
        }
    });
    mcp_from_lens(envelope, view, summary, next_actions, compact)
}

fn status_mcp_response(input: HealthIn, view: McpView) -> Result<LensMcpEnvelope, ErrorData> {
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
        "guard": envelope.data.policy.policy.guard,
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

fn health_envelope(
    input: HealthIn,
) -> Result<crate::lens::LensEnvelope<crate::lens::TurnHealthData>, ErrorData> {
    let root = cwd(input.cwd)?;
    let session = required(input.session, "session")?;
    let turn = required(input.turn, "turn")?;
    crate::lens::build_turn_health_envelope(
        &root,
        crate::lens::TurnHealthOptions {
            session,
            turn,
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

fn discover_envelope(
    input: DiscoverIn,
    view: McpView,
) -> Result<crate::lens::LensEnvelope<crate::lens::DiscoveryData>, ErrorData> {
    let root = cwd(input.cwd)?;
    let intent = crate::lens::DiscoveryIntent::parse(&input.intent)
        .map_err(|error| ErrorData::invalid_params(error.to_string(), None))?;
    let mut options = crate::lens::DiscoveryOptions::new(root, intent);
    options.query = input.query;
    options.path = input.path;
    options.line = input.line;
    options.end_line = input.end_line;
    options.character = input.character;
    options.lang = input.lang;
    options.limit = input.limit.unwrap_or(DEFAULT_LIMIT);
    options.context = input.context.unwrap_or(DEFAULT_CONTEXT);
    options.session = input.session;
    options.lsp_operation = input.lsp_operation;
    options.include_debug = view.raw;
    options.include_raw = view.raw;
    crate::lens::build_discovery_envelope(options)
        .map_err(|error| ErrorData::internal_error(error.to_string(), None))
}

fn status_envelope(
    input: HealthIn,
    view: McpView,
) -> Result<crate::lens::LensEnvelope<crate::lens::LensStatusData>, ErrorData> {
    let root = cwd(input.cwd)?;
    let guard_mode = parse_guard_mode(input.guard_mode.as_deref())?;
    crate::lens::build_status_envelope(
        &root,
        crate::lens::LensStatusOptions {
            include_disk: input.disk.unwrap_or(false),
            include_debug: view.raw,
            include_raw: view.raw,
            runtime_policy: crate::lens::RuntimePolicyOverrides {
                guard_mode,
                allow_overrides: None,
            },
            ..crate::lens::LensStatusOptions::default()
        },
    )
    .map_err(|error| ErrorData::internal_error(error.to_string(), None))
}

fn guard_check_envelope(input: &GuardIn) -> Result<crate::lens::LensEnvelope<Value>, ErrorData> {
    let root = cwd(input.cwd.clone())?;
    let policy = crate::lens::resolve_policy(&root).policy.guard;
    let mode = effective_guard_action(policy.mode, input.mode.as_deref(), policy.allow_overrides)?;
    let mut store = crate::lens::LensStore::open_for_project(&root)
        .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
    let decision = store
        .check_guard_with_overrides(
            input.session.as_deref(),
            std::path::Path::new(&input.path),
            required(input.start_line, "start_line")?,
            required(input.end_line, "end_line")?,
            mode,
            policy.allow_overrides,
        )
        .map_err(|error| ErrorData::invalid_params(error.to_string(), None))?;
    Ok(guard_envelope(
        store.project_id(),
        input.session.clone(),
        decision,
    ))
}

fn guard_record_read_envelope(
    input: &GuardIn,
) -> Result<crate::lens::LensEnvelope<Value>, ErrorData> {
    let root = cwd(input.cwd.clone())?;
    let mut store = crate::lens::LensStore::open_for_project(&root)
        .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
    let range = store
        .record_read(
            input.session.as_deref(),
            std::path::Path::new(&input.path),
            required(input.start_line, "start_line")?,
            required(input.end_line, "end_line")?,
        )
        .map_err(|error| ErrorData::invalid_params(error.to_string(), None))?;
    Ok(crate::lens::LensEnvelope::ok(json!({
        "project_id": store.project_id(),
        "session": input.session,
        "path": input.path,
        "range": range,
        "recorded": true
    })))
}

fn guard_allow_once_envelope(
    input: &GuardIn,
) -> Result<crate::lens::LensEnvelope<Value>, ErrorData> {
    let root = cwd(input.cwd.clone())?;
    let policy = crate::lens::resolve_policy(&root).policy.guard;
    if !policy.allow_overrides {
        return Ok(crate::lens::LensEnvelope::error(
            json!({
                "session": input.session,
                "path": input.path,
                "allowed_once": false,
                "reason": "overrides_disabled"
            }),
            vec![crate::lens::LensMessage::error(
                "guard_overrides_disabled",
                "guard overrides are disabled by policy",
            )],
        ));
    }
    let store = crate::lens::LensStore::open_for_project(&root)
        .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
    store
        .allow_once(input.session.as_deref(), std::path::Path::new(&input.path))
        .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
    Ok(crate::lens::LensEnvelope::ok(json!({
        "session": input.session,
        "path": input.path,
        "allowed_once": true
    })))
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

fn compact_discovery_item(item: &crate::lens::DiscoveryItem) -> Value {
    json!({
        "kind": item.kind,
        "path": item.path,
        "name": item.name,
        "symbol_kind": item.symbol_kind,
        "language": item.language,
        "start_line": item.start_line,
        "end_line": item.end_line,
        "summary": item.summary
    })
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
        "guard": file.guard.as_ref().map(|guard| json!({
            "decision": guard.decision,
            "reason": guard.reason,
            "message": guard.message
        })),
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

fn compact_guard_data(action: &str, data: &Value) -> Value {
    match action {
        "check" => json!({
            "project_id": data.get("project_id").cloned().unwrap_or(Value::Null),
            "session": data.get("session").cloned().unwrap_or(Value::Null),
            "guard": data.get("guard").map(compact_guard_decision).unwrap_or(Value::Null)
        }),
        _ => data.clone(),
    }
}

fn compact_guard_decision(guard: &Value) -> Value {
    json!({
        "decision": guard.get("decision").cloned().unwrap_or(Value::Null),
        "reason": guard.get("reason").cloned().unwrap_or(Value::Null),
        "message": guard.get("message").cloned().unwrap_or(Value::Null),
        "file": guard.get("file").cloned().unwrap_or(Value::Null),
        "classification": guard.get("classification").cloned().unwrap_or(Value::Null),
        "required_ranges": guard.get("required_ranges").cloned().unwrap_or_else(|| json!([])),
        "covered_ranges": guard.get("covered_ranges").cloned().unwrap_or_else(|| json!([]))
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

fn guard_summary(action: &str, data: &Value) -> String {
    match action {
        "check" => {
            let guard = &data["guard"];
            format!(
                "guard {}: {}",
                guard["decision"].as_str().unwrap_or("unknown"),
                guard["message"].as_str().unwrap_or("")
            )
        }
        "record_read" | "read" => format!(
            "recorded read for {}",
            data.get("path")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
        ),
        "allow_once" => {
            if data
                .get("allowed_once")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                "guard allow-once recorded".to_string()
            } else {
                "guard allow-once denied".to_string()
            }
        }
        _ => "guard".to_string(),
    }
}

fn guard_next_actions(
    data: &Value,
    warnings: &[crate::lens::LensMessage],
    errors: &[crate::lens::LensMessage],
) -> Vec<String> {
    let mut actions = hints(warnings);
    actions.extend(hints(errors));
    if data
        .pointer("/guard/decision")
        .and_then(Value::as_str)
        .is_some_and(|decision| decision != "allow")
    {
        actions.push("read the required ranges, then retry the edit".to_string());
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

fn parse_guard_mode(mode: Option<&str>) -> Result<Option<crate::lens::LensGuardMode>, ErrorData> {
    match mode {
        Some("off") | Some("allow") => Ok(Some(crate::lens::LensGuardMode::Off)),
        Some("warn") => Ok(Some(crate::lens::LensGuardMode::Warn)),
        Some("block") => Ok(Some(crate::lens::LensGuardMode::Block)),
        None => Ok(None),
        Some(other) => Err(ErrorData::invalid_params(
            format!("invalid guard mode: {other}"),
            None,
        )),
    }
}

fn effective_guard_action(
    policy_mode: crate::lens::LensGuardMode,
    requested: Option<&str>,
    allow_overrides: bool,
) -> Result<crate::lens::GuardAction, ErrorData> {
    let action = parse_guard_mode(requested)?.unwrap_or(policy_mode);
    if !allow_overrides && guard_mode_rank(action) < guard_mode_rank(policy_mode) {
        return Err(ErrorData::invalid_params(
            "guard mode override weakens policy but allow_overrides is false".to_string(),
            None,
        ));
    }
    Ok(match action {
        crate::lens::LensGuardMode::Off => crate::lens::GuardAction::Allow,
        crate::lens::LensGuardMode::Warn => crate::lens::GuardAction::Warn,
        crate::lens::LensGuardMode::Block => crate::lens::GuardAction::Block,
    })
}

fn guard_mode_rank(mode: crate::lens::LensGuardMode) -> u8 {
    match mode {
        crate::lens::LensGuardMode::Off => 0,
        crate::lens::LensGuardMode::Warn => 1,
        crate::lens::LensGuardMode::Block => 2,
    }
}

fn guard_envelope(
    project_id: i64,
    session: Option<String>,
    decision: crate::lens::GuardDecision,
) -> crate::lens::LensEnvelope<Value> {
    let action = decision.decision.clone();
    let code = serde_json::to_value(&decision.reason)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_else(|| "unknown".to_string());
    let message = crate::lens::LensMessage {
        code: format!("guard_{code}"),
        message: decision.message.clone(),
        hint: Some(
            "read the required range with the guard record_read action or Lens discovery before editing"
                .to_string(),
        ),
    };
    let data = json!({
        "project_id": project_id,
        "session": session,
        "guard": decision
    });
    match action {
        crate::lens::GuardAction::Block => crate::lens::LensEnvelope::error(data, vec![message]),
        crate::lens::GuardAction::Warn => crate::lens::LensEnvelope::warning(data, vec![message]),
        crate::lens::GuardAction::Allow => crate::lens::LensEnvelope::ok(data),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn discover_input(cwd: String) -> DiscoverIn {
        DiscoverIn {
            cwd: Some(cwd),
            intent: "symbol".to_string(),
            query: Some("target".to_string()),
            path: None,
            line: None,
            end_line: None,
            character: None,
            lang: None,
            limit: Some(10),
            context: Some(2),
            session: Some("mcp".to_string()),
            lsp_operation: None,
            detail: Some(false),
            raw: Some(false),
        }
    }

    #[test]
    fn mcp_tool_names_are_short_namespaced_surface_only() {
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
                "cleanup",
                "context",
                "diagnostics",
                "discover",
                "guard",
                "health",
                "report",
            ]
        );
        assert!(names.iter().all(|name| !name.starts_with("lens_")));
        assert!(names.iter().all(|name| !name.contains('_')));
    }

    #[test]
    fn mcp_compact_detail_and_raw_shapes_are_schema_versioned() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("main.rs"), "fn target() {}\n").unwrap();
        let cwd = temp.path().display().to_string();

        let compact = discover_mcp_response(discover_input(cwd.clone())).unwrap();
        let compact_value = serde_json::to_value(&compact).unwrap();
        assert_eq!(
            compact_value["schema_version"],
            LENS_MCP_RESPONSE_SCHEMA_VERSION
        );
        assert_eq!(compact_value["status"], "ok");
        assert!(
            compact_value["summary"]
                .as_str()
                .unwrap()
                .contains("discover")
        );
        assert!(compact_value["next_actions"].is_array());
        assert_eq!(compact_value["data"]["route"]["backend"], "sym");
        assert!(compact_value["data"].get("alternatives").is_none());
        assert!(compact_value.get("raw").is_none());

        let mut detail_input = discover_input(cwd.clone());
        detail_input.detail = Some(true);
        let detail = serde_json::to_value(discover_mcp_response(detail_input).unwrap()).unwrap();
        assert!(detail["data"].get("alternatives").is_some());
        assert!(detail.get("raw").is_none());

        let raw = serde_json::to_value(
            discover_mcp_response(DiscoverIn {
                intent: "source-context".to_string(),
                query: None,
                path: Some("main.rs".to_string()),
                line: Some(1),
                end_line: Some(1),
                raw: Some(true),
                ..discover_input(cwd)
            })
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            raw["raw"]["schema_version"],
            crate::lens::LENS_RESPONSE_SCHEMA_VERSION
        );
        assert!(raw["raw"].get("raw").is_some());
    }

    #[test]
    fn mcp_discover_detail_matches_shared_discovery_envelope() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("main.rs"), "fn target() {}\n").unwrap();
        let cwd = temp.path().display().to_string();
        let mut input = discover_input(cwd);
        input.detail = Some(true);
        let mcp = discover_mcp_response(input).unwrap();
        let mut options = crate::lens::DiscoveryOptions::new(
            temp.path().to_path_buf(),
            crate::lens::DiscoveryIntent::Symbol,
        );
        options.query = Some("target".to_string());
        options.session = Some("mcp".to_string());
        let direct = crate::lens::build_discovery_envelope(options).unwrap();

        assert_eq!(mcp.data, serde_json::to_value(direct.data).unwrap());
    }

    #[test]
    fn mcp_diagnostics_list_matches_store_and_compacts_records() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("main.rs"), "fn main() {}\n").unwrap();
        let cwd = temp.path().display().to_string();
        let mut store = crate::lens::LensStore::open_for_project(temp.path()).unwrap();
        store
            .record_diagnostics(&[crate::lens::Diagnostic {
                source: crate::lens::DiagnosticSource::Test,
                scope: crate::lens::DiagnosticScope::file("main.rs"),
                severity: crate::lens::DiagnosticSeverity::Warning,
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
            }])
            .unwrap();

        let compact = diagnostics_mcp_response(DiagnosticsIn {
            cwd: Some(cwd.clone()),
            action: Some("list".to_string()),
            path: None,
            all: Some(true),
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
            detail: Some(false),
            raw: Some(false),
        })
        .unwrap();
        assert_eq!(compact.data["diagnostic_count"], 1);
        assert_eq!(compact.data["diagnostics"][0]["message"], "warn");
        assert!(compact.data["diagnostics"][0].get("fingerprint").is_none());

        let detail = diagnostics_mcp_response(DiagnosticsIn {
            detail: Some(true),
            cwd: Some(cwd),
            action: Some("list".to_string()),
            path: None,
            all: Some(true),
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
            raw: Some(false),
        })
        .unwrap();
        let direct =
            serde_json::to_value(store.list_diagnostics_data(None, true).unwrap()).unwrap();
        assert_eq!(detail.data, direct);
    }

    #[test]
    fn mcp_guard_records_reads_and_matches_guard_contract() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("main.rs"), "fn main() {}\n").unwrap();
        let cwd = temp.path().display().to_string();

        let blocked = guard_mcp_response(GuardIn {
            cwd: Some(cwd.clone()),
            action: Some("check".to_string()),
            path: "main.rs".to_string(),
            start_line: Some(1),
            end_line: Some(1),
            session: Some("mcp-guard".to_string()),
            mode: None,
            detail: Some(true),
            raw: Some(false),
        })
        .unwrap();
        assert_eq!(blocked.status, crate::lens::LensResponseStatus::Error);
        assert_eq!(blocked.data["guard"]["reason"], "zero_read");

        let read = guard_mcp_response(GuardIn {
            action: Some("record_read".to_string()),
            detail: Some(true),
            cwd: Some(cwd.clone()),
            path: "main.rs".to_string(),
            start_line: Some(1),
            end_line: Some(1),
            session: Some("mcp-guard".to_string()),
            mode: None,
            raw: Some(false),
        })
        .unwrap();
        assert_eq!(read.data["recorded"], true);

        let allowed = guard_mcp_response(GuardIn {
            cwd: Some(cwd),
            action: Some("check".to_string()),
            path: "main.rs".to_string(),
            start_line: Some(1),
            end_line: Some(1),
            session: Some("mcp-guard".to_string()),
            mode: None,
            detail: Some(true),
            raw: Some(false),
        })
        .unwrap();
        assert_eq!(allowed.status, crate::lens::LensResponseStatus::Ok);
        assert_eq!(allowed.data["guard"]["reason"], "covered");
    }

    #[test]
    fn mcp_health_report_context_use_shared_envelopes() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("main.rs"), "fn main() {}\n").unwrap();
        let cwd = temp.path().display().to_string();
        let event = crate::lens::LensTurnEvent {
            schema_version: crate::lens::LENS_TURN_EVENT_SCHEMA_VERSION.to_string(),
            session: "mcp-health".to_string(),
            turn: "turn".to_string(),
            host: "mcp-test".to_string(),
            cwd: cwd.clone(),
            event: crate::lens::LensTurnEventKind::ToolEnd,
            tool: "edit".to_string(),
            phase: crate::lens::LensToolEventPhase::PostTool,
            status: Some("success".to_string()),
            files: vec![crate::lens::LensTouchedFileInput {
                path: "main.rs".to_string(),
                operation: "modify".to_string(),
                start_line: None,
                end_line: None,
                generated: false,
                include_ignored: false,
            }],
            policy: crate::lens::LensTurnEventPolicy {
                git_fallback: false,
                include_ignored: false,
            },
        };
        crate::lens::record_turn_event_envelope(temp.path(), event).unwrap();

        let health = health_mcp_response(HealthIn {
            cwd: Some(cwd.clone()),
            operation: Some("turn".to_string()),
            session: Some("mcp-health".to_string()),
            turn: Some("turn".to_string()),
            disk: None,
            guard_mode: None,
            detail: Some(true),
            raw: Some(false),
        })
        .unwrap();
        assert_eq!(health.data["status"], "blocked");
        assert!(health.summary.contains("blocked"));

        let context = context_mcp_response(ContextIn {
            cwd: Some(cwd.clone()),
            session: "mcp-health".to_string(),
            turn: "turn".to_string(),
            ack: Some(true),
            detail: Some(true),
            raw: Some(false),
        })
        .unwrap();
        assert_eq!(context.data["state"], "acknowledged");

        let report = report_mcp_response(ReportIn {
            cwd: Some(cwd),
            session: "mcp-health".to_string(),
            turn: "turn".to_string(),
            path: Some("main.rs".to_string()),
            detail: Some(true),
            raw: Some(false),
        })
        .unwrap();
        assert_eq!(report.data["file_count"], 1);
        assert!(report.data["files"][0].get("symbol_context").is_some());
    }

    #[test]
    fn mcp_missing_discovery_backend_is_structured_warning_not_error() {
        let temp = tempfile::tempdir().unwrap();
        let response = discover_mcp_response(DiscoverIn {
            cwd: Some(temp.path().display().to_string()),
            intent: "ast".to_string(),
            query: Some("fn $A()".to_string()),
            path: None,
            line: None,
            end_line: None,
            character: None,
            lang: None,
            limit: Some(10),
            context: Some(2),
            session: None,
            lsp_operation: None,
            detail: Some(false),
            raw: Some(false),
        })
        .unwrap();
        assert_eq!(response.status, crate::lens::LensResponseStatus::Warning);
        assert_eq!(response.warnings[0].code, "ast_lang_required");
        assert!(response.errors.is_empty());
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
