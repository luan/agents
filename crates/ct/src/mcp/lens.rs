use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ErrorData};
use rmcp::schemars::{self, JsonSchema};
use rmcp::{ServerHandler, tool, tool_handler, tool_router};
use serde::Deserialize;
use serde_json::json;

use super::json_success;

#[derive(Debug, Deserialize, JsonSchema)]
struct StatusIn {
    cwd: Option<String>,
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
        let root = cwd(input.cwd)?;
        let store = crate::lens::LensStore::open_for_project(&root)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        let counts = store
            .counts()
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        let db_path = crate::lens::project_db_path(&root)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        json_success(&json!({
            "project_id": store.project_id(),
            "db_path": db_path,
            "counts": counts,
            "available": true
        }))
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
        json_success(&json!({
            "project_id": store.project_id(),
            "session": input.session,
            "path": input.path,
            "range": range,
            "recorded": true
        }))
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
        json_success(&json!({
            "project_id": store.project_id(),
            "session": input.session,
            "decision": decision.decision,
            "reason": decision.reason,
            "file": decision.file,
            "required_ranges": decision.required_ranges,
            "covered_ranges": decision.covered_ranges
        }))
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
        json_success(&json!({
            "project_id": store.project_id(),
            "path": input.path,
            "diagnostics": diagnostics,
            "diagnostic_count": diagnostics.len()
        }))
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
        json_success(&json!({
            "project_id": store.project_id(),
            "recorded": true,
            "diagnostic": diagnostic
        }))
    }
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
