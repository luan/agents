pub mod ansi;
pub mod artifact;
pub mod cli;
pub mod context;
pub mod graph;
mod lock;
pub mod mcp;
pub mod slug;
pub mod vault;

use rmcp::model::ErrorData;

pub(crate) fn ct_error_to_tool(err: artifact::CtError) -> ErrorData {
    match err {
        artifact::CtError::Resolve(artifact::ResolveError::NotFound(s)) => {
            ErrorData::invalid_params(format!("artifact not found: {s}"), None)
        }
        artifact::CtError::Resolve(artifact::ResolveError::Ambiguous(paths)) => {
            let candidates: Vec<String> = paths.iter().map(|p| p.display().to_string()).collect();
            ErrorData::invalid_params(
                format!("ambiguous stem, matches: {}", candidates.join(", ")),
                Some(serde_json::json!({ "candidates": candidates })),
            )
        }
        artifact::CtError::Validation(msg) => ErrorData::invalid_params(msg, None),
        artifact::CtError::Sync(e) => ErrorData::internal_error(e.to_string(), None),
        artifact::CtError::Io(e) => ErrorData::internal_error(e.to_string(), None),
    }
}

pub(crate) fn json_success<T: serde::Serialize>(
    value: &T,
) -> Result<rmcp::model::CallToolResult, ErrorData> {
    let v = serde_json::to_value(value)
        .map_err(|e| ErrorData::internal_error(format!("serialize: {e}"), None))?;
    Ok(rmcp::model::CallToolResult::structured(v))
}
