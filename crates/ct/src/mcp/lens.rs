use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ErrorData};
use rmcp::schemars::{self, JsonSchema};
use rmcp::{ServerHandler, tool, tool_handler, tool_router};
use serde::Deserialize;
use serde_json::json;

use super::json_success;

#[derive(Debug, Clone, Deserialize, JsonSchema)]
struct StatusIn {
    cwd: Option<String>,
    disk: Option<bool>,
    debug: Option<bool>,
    raw: Option<bool>,
    guard_mode: Option<String>,
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
    debug: Option<bool>,
    raw: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct ReadRecordIn {
    cwd: Option<String>,
    path: String,
    start_line: i64,
    end_line: i64,
    session: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct GuardCheckIn {
    cwd: Option<String>,
    path: String,
    start_line: i64,
    end_line: i64,
    session: Option<String>,
    mode: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct DiagnosticsListIn {
    cwd: Option<String>,
    path: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct DiagnosticsRecordIn {
    cwd: Option<String>,
    source: String,
    severity: String,
    path: Option<String>,
    code: Option<String>,
    message: String,
    start_line: Option<i64>,
    end_line: Option<i64>,
    fingerprint: Option<String>,
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
    #[tool(name = "status", description = "Show lens state status.")]
    async fn status(
        &self,
        Parameters(input): Parameters<StatusIn>,
    ) -> Result<CallToolResult, ErrorData> {
        let envelope = status_envelope(input)?;
        json_success(&envelope)
    }

    #[tool(
        name = "discover",
        description = "Route code discovery intents to sym, AST, source, or LSP backends."
    )]
    async fn discover(
        &self,
        Parameters(input): Parameters<DiscoverIn>,
    ) -> Result<CallToolResult, ErrorData> {
        let envelope = discover_envelope(input)?;
        json_success(&envelope)
    }

    #[tool(
        name = "read_record",
        description = "Record a read range for lens guard coverage."
    )]
    async fn read_record(
        &self,
        Parameters(input): Parameters<ReadRecordIn>,
    ) -> Result<CallToolResult, ErrorData> {
        let root = cwd(input.cwd)?;
        let mut store = crate::lens::LensStore::open_for_project(&root)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        let range = store
            .record_read(
                input.session.as_deref(),
                std::path::Path::new(&input.path),
                input.start_line,
                input.end_line,
            )
            .map_err(|error| ErrorData::invalid_params(error.to_string(), None))?;
        json_success(&crate::lens::LensEnvelope::ok(json!({
            "project_id": store.project_id(),
            "session": input.session,
            "path": input.path,
            "range": range,
            "recorded": true
        })))
    }

    #[tool(
        name = "guard_check",
        description = "Check whether an edit range is covered by reads."
    )]
    async fn guard_check(
        &self,
        Parameters(input): Parameters<GuardCheckIn>,
    ) -> Result<CallToolResult, ErrorData> {
        let root = cwd(input.cwd)?;
        let mut store = crate::lens::LensStore::open_for_project(&root)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        let mode = match input.mode.as_deref().unwrap_or("warn") {
            "off" | "allow" => crate::lens::GuardAction::Allow,
            "warn" => crate::lens::GuardAction::Warn,
            "block" => crate::lens::GuardAction::Block,
            other => {
                return Err(ErrorData::invalid_params(
                    format!("invalid guard mode: {other}"),
                    None,
                ));
            }
        };
        let decision = store
            .check_guard(
                input.session.as_deref(),
                std::path::Path::new(&input.path),
                input.start_line,
                input.end_line,
                mode,
            )
            .map_err(|error| ErrorData::invalid_params(error.to_string(), None))?;
        json_success(&crate::lens::LensEnvelope::ok(json!({
            "project_id": store.project_id(),
            "session": input.session,
            "decision": decision.decision,
            "reason": decision.reason,
            "file": decision.file,
            "required_ranges": decision.required_ranges,
            "covered_ranges": decision.covered_ranges
        })))
    }

    #[tool(
        name = "diagnostics_list",
        description = "List diagnostics stored in ct lens."
    )]
    async fn diagnostics_list(
        &self,
        Parameters(input): Parameters<DiagnosticsListIn>,
    ) -> Result<CallToolResult, ErrorData> {
        let root = cwd(input.cwd)?;
        let store = crate::lens::LensStore::open_for_project(&root)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        let diagnostics = store
            .list_diagnostics(input.path.as_deref())
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        json_success(&crate::lens::LensEnvelope::ok(json!({
            "project_id": store.project_id(),
            "path": input.path,
            "diagnostics": diagnostics,
            "diagnostic_count": diagnostics.len()
        })))
    }

    #[tool(
        name = "diagnostics_record",
        description = "Record one diagnostic in ct lens."
    )]
    async fn diagnostics_record(
        &self,
        Parameters(input): Parameters<DiagnosticsRecordIn>,
    ) -> Result<CallToolResult, ErrorData> {
        let root = cwd(input.cwd)?;
        let mut store = crate::lens::LensStore::open_for_project(&root)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        let fingerprint = input.fingerprint.unwrap_or_else(|| {
            crate::apply_patch::sha1_hex(
                format!(
                    "{}:{}:{:?}:{:?}:{:?}:{:?}:{}",
                    input.source,
                    input.severity,
                    input.path,
                    input.start_line,
                    input.end_line,
                    input.code,
                    input.message
                )
                .as_bytes(),
            )
        });
        let diagnostic = crate::lens::Diagnostic {
            source: parse_source(&input.source),
            severity: parse_severity(&input.severity)?,
            code: input.code,
            message: input.message,
            rel_path: input.path,
            start_line: input.start_line,
            end_line: input.end_line,
            fingerprint,
            content_hash: None,
        };
        store
            .record_diagnostics(std::slice::from_ref(&diagnostic))
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        json_success(&crate::lens::LensEnvelope::ok(json!({
            "project_id": store.project_id(),
            "recorded": true,
            "diagnostic": diagnostic
        })))
    }
}

fn discover_envelope(
    input: DiscoverIn,
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
    options.limit = input.limit.unwrap_or(10);
    options.context = input.context.unwrap_or(2);
    options.session = input.session;
    options.lsp_operation = input.lsp_operation;
    options.include_debug = input.debug.unwrap_or(false);
    options.include_raw = input.raw.unwrap_or(false);
    crate::lens::build_discovery_envelope(options)
        .map_err(|error| ErrorData::internal_error(error.to_string(), None))
}

fn status_envelope(
    input: StatusIn,
) -> Result<crate::lens::LensEnvelope<crate::lens::LensStatusData>, ErrorData> {
    let root = cwd(input.cwd)?;
    let guard_mode = match input.guard_mode.as_deref() {
        Some("off") | Some("allow") => Some(crate::lens::LensGuardMode::Off),
        Some("warn") => Some(crate::lens::LensGuardMode::Warn),
        Some("block") => Some(crate::lens::LensGuardMode::Block),
        None => None,
        Some(other) => {
            return Err(ErrorData::invalid_params(
                format!("invalid guard mode: {other}"),
                None,
            ));
        }
    };
    crate::lens::build_status_envelope(
        &root,
        crate::lens::LensStatusOptions {
            include_disk: input.disk.unwrap_or(false),
            include_debug: input.debug.unwrap_or(false),
            include_raw: input.raw.unwrap_or(false),
            runtime_policy: crate::lens::RuntimePolicyOverrides {
                guard_mode,
                allow_overrides: None,
            },
            ..crate::lens::LensStatusOptions::default()
        },
    )
    .map_err(|error| ErrorData::internal_error(error.to_string(), None))
}

fn parse_source(source: &str) -> crate::lens::DiagnosticSource {
    match source {
        "lsp" => crate::lens::DiagnosticSource::Lsp,
        "ast_grep" => crate::lens::DiagnosticSource::AstGrep,
        "tree_sitter" => crate::lens::DiagnosticSource::TreeSitter,
        "secrets" => crate::lens::DiagnosticSource::Secrets,
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

    #[test]
    fn mcp_discover_uses_shared_normalized_discovery_envelope() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("main.rs"), "fn target() {}\n").unwrap();
        let cwd = temp.path().display().to_string();
        let mcp = discover_envelope(DiscoverIn {
            cwd: Some(cwd.clone()),
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
            debug: Some(false),
            raw: Some(false),
        })
        .unwrap();
        let mut options = crate::lens::DiscoveryOptions::new(
            temp.path().to_path_buf(),
            crate::lens::DiscoveryIntent::Symbol,
        );
        options.query = Some("target".to_string());
        options.session = Some("mcp".to_string());
        let direct = crate::lens::build_discovery_envelope(options).unwrap();

        assert_eq!(
            serde_json::to_value(mcp).unwrap(),
            serde_json::to_value(direct).unwrap()
        );
    }

    #[test]
    fn mcp_status_matches_shared_normalized_status_envelope() {
        let temp = tempfile::tempdir().unwrap();
        let cwd = temp.path().display().to_string();
        let mcp = status_envelope(StatusIn {
            cwd: Some(cwd.clone()),
            disk: Some(false),
            debug: Some(false),
            raw: Some(false),
            guard_mode: None,
        })
        .unwrap();
        let direct = crate::lens::build_status_envelope(
            temp.path(),
            crate::lens::LensStatusOptions::default(),
        )
        .unwrap();

        assert_eq!(
            serde_json::to_value(mcp).unwrap(),
            serde_json::to_value(direct).unwrap()
        );
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
