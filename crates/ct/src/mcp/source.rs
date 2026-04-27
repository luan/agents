use std::path::PathBuf;

use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ErrorData};
use rmcp::schemars::{self, JsonSchema};
use rmcp::{ServerHandler, tool, tool_handler, tool_router};
use serde::Deserialize;

use super::json_success;

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
enum SearchMode {
    Symbol,
    Text,
    Path,
    Structural,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct SearchIn {
    #[schemars(description = "Search query; structural mode may use pattern instead")]
    query: Option<String>,
    #[schemars(description = "Search mode: symbol, text, path, or structural")]
    mode: Option<SearchMode>,
    #[schemars(description = "Maximum results to return (default 20)")]
    limit: Option<usize>,
    #[schemars(description = "Symbol kind filter for symbol mode")]
    kind: Option<String>,
    #[schemars(description = "Language filter; required for structural mode")]
    lang: Option<String>,
    #[schemars(description = "Require exact matching where supported")]
    exact: Option<bool>,
    #[schemars(description = "Case-insensitive matching where supported")]
    ignore_case: Option<bool>,
    #[schemars(description = "Repeatable include path/glob filters")]
    paths: Option<Vec<String>>,
    #[schemars(description = "Repeatable exclude path/glob filters")]
    excludes: Option<Vec<String>>,
    #[schemars(description = "Structural AST pattern; defaults to query")]
    pattern: Option<String>,
    #[schemars(description = "ast-grep selector for structural mode")]
    selector: Option<String>,
    #[schemars(description = "Context lines around structural matches")]
    context: Option<usize>,
    #[schemars(description = "Include ignored files where the backend supports it")]
    include_ignored: Option<bool>,
    #[schemars(description = "Working directory; defaults to the MCP server cwd")]
    cwd: Option<String>,
    #[schemars(description = "Override sym database path for symbol mode")]
    db: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct ShowIn {
    #[schemars(description = "Symbol names, file paths, or file:line-line ranges")]
    targets: Vec<String>,
    #[schemars(description = "Context lines around symbol definitions or ranges (default 0)")]
    context: Option<usize>,
    #[schemars(description = "Return every definition when a target is ambiguous")]
    all: Option<bool>,
    #[schemars(description = "Working directory; defaults to the MCP server cwd")]
    cwd: Option<String>,
    #[schemars(description = "Override sym database path")]
    db: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct OutlineIn {
    #[schemars(description = "File to outline")]
    file: String,
    #[schemars(description = "Include signatures where supported by renderers")]
    signatures: Option<bool>,
    #[schemars(description = "Only return unique symbol names")]
    names: Option<bool>,
    #[schemars(description = "Working directory; defaults to the MCP server cwd")]
    cwd: Option<String>,
    #[schemars(description = "Override sym database path")]
    db: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct RefsIn {
    #[schemars(description = "Symbol names to find references for")]
    targets: Vec<String>,
    #[schemars(description = "Also include files importing the defining file")]
    importers: Option<bool>,
    #[schemars(description = "Route to transitive impact analysis")]
    impact: Option<bool>,
    #[schemars(description = "Reference/importer depth (default 1)")]
    depth: Option<usize>,
    #[schemars(description = "Maximum results (default 20)")]
    limit: Option<usize>,
    #[schemars(description = "Context lines around references (default 1)")]
    context: Option<usize>,
    #[schemars(description = "Repeatable include globs")]
    paths: Option<Vec<String>>,
    #[schemars(description = "Repeatable exclude globs")]
    excludes: Option<Vec<String>>,
    #[schemars(description = "Limit references to paths containing this fragment")]
    file: Option<String>,
    #[schemars(description = "Working directory; defaults to the MCP server cwd")]
    cwd: Option<String>,
    #[schemars(description = "Override sym database path")]
    db: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct GraphIn {
    #[schemars(description = "Symbol names to analyze")]
    targets: Vec<String>,
    #[schemars(description = "Traversal depth")]
    depth: Option<usize>,
    #[schemars(description = "Maximum results")]
    limit: Option<usize>,
    #[schemars(description = "Context lines around hits; impact only")]
    context: Option<usize>,
    #[schemars(description = "Trace edge kinds, e.g. call or call,use; trace only")]
    kinds: Option<String>,
    #[schemars(description = "Working directory; defaults to the MCP server cwd")]
    cwd: Option<String>,
    #[schemars(description = "Override sym database path")]
    db: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct ImplsIn {
    #[schemars(description = "Symbols to find implementations/conformances for")]
    targets: Vec<String>,
    #[schemars(description = "Language filter")]
    lang: Option<String>,
    #[schemars(description = "Maximum results (default 50)")]
    limit: Option<usize>,
    #[schemars(description = "Repeatable include globs")]
    paths: Option<Vec<String>>,
    #[schemars(description = "Repeatable exclude globs")]
    excludes: Option<Vec<String>>,
    #[schemars(description = "Find protocols/interfaces implemented by this symbol")]
    of: Option<String>,
    #[schemars(description = "Only include resolved implementation targets")]
    resolved: Option<bool>,
    #[schemars(description = "Only include unresolved implementation targets")]
    unresolved: Option<bool>,
    #[schemars(description = "Working directory; defaults to the MCP server cwd")]
    cwd: Option<String>,
    #[schemars(description = "Override sym database path")]
    db: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct TargetsIn {
    #[schemars(description = "Symbol names to investigate")]
    targets: Vec<String>,
    #[schemars(description = "Working directory; defaults to the MCP server cwd")]
    cwd: Option<String>,
    #[schemars(description = "Override sym database path")]
    db: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct DiffIn {
    #[schemars(description = "Symbol whose definition-scoped diff should be shown")]
    target: String,
    #[schemars(description = "Base ref (default HEAD)")]
    base: Option<String>,
    #[schemars(description = "Return diffstat instead of full diff")]
    stat: Option<bool>,
    #[schemars(description = "Working directory; defaults to the MCP server cwd")]
    cwd: Option<String>,
    #[schemars(description = "Override sym database path")]
    db: Option<String>,
}

#[derive(Clone)]
pub(super) struct SourceMcpServer {
    tool_router: ToolRouter<Self>,
}

impl SourceMcpServer {
    pub(super) fn new() -> Self {
        Self {
            tool_router: Self::tool_router(),
        }
    }
}

#[tool_router(router = tool_router)]
impl SourceMcpServer {
    #[tool(
        name = "search",
        description = "Search source by symbol, text, path, or structural AST pattern."
    )]
    async fn search(
        &self,
        Parameters(input): Parameters<SearchIn>,
    ) -> Result<CallToolResult, ErrorData> {
        let cwd = input_cwd(input.cwd)?;
        let output =
            crate::cli::source::source_search_value(crate::cli::source::SourceSearchRequest {
                cwd,
                mode: input.mode.unwrap_or(SearchMode::Symbol).into(),
                query: input.query.unwrap_or_default(),
                limit: input.limit.unwrap_or(20),
                kind: input.kind,
                lang: input.lang,
                exact: input.exact.unwrap_or(false),
                ignore_case: input.ignore_case.unwrap_or(false),
                paths: input.paths.unwrap_or_default(),
                excludes: input.excludes.unwrap_or_default(),
                pattern: input.pattern,
                selector: input.selector,
                context: input.context,
                include_ignored: input.include_ignored.unwrap_or(false),
                db: input.db,
            })
            .map_err(|error| ErrorData::invalid_params(error.to_string(), None))?;
        json_success(&output)
    }

    #[tool(
        name = "show",
        description = "Show source by symbol, file path, or file:line-line range."
    )]
    async fn show(
        &self,
        Parameters(input): Parameters<ShowIn>,
    ) -> Result<CallToolResult, ErrorData> {
        let cwd = input_cwd(input.cwd)?;
        let output = crate::cli::source::source_show_value(crate::cli::source::SourceShowRequest {
            cwd,
            targets: input.targets,
            context: input.context.unwrap_or(0),
            all: input.all.unwrap_or(false),
            db: input.db,
        })
        .map_err(|error| ErrorData::invalid_params(error.to_string(), None))?;
        json_success(&output)
    }

    #[tool(name = "outline", description = "List symbols defined in a file.")]
    async fn outline(
        &self,
        Parameters(input): Parameters<OutlineIn>,
    ) -> Result<CallToolResult, ErrorData> {
        let cwd = input_cwd(input.cwd)?;
        let output =
            crate::cli::source::source_outline_value(crate::cli::source::SourceOutlineRequest {
                cwd,
                file: PathBuf::from(input.file),
                signatures: input.signatures.unwrap_or(false),
                names: input.names.unwrap_or(false),
                db: input.db,
            })
            .map_err(|error| ErrorData::invalid_params(error.to_string(), None))?;
        json_success(&output)
    }

    #[tool(name = "refs", description = "Find direct references to symbols.")]
    async fn refs(
        &self,
        Parameters(input): Parameters<RefsIn>,
    ) -> Result<CallToolResult, ErrorData> {
        let cwd = input_cwd(input.cwd)?;
        let output = crate::cli::source::source_refs_value(crate::cli::source::SourceRefsRequest {
            cwd,
            targets: input.targets,
            importers: input.importers.unwrap_or(false),
            impact: input.impact.unwrap_or(false),
            depth: input.depth.unwrap_or(1),
            limit: input.limit.unwrap_or(20),
            context: input.context.unwrap_or(1),
            paths: input.paths.unwrap_or_default(),
            excludes: input.excludes.unwrap_or_default(),
            file: input.file,
            db: input.db,
        })
        .map_err(|error| ErrorData::invalid_params(error.to_string(), None))?;
        json_success(&output)
    }

    #[tool(
        name = "impact",
        description = "Find transitive callers/dependents of symbols."
    )]
    async fn impact(
        &self,
        Parameters(input): Parameters<GraphIn>,
    ) -> Result<CallToolResult, ErrorData> {
        let cwd = input_cwd(input.cwd)?;
        let output =
            crate::cli::source::source_impact_value(crate::cli::source::SourceImpactRequest {
                cwd,
                targets: input.targets,
                depth: input.depth.unwrap_or(2),
                limit: input.limit.unwrap_or(50),
                context: input.context.unwrap_or(1),
                db: input.db,
            })
            .map_err(|error| ErrorData::invalid_params(error.to_string(), None))?;
        json_success(&output)
    }

    #[tool(
        name = "trace",
        description = "Follow the call graph downward from symbols."
    )]
    async fn trace(
        &self,
        Parameters(input): Parameters<GraphIn>,
    ) -> Result<CallToolResult, ErrorData> {
        let cwd = input_cwd(input.cwd)?;
        let output =
            crate::cli::source::source_trace_value(crate::cli::source::SourceTraceRequest {
                cwd,
                targets: input.targets,
                depth: input.depth.unwrap_or(3),
                limit: input.limit.unwrap_or(50),
                kinds: input.kinds.unwrap_or_else(|| "call".to_string()),
                db: input.db,
            })
            .map_err(|error| ErrorData::invalid_params(error.to_string(), None))?;
        json_success(&output)
    }

    #[tool(
        name = "impls",
        description = "Find types that implement/extend/conform to symbols."
    )]
    async fn impls(
        &self,
        Parameters(input): Parameters<ImplsIn>,
    ) -> Result<CallToolResult, ErrorData> {
        let cwd = input_cwd(input.cwd)?;
        let output =
            crate::cli::source::source_impls_value(crate::cli::source::SourceImplsRequest {
                cwd,
                targets: input.targets,
                lang: input.lang,
                limit: input.limit.unwrap_or(50),
                paths: input.paths.unwrap_or_default(),
                excludes: input.excludes.unwrap_or_default(),
                of: input.of,
                resolved: input.resolved.unwrap_or(false),
                unresolved: input.unresolved.unwrap_or(false),
                db: input.db,
            })
            .map_err(|error| ErrorData::invalid_params(error.to_string(), None))?;
        json_success(&output)
    }

    #[tool(
        name = "investigate",
        description = "Resolve and inspect symbols with kind-adaptive context."
    )]
    async fn investigate(
        &self,
        Parameters(input): Parameters<TargetsIn>,
    ) -> Result<CallToolResult, ErrorData> {
        let cwd = input_cwd(input.cwd)?;
        let output = crate::cli::source::source_investigate_value(
            crate::cli::source::SourceInvestigateRequest {
                cwd,
                targets: input.targets,
                db: input.db,
            },
        )
        .map_err(|error| ErrorData::invalid_params(error.to_string(), None))?;
        json_success(&output)
    }

    #[tool(
        name = "diff",
        description = "Return git diff scoped to a symbol definition."
    )]
    async fn diff(
        &self,
        Parameters(input): Parameters<DiffIn>,
    ) -> Result<CallToolResult, ErrorData> {
        let cwd = input_cwd(input.cwd)?;
        let output = crate::cli::source::source_diff_value(crate::cli::source::SourceDiffRequest {
            cwd,
            target: input.target,
            base: input.base.unwrap_or_else(|| "HEAD".to_string()),
            stat: input.stat.unwrap_or(false),
            db: input.db,
        })
        .map_err(|error| ErrorData::invalid_params(error.to_string(), None))?;
        json_success(&output)
    }
}

fn input_cwd(cwd: Option<String>) -> Result<PathBuf, ErrorData> {
    match cwd {
        Some(cwd) => Ok(PathBuf::from(cwd)),
        None => std::env::current_dir()
            .map_err(|error| ErrorData::internal_error(error.to_string(), None)),
    }
}

#[cfg(test)]
mod tests {
    use super::SourceMcpServer;

    #[test]
    fn source_mcp_exposes_short_source_tool_names() {
        let server = SourceMcpServer::new();
        let names = server
            .tool_router
            .list_all()
            .into_iter()
            .map(|tool| tool.name.to_string())
            .collect::<Vec<_>>();

        assert_eq!(
            names,
            vec![
                "diff",
                "impact",
                "impls",
                "investigate",
                "outline",
                "refs",
                "search",
                "show",
                "trace"
            ]
        );
    }
}

impl From<SearchMode> for crate::cli::SourceSearchMode {
    fn from(mode: SearchMode) -> Self {
        match mode {
            SearchMode::Symbol => Self::Symbol,
            SearchMode::Text => Self::Text,
            SearchMode::Path => Self::Path,
            SearchMode::Structural => Self::Structural,
        }
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for SourceMcpServer {
    fn get_info(&self) -> rmcp::model::ServerInfo {
        rmcp::model::ServerInfo::new(
            rmcp::model::ServerCapabilities::builder()
                .enable_tools()
                .build(),
        )
        .with_server_info(rmcp::model::Implementation::new(
            "source",
            env!("CARGO_PKG_VERSION"),
        ))
    }
}
