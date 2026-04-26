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
        json_success(&json!({
            "operation": input.operation,
            "filePath": input.file_path,
            "line": input.line,
            "character": input.character,
            "query": input.query,
            "newName": input.new_name,
            "result": null,
            "resultCount": 0,
            "failureKind": "no_server",
            "note": "LSP client is not wired yet"
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
