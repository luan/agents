use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::checks::LensChecksData;
use super::contract::{LensMessage, LensResponseStatus};
use super::health::{TurnHealthData, TurnHealthOptions, TurnHealthStatus};
use super::policy::LensGuardMode;
use super::retention;
use super::status::{build_status_envelope, DiagnosticHealth, LensStatusOptions};
use super::store::LensStore;
use super::types::{
    DiagnosticScope, DiagnosticSnapshotInput, DiagnosticSnapshotMetadata, DiagnosticSource,
    GuardAction, GuardDecision, LensToolEventPhase, LensTouchedFile, LensTouchedFileInput,
    LensTurnEvent, LensTurnEventKind, LensTurnEventPolicy, RawOutputRef,
};

pub const LENS_HOOK_EVENT_SCHEMA_VERSION: &str = "lens.hook_event.v1";
pub const LENS_HOOK_RESPONSE_SCHEMA_VERSION: &str = "lens.hook_response.v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LensLifecycleHook {
    SessionStart,
    ContextInjection,
    PreTool,
    PostTool,
    TurnStart,
    TurnEnd,
    AgentEnd,
    SessionShutdown,
}

impl LensLifecycleHook {
    pub fn from_command(name: &str) -> Option<Self> {
        match name {
            "lens-session-start" => Some(Self::SessionStart),
            "lens-context" | "lens-context-injection" => Some(Self::ContextInjection),
            "lens-pre-tool" => Some(Self::PreTool),
            "lens-post-tool" => Some(Self::PostTool),
            "lens-turn-start" => Some(Self::TurnStart),
            "lens-turn-end" => Some(Self::TurnEnd),
            "lens-agent-end" => Some(Self::AgentEnd),
            "lens-session-shutdown" => Some(Self::SessionShutdown),
            _ => None,
        }
    }

    fn event(self) -> LensHookEventKind {
        match self {
            Self::SessionStart => LensHookEventKind::SessionStart,
            Self::ContextInjection => LensHookEventKind::ContextInjection,
            Self::PreTool => LensHookEventKind::PreTool,
            Self::PostTool => LensHookEventKind::PostTool,
            Self::TurnStart => LensHookEventKind::TurnStart,
            Self::TurnEnd => LensHookEventKind::TurnEnd,
            Self::AgentEnd => LensHookEventKind::AgentEnd,
            Self::SessionShutdown => LensHookEventKind::SessionShutdown,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LensHookEventKind {
    SessionStart,
    ContextInjection,
    PreTool,
    PostTool,
    TurnStart,
    TurnEnd,
    AgentEnd,
    SessionShutdown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LensHookHost {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LensHookSession {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LensHookTurn {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub index: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LensHookTool {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_output: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_output_max_bytes: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LensHookPolicy {
    #[serde(default = "default_true")]
    pub git_fallback: bool,
    #[serde(default)]
    pub include_ignored: bool,
    #[serde(default)]
    pub guard_mode: Option<LensGuardMode>,
    #[serde(default)]
    pub allow_overrides: Option<bool>,
    #[serde(default = "default_true")]
    pub run_cleanup: bool,
    #[serde(default = "default_true")]
    pub run_checks: bool,
    #[serde(default = "default_true")]
    pub record_raw_output: bool,
}

impl Default for LensHookPolicy {
    fn default() -> Self {
        Self {
            git_fallback: true,
            include_ignored: false,
            guard_mode: None,
            allow_overrides: None,
            run_cleanup: true,
            run_checks: true,
            record_raw_output: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LensHookEvent {
    pub schema_version: String,
    pub host: LensHookHost,
    pub session: LensHookSession,
    pub cwd: String,
    pub turn: LensHookTurn,
    pub event: LensHookEventKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<LensHookTool>,
    #[serde(default)]
    pub known_files: Vec<LensTouchedFileInput>,
    #[serde(default)]
    pub policy: LensHookPolicy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LensHookDecisionOutcome {
    Allow,
    Block,
    Warn,
    Noop,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LensHookDecision {
    pub outcome: LensHookDecisionOutcome,
    pub reason: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub guard: Vec<GuardDecision>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LensHookAction {
    pub kind: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LensHookContextInjection {
    pub inject: bool,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LensHookDiagnosticsSummary {
    pub active: usize,
    pub errors: usize,
    pub warnings: usize,
    pub info: usize,
    pub hints: usize,
}

impl Default for LensHookDiagnosticsSummary {
    fn default() -> Self {
        Self::from_health(&DiagnosticHealth {
            total: 0,
            errors: 0,
            warnings: 0,
            info: 0,
            hints: 0,
        })
    }
}

impl LensHookDiagnosticsSummary {
    fn from_health(health: &DiagnosticHealth) -> Self {
        Self {
            active: health.total,
            errors: health.errors,
            warnings: health.warnings,
            info: health.info,
            hints: health.hints,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LensHookHealthStatus {
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compact: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

impl Default for LensHookHealthStatus {
    fn default() -> Self {
        Self {
            status: "unknown".to_string(),
            compact: None,
            details: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LensHookResponse {
    pub schema_version: String,
    pub status: LensResponseStatus,
    pub host: LensHookHost,
    pub session: LensHookSession,
    pub cwd: String,
    pub turn: LensHookTurn,
    pub event: LensHookEventKind,
    pub decision: LensHookDecision,
    pub actions: Vec<LensHookAction>,
    pub context: LensHookContextInjection,
    pub diagnostics: LensHookDiagnosticsSummary,
    pub health: LensHookHealthStatus,
    pub warnings: Vec<LensMessage>,
    pub errors: Vec<LensMessage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl LensHookResponse {
    pub fn should_exit_nonzero(&self) -> bool {
        matches!(self.status, LensResponseStatus::Error)
            && (matches!(self.decision.outcome, LensHookDecisionOutcome::Block)
                || !self.errors.is_empty())
    }
}

pub fn run_lifecycle_hook(name: &str) -> Result<i32, Box<dyn std::error::Error>> {
    let Some(hook) = LensLifecycleHook::from_command(name) else {
        return Err(format!("unknown Lens lifecycle hook: {name}").into());
    };
    let mut input = String::new();
    let mut stdin = std::io::stdin();
    stdin.read_to_string(&mut input)?;
    let cwd = std::env::current_dir()?;
    let response = handle_lifecycle_hook(hook, &input, &cwd);
    println!("{}", serde_json::to_string_pretty(&response)?);
    Ok(if response.should_exit_nonzero() { 2 } else { 0 })
}

pub fn handle_lifecycle_hook(
    hook: LensLifecycleHook,
    input: &str,
    fallback_cwd: &Path,
) -> LensHookResponse {
    let parsed = parse_event(hook, input, fallback_cwd);
    let mut event = match parsed {
        Ok(event) => event,
        Err(response) => return response,
    };
    if event.event != hook.event() {
        event.event = hook.event();
    }

    match hook {
        LensLifecycleHook::SessionStart => session_start(event),
        LensLifecycleHook::ContextInjection => context_injection(event),
        LensLifecycleHook::PreTool => pre_tool(event),
        LensLifecycleHook::PostTool => post_tool(event),
        LensLifecycleHook::TurnStart => turn_start(event),
        LensLifecycleHook::TurnEnd => turn_end(event),
        LensLifecycleHook::AgentEnd => agent_end(event),
        LensLifecycleHook::SessionShutdown => session_shutdown(event),
    }
}

fn parse_event(
    hook: LensLifecycleHook,
    input: &str,
    fallback_cwd: &Path,
) -> Result<LensHookEvent, LensHookResponse> {
    if input.trim().is_empty() {
        return Err(error_response(
            hook,
            fallback_cwd,
            "malformed_json",
            "hook input must be JSON",
        ));
    }
    let value: Value = match serde_json::from_str(input) {
        Ok(value) => value,
        Err(error) => {
            return Err(error_response(
                hook,
                fallback_cwd,
                "malformed_json",
                format!("hook input must be JSON: {error}"),
            ));
        }
    };
    let schema = value
        .get("schema_version")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if schema != LENS_HOOK_EVENT_SCHEMA_VERSION {
        return Err(error_response(
            hook,
            fallback_cwd,
            "unknown_schema",
            format!(
                "unsupported Lens hook event schema {schema:?}; expected {LENS_HOOK_EVENT_SCHEMA_VERSION}"
            ),
        ));
    }
    serde_json::from_value(value).map_err(|error| {
        error_response(
            hook,
            fallback_cwd,
            "invalid_event",
            format!("invalid Lens hook event: {error}"),
        )
    })
}

fn session_start(event: LensHookEvent) -> LensHookResponse {
    let mut response = base_response(
        &event,
        LensHookDecisionOutcome::Allow,
        "session_initialized",
    );
    match root_for_event(&event).and_then(|root| status_payload(&root)) {
        Ok((health, diagnostics, data)) => {
            response
                .actions
                .push(action("initialize_state", "ok", None));
            response.health = health;
            response.diagnostics = diagnostics;
            response.data = Some(json!({ "status": data }));
        }
        Err(error) => push_error(&mut response, "session_start_failed", error),
    }
    response
}

fn context_injection(event: LensHookEvent) -> LensHookResponse {
    let mut response = base_response(&event, LensHookDecisionOutcome::Noop, "context_checked");
    match root_for_event(&event).and_then(|root| turn_health(&root, &event)) {
        Ok(health) => {
            response.health = health_status_from_turn(&health);
            response.diagnostics = diagnostics_from_turn(&health);
            response.context = context_from_turn(&health);
            response.data = Some(json!({ "action_context": health.action_context }));
        }
        Err(error) => push_error(&mut response, "context_failed", error),
    }
    response
}

fn pre_tool(event: LensHookEvent) -> LensHookResponse {
    let mut response = base_response(&event, LensHookDecisionOutcome::Allow, "guard_clean");
    match root_for_event(&event).and_then(|root| advisory_guard(&root, &event)) {
        Ok((decisions, files)) => {
            let warned = decisions
                .iter()
                .any(|decision| !matches!(decision.decision, GuardAction::Allow));
            response.decision.guard = decisions;
            response.data = Some(json!({ "files": files }));
            if warned {
                response.status = LensResponseStatus::Warning;
                response.decision.outcome = LensHookDecisionOutcome::Warn;
                response.decision.reason = "guard_advisory".to_string();
                response.warnings.push(LensMessage::warning_with_hint(
                    "guard_advisory",
                    "Lens guard found write targets without current read coverage",
                    "review the advisory and read affected ranges when useful; the tool call was not blocked",
                ));
            } else {
                response.actions.push(action("guard_advisory", "ok", None));
            }
            if let Err(error) = record_tool_turn_event(
                &event,
                LensTurnEventKind::ToolStart,
                LensToolEventPhase::PreTool,
            ) {
                push_error(&mut response, "pre_tool_record_failed", error);
            } else {
                response
                    .actions
                    .push(action("record_turn_event", "ok", None));
            }
        }
        Err(error) => push_error(&mut response, "pre_tool_failed", error),
    }
    response
}

fn post_tool(event: LensHookEvent) -> LensHookResponse {
    let mut response = base_response(&event, LensHookDecisionOutcome::Allow, "tool_recorded");
    match record_tool_turn_event(
        &event,
        LensTurnEventKind::ToolEnd,
        LensToolEventPhase::PostTool,
    ) {
        Ok(envelope) => {
            response
                .actions
                .push(action("record_turn_event", "ok", None));
            response.warnings.extend(envelope.warnings.clone());
            response.errors.extend(envelope.errors.clone());
            response.data = Some(json!({ "turn": envelope.data }));
            if matches!(envelope.status, LensResponseStatus::Error) {
                response.status = LensResponseStatus::Error;
                response.decision.outcome = LensHookDecisionOutcome::Warn;
                response.decision.reason = "recorded_with_errors".to_string();
            } else if matches!(envelope.status, LensResponseStatus::Warning) {
                response.status = LensResponseStatus::Warning;
                response.decision.outcome = LensHookDecisionOutcome::Warn;
                response.decision.reason = "recorded_with_warnings".to_string();
            }
            match record_raw_output(&event) {
                Ok(Some(raw)) => {
                    response
                        .actions
                        .push(action("record_raw_output", "ok", None));
                    merge_data(&mut response, "raw_output", json!(raw));
                }
                Ok(None) => {}
                Err(error) => push_error(&mut response, "raw_output_record_failed", error),
            }
        }
        Err(error) => push_error(&mut response, "post_tool_failed", error),
    }
    response
}

fn turn_start(event: LensHookEvent) -> LensHookResponse {
    let mut response = base_response(&event, LensHookDecisionOutcome::Allow, "turn_started");
    match record_tool_turn_event(
        &event,
        LensTurnEventKind::TurnStart,
        LensToolEventPhase::PreTool,
    ) {
        Ok(envelope) => {
            response
                .actions
                .push(action("record_turn_event", "ok", None));
            response.data = Some(json!({ "turn": envelope.data }));
        }
        Err(error) => push_error(&mut response, "turn_start_failed", error),
    }
    response
}

fn turn_end(event: LensHookEvent) -> LensHookResponse {
    let mut response = base_response(&event, LensHookDecisionOutcome::Allow, "turn_closed");
    match record_tool_turn_event(
        &event,
        LensTurnEventKind::TurnEnd,
        LensToolEventPhase::PostTool,
    ) {
        Ok(envelope) => {
            response
                .actions
                .push(action("record_turn_event", "ok", None));
            if envelope.data.cleanup.is_some() {
                response.actions.push(action("cleanup", "ok", None));
            }
            if checks_ran(envelope.data.checks.as_ref()) {
                response.actions.push(action("checks", "ok", None));
            }
            response.warnings.extend(envelope.warnings.clone());
            response.errors.extend(envelope.errors.clone());
            response.data = Some(json!({ "turn": envelope.data }));
            if matches!(envelope.status, LensResponseStatus::Warning) {
                response.status = LensResponseStatus::Warning;
            }
        }
        Err(error) => push_error(&mut response, "turn_end_record_failed", error),
    }
    match root_for_event(&event).and_then(|root| turn_health(&root, &event)) {
        Ok(health) => {
            response.health = health_status_from_turn(&health);
            response.diagnostics = diagnostics_from_turn(&health);
            merge_data(&mut response, "health", json!(health));
        }
        Err(error) => push_error(&mut response, "turn_end_health_failed", error),
    }
    response
}

fn agent_end(event: LensHookEvent) -> LensHookResponse {
    let mut response = base_response(
        &event,
        LensHookDecisionOutcome::Noop,
        "agent_health_checked",
    );
    match root_for_event(&event).and_then(|root| turn_health(&root, &event)) {
        Ok(health) => {
            response.health = health_status_from_turn(&health);
            response.diagnostics = diagnostics_from_turn(&health);
            response.context = context_from_turn(&health);
            if health.status.is_warning_or_worse() {
                response.status = LensResponseStatus::Warning;
            }
            response.actions.push(action("health", "ok", None));
            response.data = Some(json!({ "health": health }));
        }
        Err(error) => push_error(&mut response, "agent_end_failed", error),
    }
    response
}

fn session_shutdown(event: LensHookEvent) -> LensHookResponse {
    let mut response = base_response(&event, LensHookDecisionOutcome::Allow, "session_flushed");
    match root_for_event(&event) {
        Ok(root) => match LensStore::open_for_project(&root).and_then(|store| {
            retention::prune(
                &store,
                &super::policy::resolve_policy(&root).policy.retention,
                false,
            )
        }) {
            Ok(report) => {
                response.actions.push(action("flush_state", "ok", None));
                response.actions.push(action("prune_retention", "ok", None));
                response.data = Some(json!({ "retention": report }));
            }
            Err(error) => push_error(&mut response, "session_shutdown_failed", error),
        },
        Err(error) => push_error(&mut response, "session_shutdown_failed", error),
    }
    response
}

fn record_tool_turn_event(
    event: &LensHookEvent,
    kind: LensTurnEventKind,
    phase: LensToolEventPhase,
) -> Result<
    super::contract::LensEnvelope<super::types::LensTurnRecordData>,
    Box<dyn std::error::Error>,
> {
    let cwd = PathBuf::from(&event.cwd);
    let turn_event = turn_event(event, kind, phase);
    super::turn::record_turn_event_envelope(&cwd, turn_event)
}

fn advisory_guard(
    root: &Path,
    event: &LensHookEvent,
) -> Result<(Vec<GuardDecision>, Vec<LensTouchedFile>), Box<dyn std::error::Error>> {
    let cwd = canonical_or_self(&PathBuf::from(&event.cwd));
    let turn_event = turn_event(
        event,
        LensTurnEventKind::ToolStart,
        LensToolEventPhase::PreTool,
    );
    let (files, _) = super::turn::touched_files_from_event(root, &cwd, &turn_event)?;
    let mut store = LensStore::open_for_project(root)?;
    let mut decisions = Vec::new();
    for file in files
        .iter()
        .filter(|file| is_write_operation(&file.operation))
    {
        let (start, end) = guard_range(root, file);
        decisions.push(store.check_guard_with_overrides(
            Some(&event.session.id),
            Path::new(&file.path),
            start,
            end,
            GuardAction::Warn,
            false,
        )?);
    }
    Ok((decisions, files))
}

fn record_raw_output(
    event: &LensHookEvent,
) -> Result<Option<RawOutputRef>, Box<dyn std::error::Error>> {
    if !event.policy.record_raw_output {
        return Ok(None);
    }
    let Some(tool) = &event.tool else {
        return Ok(None);
    };
    let Some(raw) = tool.raw_output.as_deref() else {
        return Ok(None);
    };
    if raw.is_empty() {
        return Ok(None);
    }
    let root = root_for_event(event)?;
    let mut store = LensStore::open_for_project(&root)?;
    let result = store.record_diagnostic_snapshot(DiagnosticSnapshotInput {
        source: DiagnosticSource::Other("hook_raw".to_string()),
        scope: DiagnosticScope::command(format!(
            "{}:{}:{}",
            event.session.id, event.turn.id, tool.name
        )),
        diagnostics: Vec::new(),
        raw_output: Some(raw.to_string()),
        raw_output_max_bytes: tool.raw_output_max_bytes,
        metadata: DiagnosticSnapshotMetadata {
            command: Some(tool.name.clone()),
            exit_code: None,
            duration_ms: None,
        },
    })?;
    Ok(result.raw_output)
}

fn turn_event(
    event: &LensHookEvent,
    kind: LensTurnEventKind,
    phase: LensToolEventPhase,
) -> LensTurnEvent {
    let tool_name = event
        .tool
        .as_ref()
        .map(|tool| tool.name.clone())
        .unwrap_or_else(|| "agent".to_string());
    LensTurnEvent {
        schema_version: super::types::LENS_TURN_EVENT_SCHEMA_VERSION.to_string(),
        session: event.session.id.clone(),
        turn: event.turn.id.clone(),
        host: event.host.name.clone(),
        cwd: event.cwd.clone(),
        event: kind,
        tool: tool_name,
        phase,
        status: event.tool.as_ref().and_then(|tool| tool.status.clone()),
        files: event.known_files.clone(),
        policy: LensTurnEventPolicy {
            git_fallback: event.policy.git_fallback,
            include_ignored: event.policy.include_ignored,
        },
    }
}

fn turn_health(
    root: &Path,
    event: &LensHookEvent,
) -> Result<TurnHealthData, Box<dyn std::error::Error>> {
    Ok(super::health::build_turn_health_envelope(
        root,
        TurnHealthOptions {
            session: event.session.id.clone(),
            turn: event.turn.id.clone(),
            acknowledge: false,
        },
    )?
    .data)
}

fn status_payload(
    root: &Path,
) -> Result<(LensHookHealthStatus, LensHookDiagnosticsSummary, Value), Box<dyn std::error::Error>> {
    let envelope = build_status_envelope(root, LensStatusOptions::default())?;
    let health = LensHookHealthStatus {
        status: format!("{:?}", envelope.data.health.status).to_ascii_lowercase(),
        compact: None,
        details: Some(json!(envelope.data.health)),
    };
    let diagnostics = LensHookDiagnosticsSummary::from_health(&envelope.data.health.diagnostics);
    Ok((health, diagnostics, json!(envelope.data)))
}

fn health_status_from_turn(health: &TurnHealthData) -> LensHookHealthStatus {
    LensHookHealthStatus {
        status: turn_health_status_str(&health.status).to_string(),
        compact: Some(health.compact.clone()),
        details: Some(json!(health.summary)),
    }
}

fn diagnostics_from_turn(health: &TurnHealthData) -> LensHookDiagnosticsSummary {
    LensHookDiagnosticsSummary {
        active: health.summary.diagnostics.active,
        errors: health.summary.diagnostics.errors,
        warnings: health.summary.diagnostics.warnings,
        info: health.summary.diagnostics.info,
        hints: health.summary.diagnostics.hints,
    }
}

fn context_from_turn(health: &TurnHealthData) -> LensHookContextInjection {
    let action = &health.action_context;
    if !action.required {
        return LensHookContextInjection {
            inject: false,
            content: String::new(),
            state: Some(action.state.clone()),
        };
    }
    let mut lines = vec![
        "## Lens Action Required".to_string(),
        action.instructions.clone(),
        format!("Reason: {}", action.reason),
    ];
    for remediation in &action.remediation {
        lines.push(format!("- {remediation}"));
    }
    if let Some(command) = &action.ack_command {
        lines.push(format!("Acknowledge when handled: `{command}`"));
    }
    LensHookContextInjection {
        inject: true,
        content: lines.join("\n"),
        state: Some(action.state.clone()),
    }
}

fn root_for_event(event: &LensHookEvent) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let cwd = PathBuf::from(&event.cwd);
    Ok(project_root(&cwd).unwrap_or_else(|| canonical_or_self(&cwd)))
}

fn project_root(cwd: &Path) -> Option<PathBuf> {
    let output = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!text.is_empty()).then(|| PathBuf::from(text))
}

fn canonical_or_self(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn guard_range(root: &Path, file: &LensTouchedFile) -> (i64, i64) {
    if let (Some(start), Some(end)) = (file.start_line, file.end_line) {
        return (start, end);
    }
    let line_count = std::fs::read_to_string(root.join(&file.path))
        .map(|content| content.lines().count().max(1) as i64)
        .unwrap_or(1);
    (
        file.start_line.unwrap_or(1),
        file.end_line.unwrap_or(line_count),
    )
}

fn is_write_operation(operation: &str) -> bool {
    matches!(
        operation,
        "add" | "create" | "delete" | "edit" | "modify" | "move" | "rename" | "write"
    )
}

fn base_response(
    event: &LensHookEvent,
    outcome: LensHookDecisionOutcome,
    reason: &str,
) -> LensHookResponse {
    LensHookResponse {
        schema_version: LENS_HOOK_RESPONSE_SCHEMA_VERSION.to_string(),
        status: LensResponseStatus::Ok,
        host: event.host.clone(),
        session: event.session.clone(),
        cwd: event.cwd.clone(),
        turn: event.turn.clone(),
        event: event.event.clone(),
        decision: LensHookDecision {
            outcome,
            reason: reason.to_string(),
            guard: Vec::new(),
        },
        actions: Vec::new(),
        context: LensHookContextInjection {
            inject: false,
            content: String::new(),
            state: None,
        },
        diagnostics: LensHookDiagnosticsSummary::default(),
        health: LensHookHealthStatus::default(),
        warnings: Vec::new(),
        errors: Vec::new(),
        data: None,
    }
}

fn error_response(
    hook: LensLifecycleHook,
    fallback_cwd: &Path,
    code: &str,
    message: impl Into<String>,
) -> LensHookResponse {
    let event = LensHookEvent {
        schema_version: LENS_HOOK_EVENT_SCHEMA_VERSION.to_string(),
        host: LensHookHost {
            name: "unknown".to_string(),
            version: None,
            kind: None,
        },
        session: LensHookSession {
            id: "unknown".to_string(),
            seq: None,
        },
        cwd: fallback_cwd.display().to_string(),
        turn: LensHookTurn {
            id: "unknown".to_string(),
            index: None,
        },
        event: hook.event(),
        tool: None,
        known_files: Vec::new(),
        policy: LensHookPolicy::default(),
    };
    let mut response = base_response(&event, LensHookDecisionOutcome::Block, code);
    response.status = LensResponseStatus::Error;
    response.errors.push(LensMessage::error(code, message));
    response
}

fn push_error(response: &mut LensHookResponse, code: &str, error: impl std::fmt::Display) {
    response.status = LensResponseStatus::Error;
    response.decision.outcome = LensHookDecisionOutcome::Block;
    response.decision.reason = code.to_string();
    response
        .errors
        .push(LensMessage::error(code, error.to_string()));
}

fn action(kind: &str, status: &str, detail: Option<String>) -> LensHookAction {
    LensHookAction {
        kind: kind.to_string(),
        status: status.to_string(),
        detail,
    }
}

fn merge_data(response: &mut LensHookResponse, key: &str, value: Value) {
    match response.data.take() {
        Some(Value::Object(mut object)) => {
            object.insert(key.to_string(), value);
            response.data = Some(Value::Object(object));
        }
        Some(other) => {
            response.data = Some(json!({ "previous": other, key: value }));
        }
        None => {
            response.data = Some(json!({ key: value }));
        }
    }
}

fn checks_ran(checks: Option<&LensChecksData>) -> bool {
    checks.is_some_and(|checks| !checks.runs.is_empty())
}

fn turn_health_status_str(status: &TurnHealthStatus) -> &'static str {
    match status {
        TurnHealthStatus::Clean => "clean",
        TurnHealthStatus::Warning => "warning",
        TurnHealthStatus::Error => "error",
    }
}

fn default_true() -> bool {
    true
}
