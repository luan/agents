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
