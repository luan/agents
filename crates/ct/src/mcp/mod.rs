use rmcp::ServiceExt;
use rmcp::model::ErrorData;
use rmcp::transport::stdio;
use serde_json::json;

use crate::artifact::{self, CtError, ResolveError};

mod apply_patch;
mod ast;
mod lsp;
mod vault;

// ---------------------------------------------------------------------------
// Shared error mapping + resolution helpers used by every sub-server.
// ---------------------------------------------------------------------------

/// Map a `CtError` to an MCP `ErrorData`.
pub(crate) fn ct_error_to_tool(err: CtError) -> ErrorData {
    match err {
        CtError::Resolve(ResolveError::NotFound(s)) => {
            ErrorData::invalid_params(format!("artifact not found: {s}"), None)
        }
        CtError::Resolve(ResolveError::Ambiguous(paths)) => {
            let candidates: Vec<String> = paths.iter().map(|p| p.display().to_string()).collect();
            ErrorData::invalid_params(
                format!("ambiguous stem, matches: {}", candidates.join(", ")),
                Some(json!({ "candidates": candidates })),
            )
        }
        CtError::Validation(msg) => ErrorData::invalid_params(msg, None),
        CtError::Sync(e) => ErrorData::internal_error(e.to_string(), None),
        CtError::Io(e) => ErrorData::internal_error(e.to_string(), None),
    }
}

/// Wrap a serializable value as a successful tool result.
pub(crate) fn json_success<T: serde::Serialize>(
    value: &T,
) -> Result<rmcp::model::CallToolResult, ErrorData> {
    let v = serde_json::to_value(value)
        .map_err(|e| ErrorData::internal_error(format!("serialize: {e}"), None))?;
    Ok(rmcp::model::CallToolResult::structured(v))
}

pub(crate) fn project_input_to_name(input: Option<String>) -> Result<String, ErrorData> {
    match input {
        Some(s) if !s.contains('/') && !s.contains('\\') => {
            artifact::validate_project_name(&s).map_err(ct_error_to_tool)?;
            Ok(s)
        }
        Some(path) => Ok(artifact::project_name(&artifact::resolve_repo_root(&path))),
        None => Ok(artifact::project_name(&artifact::current_project())),
    }
}

// ---------------------------------------------------------------------------
// Server entrypoints
// ---------------------------------------------------------------------------

/// Run the apply_patch MCP server over stdio.
pub fn run_apply_patch_server() -> Result<(), Box<dyn std::error::Error>> {
    serve_stdio(apply_patch::ApplyPatchMcpServer::new())
}

pub fn run_ast_server() -> Result<(), Box<dyn std::error::Error>> {
    serve_stdio(ast::AstMcpServer::new())
}

pub fn run_lsp_server() -> Result<(), Box<dyn std::error::Error>> {
    serve_stdio(lsp::LspMcpServer::new())
}

pub fn run_vault_server() -> Result<(), Box<dyn std::error::Error>> {
    serve_stdio(vault::VaultMcpServer::new())
}

/// Drive a server struct through rmcp's stdio transport until shutdown.
fn serve_stdio<S>(server: S) -> Result<(), Box<dyn std::error::Error>>
where
    S: rmcp::ServerHandler + Clone + Send + Sync + 'static,
{
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    runtime.block_on(async {
        let service = server.serve(stdio()).await?;
        service.waiting().await?;
        Ok::<(), Box<dyn std::error::Error>>(())
    })
}
