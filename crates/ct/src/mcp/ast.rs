use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ErrorData};
use rmcp::schemars::{self, JsonSchema};
use rmcp::{ServerHandler, tool, tool_handler, tool_router};
use serde::Deserialize;
use serde_json::json;

use super::json_success;

#[derive(Debug, Deserialize, JsonSchema)]
struct SearchIn {
    pattern: String,
    lang: String,
    paths: Option<Vec<String>>,
    selector: Option<String>,
    context: Option<usize>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct ReplaceIn {
    pattern: String,
    rewrite: String,
    lang: String,
    paths: Option<Vec<String>>,
    apply: Option<bool>,
}

#[derive(Clone)]
pub(super) struct AstMcpServer {
    tool_router: ToolRouter<Self>,
}

impl AstMcpServer {
    pub(super) fn new() -> Self {
        Self {
            tool_router: Self::tool_router(),
        }
    }
}

#[tool_router(router = tool_router)]
impl AstMcpServer {
    #[tool(
        name = "search",
        description = "Search code using AST-aware pattern matching."
    )]
    async fn search(
        &self,
        Parameters(input): Parameters<SearchIn>,
    ) -> Result<CallToolResult, ErrorData> {
        json_success(&json!({
            "pattern": input.pattern,
            "lang": input.lang,
            "paths": input.paths.unwrap_or_default(),
            "selector": input.selector,
            "context": input.context,
            "matches": [],
            "match_count": 0,
            "available": false,
            "note": "native ast-grep execution is not wired yet"
        }))
    }

    #[tool(
        name = "replace",
        description = "Replace code using AST-aware pattern matching; dry-run by default."
    )]
    async fn replace(
        &self,
        Parameters(input): Parameters<ReplaceIn>,
    ) -> Result<CallToolResult, ErrorData> {
        json_success(&json!({
            "pattern": input.pattern,
            "rewrite": input.rewrite,
            "lang": input.lang,
            "paths": input.paths.unwrap_or_default(),
            "applied": input.apply.unwrap_or(false),
            "matches": [],
            "match_count": 0,
            "available": false,
            "note": "native ast-grep replacement is not wired yet"
        }))
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for AstMcpServer {
    fn get_info(&self) -> rmcp::model::ServerInfo {
        rmcp::model::ServerInfo::new(
            rmcp::model::ServerCapabilities::builder()
                .enable_tools()
                .build(),
        )
        .with_server_info(rmcp::model::Implementation::new(
            "ast",
            env!("CARGO_PKG_VERSION"),
        ))
    }
}
