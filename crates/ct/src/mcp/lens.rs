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
        json_success(&json!({ "cwd": input.cwd, "available": true, "note": "lens MCP scaffold" }))
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
