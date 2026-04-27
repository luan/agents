use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::checks::LensChecksData;
use super::contract::{LensMessage, LensResponseStatus};
use super::health::{TurnHealthData, TurnHealthOptions, TurnHealthStatus};
use super::retention;
use super::status::{DiagnosticHealth, LensStatusOptions, build_status_envelope};
use super::store::LensStore;
use super::types::{
    DiagnosticScope, DiagnosticSnapshotInput, DiagnosticSnapshotMetadata, DiagnosticSource,
    LensToolEventPhase, LensTouchedFileInput, LensTurnEvent, LensTurnEventKind,
    LensTurnEventPolicy, RawOutputRef,
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
    let emit_native_response = should_emit_native_hook_response(&input);
    let response = handle_lifecycle_hook(hook, &input, &cwd);
    if emit_native_response {
        println!(
            "{}",
            serde_json::to_string_pretty(&native_hook_response(hook, &response))?
        );
    } else {
        println!("{}", serde_json::to_string_pretty(&response)?);
    }
    Ok(if response.should_exit_nonzero() { 2 } else { 0 })
}

fn should_emit_native_hook_response(input: &str) -> bool {
    match std::env::var("CT_LENS_OUTPUT") {
        Ok(value) if value == "lens" => return false,
        Ok(value) if value == "native" => return true,
        _ => {}
    }

    if let Ok(value) = serde_json::from_str::<Value>(input) {
        return value.get("schema_version").is_none();
    }

    matches!(
        std::env::var("CT_LENS_HOST").as_deref(),
        Ok("claude-code") | Ok("codex") | Ok("opencode")
    )
}

fn native_hook_response(hook: LensLifecycleHook, response: &LensHookResponse) -> Value {
    let mut payload = serde_json::Map::new();
    let blocked = matches!(response.decision.outcome, LensHookDecisionOutcome::Block);

    payload.insert("continue".to_string(), Value::Bool(!blocked));
    if response.host.name == "claude-code" {
        payload.insert("suppressOutput".to_string(), Value::Bool(true));
    }

    if blocked {
        payload.insert("decision".to_string(), Value::String("block".to_string()));
        payload.insert(
            "reason".to_string(),
            Value::String(response.decision.reason.clone()),
        );
    }

    if let Some(message) = native_system_message(response) {
        payload.insert("systemMessage".to_string(), Value::String(message));
    }

    match hook {
        LensLifecycleHook::PreTool => {
            if response.host.name != "codex" || blocked {
                payload.insert(
                    "hookSpecificOutput".to_string(),
                    json!({
                        "hookEventName": "PreToolUse",
                        "permissionDecision": if blocked { "deny" } else { "allow" },
                        "permissionDecisionReason": response.decision.reason,
                    }),
                );
            }
        }
        LensLifecycleHook::PostTool => {
            if let Some(context) = native_additional_context(response) {
                payload.insert(
                    "hookSpecificOutput".to_string(),
                    json!({
                        "hookEventName": "PostToolUse",
                        "additionalContext": context,
                    }),
                );
            }
        }
        LensLifecycleHook::ContextInjection => {
            payload.insert(
                "hookSpecificOutput".to_string(),
                json!({
                    "hookEventName": "UserPromptSubmit",
                    "additionalContext": native_additional_context(response).unwrap_or_default(),
                }),
            );
        }
        LensLifecycleHook::SessionStart => {
            if let Some(context) = native_additional_context(response) {
                payload.insert(
                    "hookSpecificOutput".to_string(),
                    json!({
                        "hookEventName": "SessionStart",
                        "additionalContext": context,
                    }),
                );
            }
        }
        LensLifecycleHook::TurnStart
        | LensLifecycleHook::TurnEnd
        | LensLifecycleHook::AgentEnd
        | LensLifecycleHook::SessionShutdown => {}
    }

    Value::Object(payload)
}

fn native_additional_context(response: &LensHookResponse) -> Option<String> {
    if response.context.inject && !response.context.content.trim().is_empty() {
        return Some(response.context.content.clone());
    }
    None
}

fn native_system_message(response: &LensHookResponse) -> Option<String> {
    if !matches!(response.status, LensResponseStatus::Error) || response.errors.is_empty() {
        return None;
    }
    Some(
        response
            .errors
            .iter()
            .take(3)
            .map(|error| format!("{}: {}", error.code, error.message))
            .collect::<Vec<_>>()
            .join("\n"),
    )
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
    if schema.is_empty() {
        return native_hook_event(hook, value, fallback_cwd);
    }
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

fn native_hook_event(
    hook: LensLifecycleHook,
    value: Value,
    fallback_cwd: &Path,
) -> Result<LensHookEvent, LensHookResponse> {
    let session_id = string_field(&value, &["session_id", "sessionId", "session"])
        .unwrap_or_else(|| "ephemeral".to_string());
    let cwd = string_field(&value, &["cwd", "workspace", "workspace_root"])
        .unwrap_or_else(|| fallback_cwd.display().to_string());
    let turn_id = string_field(
        &value,
        &[
            "turn_id",
            "turnId",
            "request_id",
            "requestId",
            "message_id",
            "messageId",
            "conversation_id",
            "conversationId",
        ],
    )
    .unwrap_or_else(|| session_id.clone());
    let tool_name = string_field(&value, &["tool_name", "toolName", "tool"]);
    let tool_input = value
        .get("tool_input")
        .or_else(|| value.get("toolInput"))
        .cloned();
    let tool_output = value
        .get("tool_response")
        .or_else(|| value.get("toolResponse"))
        .or_else(|| value.get("result"))
        .cloned();
    let status = native_tool_status(hook, tool_output.as_ref());
    let raw_output = tool_output
        .as_ref()
        .and_then(|output| serde_json::to_string(output).ok());
    let known_files = tool_name
        .as_deref()
        .zip(tool_input.as_ref())
        .map(|(tool, input)| native_known_files(tool, input))
        .unwrap_or_default();

    Ok(LensHookEvent {
        schema_version: LENS_HOOK_EVENT_SCHEMA_VERSION.to_string(),
        host: LensHookHost {
            name: std::env::var("CT_LENS_HOST").unwrap_or_else(|_| native_host_name(&value)),
            version: string_field(&value, &["version", "agent_version"]),
            kind: Some("native-hook".to_string()),
        },
        session: LensHookSession {
            id: session_id,
            seq: i64_field(&value, &["session_seq", "sessionSeq"]),
        },
        cwd,
        turn: LensHookTurn {
            id: turn_id,
            index: i64_field(&value, &["turn_index", "turnIndex"]),
        },
        event: hook.event(),
        tool: tool_name.map(|name| LensHookTool {
            name,
            id: string_field(&value, &["tool_call_id", "toolCallId", "tool_id", "toolId"]),
            status,
            input: tool_input,
            output: tool_output,
            raw_output,
            raw_output_max_bytes: Some(256 * 1024),
        }),
        known_files,
        policy: LensHookPolicy::default(),
    })
}

fn native_host_name(value: &Value) -> String {
    string_field(value, &["agent", "host", "client"])
        .or_else(|| {
            std::env::var("USER")
                .ok()
                .map(|user| format!("native-{user}"))
        })
        .unwrap_or_else(|| "native-agent".to_string())
}

fn native_tool_status(hook: LensLifecycleHook, output: Option<&Value>) -> Option<String> {
    match hook {
        LensLifecycleHook::PreTool => Some("started".to_string()),
        LensLifecycleHook::PostTool => {
            let is_error = output.is_some_and(|value| {
                bool_field(value, &["is_error", "isError", "error"])
                    || string_field(value, &["status"]).is_some_and(|status| {
                        matches!(status.as_str(), "error" | "failed" | "failure")
                    })
            });
            Some(if is_error { "error" } else { "success" }.to_string())
        }
        _ => None,
    }
}

fn native_known_files(tool_name: &str, input: &Value) -> Vec<LensTouchedFileInput> {
    let operation = native_file_operation(tool_name);
    let start_line = i64_field(input, &["start_line", "startLine", "line", "offset"]);
    let end_line = i64_field(input, &["end_line", "endLine"]).or_else(|| {
        let start = start_line?;
        let limit = i64_field(input, &["limit"])?;
        Some(start + limit.saturating_sub(1))
    });
    let mut files = Vec::new();
    for field in [
        "file_path",
        "filePath",
        "path",
        "notebook_path",
        "notebookPath",
    ] {
        if let Some(path) = string_field(input, &[field]) {
            files.push(touched_input(path, operation, start_line, end_line));
        }
    }
    for field in ["paths", "files"] {
        if let Some(items) = input.get(field).and_then(Value::as_array) {
            for item in items {
                if let Some(path) = item.as_str() {
                    files.push(touched_input(path.to_string(), operation, None, None));
                }
            }
        }
    }
    files
}

fn native_file_operation(tool_name: &str) -> &'static str {
    let lower = tool_name.to_ascii_lowercase();
    if lower.contains("read") || lower.contains("grep") || lower.contains("glob") || lower == "ls" {
        "read"
    } else if lower.contains("write") {
        "write"
    } else if lower.contains("edit") || lower.contains("patch") {
        "edit"
    } else {
        "modify"
    }
}

fn touched_input(
    path: String,
    operation: &str,
    start_line: Option<i64>,
    end_line: Option<i64>,
) -> LensTouchedFileInput {
    LensTouchedFileInput {
        path,
        operation: operation.to_string(),
        start_line,
        end_line,
        generated: false,
        include_ignored: false,
    }
}

fn string_field(value: &Value, fields: &[&str]) -> Option<String> {
    fields.iter().find_map(|field| {
        value
            .get(*field)
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(ToString::to_string)
    })
}

fn i64_field(value: &Value, fields: &[&str]) -> Option<i64> {
    fields.iter().find_map(|field| {
        value.get(*field).and_then(|field_value| {
            field_value
                .as_i64()
                .or_else(|| field_value.as_u64().map(|n| n as i64))
        })
    })
}

fn bool_field(value: &Value, fields: &[&str]) -> bool {
    fields
        .iter()
        .any(|field| value.get(*field).and_then(Value::as_bool).unwrap_or(false))
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
    let mut response = base_response(&event, LensHookDecisionOutcome::Allow, "tool_allowed");
    match record_tool_turn_event(
        &event,
        LensTurnEventKind::ToolStart,
        LensToolEventPhase::PreTool,
    ) {
        Ok(envelope) => {
            response
                .actions
                .push(action("record_turn_event", "ok", None));
            response.data = Some(json!({ "turn": envelope.data }));
        }
        Err(error) => push_error(&mut response, "pre_tool_record_failed", error),
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn native_post_tool_payload_maps_to_lens_event() {
        let temp = tempfile::tempdir().unwrap();
        let input = json!({
            "session_id": "session-1",
            "cwd": temp.path().display().to_string(),
            "hook_event_name": "PostToolUse",
            "tool_name": "Read",
            "tool_call_id": "tool-1",
            "tool_input": {
                "file_path": "src/main.rs",
                "offset": 3,
                "limit": 4
            },
            "tool_response": {
                "content": "fn main() {}"
            }
        });

        let event =
            parse_event(LensLifecycleHook::PostTool, &input.to_string(), temp.path()).unwrap();

        assert_eq!(event.schema_version, LENS_HOOK_EVENT_SCHEMA_VERSION);
        assert_eq!(event.host.kind.as_deref(), Some("native-hook"));
        assert_eq!(event.session.id, "session-1");
        assert_eq!(event.turn.id, "session-1");
        assert_eq!(event.event, LensHookEventKind::PostTool);
        let tool = event.tool.unwrap();
        assert_eq!(tool.name, "Read");
        assert_eq!(tool.id.as_deref(), Some("tool-1"));
        assert_eq!(tool.status.as_deref(), Some("success"));
        assert_eq!(event.known_files.len(), 1);
        assert_eq!(event.known_files[0].path, "src/main.rs");
        assert_eq!(event.known_files[0].operation, "read");
        assert_eq!(event.known_files[0].start_line, Some(3));
        assert_eq!(event.known_files[0].end_line, Some(6));
    }

    #[test]
    fn lens_schema_payload_still_parses_without_native_adapter() {
        let temp = tempfile::tempdir().unwrap();
        let input = json!({
            "schema_version": LENS_HOOK_EVENT_SCHEMA_VERSION,
            "host": { "name": "pi", "kind": "extension" },
            "session": { "id": "s" },
            "cwd": temp.path().display().to_string(),
            "turn": { "id": "t" },
            "event": "pre_tool",
            "known_files": [],
            "policy": {}
        });

        let event =
            parse_event(LensLifecycleHook::PreTool, &input.to_string(), temp.path()).unwrap();

        assert_eq!(event.host.name, "pi");
        assert_eq!(event.session.id, "s");
        assert_eq!(event.turn.id, "t");
        assert_eq!(event.event, LensHookEventKind::PreTool);
    }

    #[test]
    fn native_stop_response_uses_host_hook_schema() {
        let temp = tempfile::tempdir().unwrap();
        let input = json!({
            "session_id": "session-1",
            "cwd": temp.path().display().to_string(),
            "hook_event_name": "Stop"
        });

        let response =
            handle_lifecycle_hook(LensLifecycleHook::AgentEnd, &input.to_string(), temp.path());
        let native = native_hook_response(LensLifecycleHook::AgentEnd, &response);

        assert!(native.get("schema_version").is_none());
        assert_eq!(native["continue"], true);
        assert!(native.get("suppressOutput").is_none());
        assert!(native.get("decision").is_none());
        assert!(native.get("hookSpecificOutput").is_none());
    }

    #[test]
    fn native_claude_response_can_suppress_output() {
        let temp = tempfile::tempdir().unwrap();
        let input = json!({
            "session_id": "session-1",
            "cwd": temp.path().display().to_string(),
            "hook_event_name": "Stop"
        });

        let mut response =
            handle_lifecycle_hook(LensLifecycleHook::AgentEnd, &input.to_string(), temp.path());
        response.host.name = "claude-code".to_string();
        let native = native_hook_response(LensLifecycleHook::AgentEnd, &response);

        assert_eq!(native["suppressOutput"], true);
    }

    #[test]
    fn native_codex_pre_tool_allow_response_stays_silent() {
        let temp = tempfile::tempdir().unwrap();
        let input = json!({
            "session_id": "session-1",
            "cwd": temp.path().display().to_string(),
            "hook_event_name": "PreToolUse",
            "tool_name": "Bash",
            "tool_input": {"command": "date"}
        });

        let mut response =
            handle_lifecycle_hook(LensLifecycleHook::PreTool, &input.to_string(), temp.path());
        response.host.name = "codex".to_string();
        let native = native_hook_response(LensLifecycleHook::PreTool, &response);

        assert_eq!(native["continue"], true);
        assert!(native.get("hookSpecificOutput").is_none());
    }
}
