use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ErrorData};
use rmcp::schemars::{self, JsonSchema};
use rmcp::{ServerHandler, tool, tool_handler, tool_router};
use serde::Deserialize;
use serde_json::json;

use super::json_success;

#[derive(Debug, Deserialize, JsonSchema)]
struct RequestIn {
    operation: String,
    file_path: Option<String>,
    line: Option<usize>,
    character: Option<usize>,
    query: Option<String>,
    new_name: Option<String>,
}

#[derive(Clone)]
pub(super) struct LspMcpServer {
    tool_router: ToolRouter<Self>,
}

impl LspMcpServer {
    pub(super) fn new() -> Self {
        Self {
            tool_router: Self::tool_router(),
        }
    }
}

#[tool_router(router = tool_router)]
impl LspMcpServer {
    #[tool(name = "request", description = "Run an LSP navigation request.")]
    async fn request(
        &self,
        Parameters(input): Parameters<RequestIn>,
    ) -> Result<CallToolResult, ErrorData> {
        let Some(file_path) = input.file_path.clone() else {
            return Err(ErrorData::invalid_params(
                "LSP request requires file_path".to_string(),
                None,
            ));
        };
        let path = std::path::PathBuf::from(&file_path);
        let path = if path.is_absolute() {
            path
        } else {
            std::env::current_dir()
                .map_err(|error| ErrorData::internal_error(error.to_string(), None))?
                .join(path)
        };
        let Some(probe) = crate::lsp::registry::probe_for_file(&path) else {
            return json_success(&json!({
                "operation": input.operation,
                "filePath": path,
                "line": input.line,
                "character": input.character,
                "query": input.query,
                "newName": input.new_name,
                "server": null,
                "result": null,
                "resultCount": 0,
                "failureKind": "no_server_definition"
            }));
        };
        if !probe.available {
            return json_success(&json!({
                "operation": input.operation,
                "filePath": path,
                "line": input.line,
                "character": input.character,
                "query": input.query,
                "newName": input.new_name,
                "server": probe,
                "result": null,
                "resultCount": 0,
                "failureKind": "server_unavailable"
            }));
        }
        let mut client = crate::lsp::client::LspClient::start(&probe)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        client
            .initialize(&probe)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        client
            .open_file(&probe, &path)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        let output = client
            .run_text_operation(
                &input.operation,
                &path,
                input.line,
                input.character,
                input.query.as_deref(),
                input.new_name.as_deref(),
            )
            .map_err(|error| ErrorData::invalid_params(error.to_string(), None))?;
        json_success(&json!({
            "operation": input.operation,
            "filePath": path,
            "line": input.line,
            "character": input.character,
            "query": input.query,
            "newName": input.new_name,
            "server": probe,
            "result": output.result,
            "resultCount": output.result_count,
            "failureKind": null
        }))
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for LspMcpServer {
    fn get_info(&self) -> rmcp::model::ServerInfo {
        rmcp::model::ServerInfo::new(
            rmcp::model::ServerCapabilities::builder()
                .enable_tools()
                .build(),
        )
        .with_server_info(rmcp::model::Implementation::new(
            "lsp",
            env!("CARGO_PKG_VERSION"),
        ))
    }
}
