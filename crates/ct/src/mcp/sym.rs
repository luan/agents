use std::path::PathBuf;
use std::process::Command;

use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ErrorData};
use rmcp::schemars::{self, JsonSchema};
use rmcp::{ServerHandler, tool, tool_handler, tool_router};
use serde::Deserialize;
use serde_json::{Value, json};

use super::json_success;

#[derive(Debug, Deserialize, JsonSchema)]
struct SearchIn {
    #[schemars(description = "Symbol or text query")]
    query: String,
    #[schemars(description = "Search full text instead of indexed symbols")]
    text: Option<bool>,
    #[schemars(description = "Maximum results to return (default 20)")]
    limit: Option<usize>,
    #[schemars(description = "Symbol kind filter, e.g. function, class, struct, interface")]
    kind: Option<String>,
    #[schemars(description = "Language filter, e.g. rust, go, typescript")]
    lang: Option<String>,
    #[schemars(description = "Require exact matching")]
    exact: Option<bool>,
    #[schemars(description = "Case-insensitive matching")]
    ignore_case: Option<bool>,
    #[schemars(description = "Repeatable include globs, e.g. src/**")]
    path: Option<Vec<String>>,
    #[schemars(description = "Repeatable exclude globs")]
    exclude: Option<Vec<String>>,
    #[schemars(description = "Working directory; defaults to the MCP server cwd")]
    cwd: Option<String>,
    #[schemars(description = "Override sym database path")]
    db: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct TargetsIn {
    #[schemars(description = "Symbol names or file/range targets")]
    targets: Vec<String>,
    #[schemars(description = "Working directory; defaults to the MCP server cwd")]
    cwd: Option<String>,
    #[schemars(description = "Override sym database path")]
    db: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct ShowIn {
    #[schemars(description = "Symbol names, file paths, or file:line-line ranges")]
    targets: Vec<String>,
    #[schemars(description = "Context lines around symbol definitions (default 0)")]
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
    #[schemars(description = "Include signatures")]
    signatures: Option<bool>,
    #[schemars(description = "Only return names")]
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
    #[schemars(description = "Include shallow transitive impact")]
    impact: Option<bool>,
    #[schemars(description = "Reference/importer depth (default 1)")]
    depth: Option<usize>,
    #[schemars(description = "Maximum results (default 20)")]
    limit: Option<usize>,
    #[schemars(description = "Context lines around references (default 1)")]
    context: Option<usize>,
    #[schemars(description = "Repeatable include globs")]
    path: Option<Vec<String>>,
    #[schemars(description = "Repeatable exclude globs")]
    exclude: Option<Vec<String>>,
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
    path: Option<Vec<String>>,
    #[schemars(description = "Repeatable exclude globs")]
    exclude: Option<Vec<String>>,
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
struct ContextIn {
    #[schemars(description = "Symbols to gather bundled context for")]
    targets: Vec<String>,
    #[schemars(description = "Maximum callers per symbol (default 20)")]
    callers: Option<usize>,
    #[schemars(description = "Working directory; defaults to the MCP server cwd")]
    cwd: Option<String>,
    #[schemars(description = "Override sym database path")]
    db: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct StructureIn {
    #[schemars(description = "Maximum entries per section (default 10)")]
    limit: Option<usize>,
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
pub(super) struct SymMcpServer {
    tool_router: ToolRouter<Self>,
}

impl SymMcpServer {
    pub(super) fn new() -> Self {
        Self {
            tool_router: Self::tool_router(),
        }
    }
}

#[tool_router(router = tool_router)]
impl SymMcpServer {
    #[tool(
        name = "search",
        description = "Search indexed symbols, or full text with text=true."
    )]
    async fn search(
        &self,
        Parameters(input): Parameters<SearchIn>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut args = vec!["search".to_string()];
        push_flag(&mut args, input.text.unwrap_or(false), "--text");
        push_opt(&mut args, "--limit", input.limit);
        push_opt(&mut args, "--kind", input.kind);
        push_opt(&mut args, "--lang", input.lang);
        push_flag(&mut args, input.exact.unwrap_or(false), "--exact");
        push_flag(
            &mut args,
            input.ignore_case.unwrap_or(false),
            "--ignore-case",
        );
        push_many(&mut args, "--path", input.path);
        push_many(&mut args, "--exclude", input.exclude);
        args.push(input.query);
        run_sym(args, input.cwd, input.db)
    }

    #[tool(
        name = "investigate",
        description = "Resolve and inspect symbols with kind-adaptive context."
    )]
    async fn investigate(
        &self,
        Parameters(input): Parameters<TargetsIn>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut args = vec!["investigate".to_string()];
        args.extend(input.targets);
        run_sym(args, input.cwd, input.db)
    }

    #[tool(
        name = "show",
        description = "Read source by symbol, file path, or file:line-line range."
    )]
    async fn show(
        &self,
        Parameters(input): Parameters<ShowIn>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut args = vec!["show".to_string()];
        push_opt(&mut args, "--context", input.context);
        push_flag(&mut args, input.all.unwrap_or(false), "--all");
        args.extend(input.targets);
        run_sym(args, input.cwd, input.db)
    }

    #[tool(name = "outline", description = "List symbols defined in a file.")]
    async fn outline(
        &self,
        Parameters(input): Parameters<OutlineIn>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut args = vec!["outline".to_string()];
        push_flag(&mut args, input.signatures.unwrap_or(false), "--signatures");
        push_flag(&mut args, input.names.unwrap_or(false), "--names");
        args.push(input.file);
        run_sym(args, input.cwd, input.db)
    }

    #[tool(name = "refs", description = "Find direct references to symbols.")]
    async fn refs(
        &self,
        Parameters(input): Parameters<RefsIn>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut args = vec!["refs".to_string()];
        push_flag(&mut args, input.importers.unwrap_or(false), "--importers");
        push_flag(&mut args, input.impact.unwrap_or(false), "--impact");
        push_opt(&mut args, "--depth", input.depth);
        push_opt(&mut args, "--limit", input.limit);
        push_opt(&mut args, "--context", input.context);
        push_many(&mut args, "--path", input.path);
        push_many(&mut args, "--exclude", input.exclude);
        push_opt(&mut args, "--file", input.file);
        args.extend(input.targets);
        run_sym(args, input.cwd, input.db)
    }

    #[tool(
        name = "impact",
        description = "Find transitive callers/dependents of symbols."
    )]
    async fn impact(
        &self,
        Parameters(input): Parameters<GraphIn>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut args = vec!["impact".to_string()];
        push_opt(&mut args, "--depth", input.depth);
        push_opt(&mut args, "--limit", input.limit);
        push_opt(&mut args, "--context", input.context);
        args.extend(input.targets);
        run_sym(args, input.cwd, input.db)
    }

    #[tool(
        name = "trace",
        description = "Follow the call graph downward from symbols."
    )]
    async fn trace(
        &self,
        Parameters(input): Parameters<GraphIn>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut args = vec!["trace".to_string()];
        push_opt(&mut args, "--depth", input.depth);
        push_opt(&mut args, "--limit", input.limit);
        push_opt(&mut args, "--kinds", input.kinds);
        args.extend(input.targets);
        run_sym(args, input.cwd, input.db)
    }

    #[tool(
        name = "impls",
        description = "Find types that implement/extend/conform to symbols."
    )]
    async fn impls(
        &self,
        Parameters(input): Parameters<ImplsIn>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut args = vec!["impls".to_string()];
        push_opt(&mut args, "--lang", input.lang);
        push_opt(&mut args, "--limit", input.limit);
        push_many(&mut args, "--path", input.path);
        push_many(&mut args, "--exclude", input.exclude);
        push_opt(&mut args, "--of", input.of);
        push_flag(&mut args, input.resolved.unwrap_or(false), "--resolved");
        push_flag(&mut args, input.unresolved.unwrap_or(false), "--unresolved");
        args.extend(input.targets);
        run_sym(args, input.cwd, input.db)
    }

    #[tool(
        name = "context",
        description = "Bundle source, callers, conformance, and file imports for symbols."
    )]
    async fn context(
        &self,
        Parameters(input): Parameters<ContextIn>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut args = vec!["context".to_string()];
        push_opt(&mut args, "--callers", input.callers);
        args.extend(input.targets);
        run_sym(args, input.cwd, input.db)
    }

    #[tool(
        name = "structure",
        description = "Return a structural overview of the indexed codebase."
    )]
    async fn structure(
        &self,
        Parameters(input): Parameters<StructureIn>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut args = vec!["structure".to_string()];
        push_opt(&mut args, "--limit", input.limit);
        run_sym(args, input.cwd, input.db)
    }

    #[tool(
        name = "diff",
        description = "Return git diff scoped to a symbol definition."
    )]
    async fn diff(
        &self,
        Parameters(input): Parameters<DiffIn>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut args = vec!["diff".to_string()];
        push_flag(&mut args, input.stat.unwrap_or(false), "--stat");
        args.push(input.target);
        if let Some(base) = input.base {
            args.push(base);
        }
        run_sym(args, input.cwd, input.db)
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for SymMcpServer {
    fn get_info(&self) -> rmcp::model::ServerInfo {
        rmcp::model::ServerInfo::new(
            rmcp::model::ServerCapabilities::builder()
                .enable_tools()
                .build(),
        )
        .with_server_info(rmcp::model::Implementation::new(
            "sym",
            env!("CARGO_PKG_VERSION"),
        ))
    }
}

fn run_sym(
    args: Vec<String>,
    cwd: Option<String>,
    db: Option<String>,
) -> Result<CallToolResult, ErrorData> {
    let output = run_sym_command(args, cwd, db)?;
    json_success(&output)
}

fn run_sym_command(
    args: Vec<String>,
    cwd: Option<String>,
    db: Option<String>,
) -> Result<Value, ErrorData> {
    let exe = std::env::current_exe()
        .map_err(|e| ErrorData::internal_error(format!("resolve current executable: {e}"), None))?;
    let mut cmd = Command::new(exe);
    cmd.arg("sym");
    cmd.arg("--json");
    if let Some(db) = db {
        cmd.arg("--db").arg(db);
    }
    cmd.args(&args);
    if let Some(cwd) = cwd {
        cmd.current_dir(PathBuf::from(cwd));
    }

    let out = cmd
        .output()
        .map_err(|e| ErrorData::internal_error(format!("run ct sym: {e}"), None))?;
    if !out.status.success() {
        return Err(sym_error(out.status.code(), &out.stdout, &out.stderr));
    }

    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut value: Value = serde_json::from_str(&stdout).map_err(|e| {
        ErrorData::internal_error(
            format!("ct sym returned invalid JSON: {e}"),
            Some(json!({ "stdout": stdout.trim() })),
        )
    })?;
    if let Some(results) = value.get_mut("results") {
        return Ok(results.take());
    }
    Ok(value)
}

fn sym_error(code: Option<i32>, stdout: &[u8], stderr: &[u8]) -> ErrorData {
    let stdout = String::from_utf8_lossy(stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(stderr).trim().to_string();
    ErrorData::invalid_params(
        if stderr.is_empty() {
            format!("ct sym failed with status {:?}", code)
        } else {
            stderr.clone()
        },
        Some(json!({ "status": code, "stdout": stdout, "stderr": stderr })),
    )
}

fn push_flag(args: &mut Vec<String>, enabled: bool, flag: &str) {
    if enabled {
        args.push(flag.to_string());
    }
}

fn push_opt<T: ToString>(args: &mut Vec<String>, flag: &str, value: Option<T>) {
    if let Some(value) = value {
        args.push(flag.to_string());
        args.push(value.to_string());
    }
}

fn push_many(args: &mut Vec<String>, flag: &str, values: Option<Vec<String>>) {
    for value in values.unwrap_or_default() {
        args.push(flag.to_string());
        args.push(value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_many_repeats_flag_for_each_value() {
        let mut args = Vec::new();
        push_many(
            &mut args,
            "--path",
            Some(vec!["src/**".into(), "tests/**".into()]),
        );
        assert_eq!(args, vec!["--path", "src/**", "--path", "tests/**"]);
    }
}
