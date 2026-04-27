use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ErrorData};
use rmcp::schemars::{self, JsonSchema};
use rmcp::{ServerHandler, tool, tool_handler, tool_router};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

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

#[derive(Debug, Deserialize, JsonSchema)]
struct DiagnosticsIn {
    file_path: String,
}

#[derive(Clone)]
pub(super) struct LspMcpServer {
    tool_router: ToolRouter<Self>,
    pool: Arc<Mutex<crate::lsp::session::LspSessionPool>>,
}

impl LspMcpServer {
    pub(super) fn new() -> Self {
        Self {
            tool_router: Self::tool_router(),
            pool: Arc::new(Mutex::new(crate::lsp::session::LspSessionPool::new())),
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
        let root = std::env::current_dir()
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        let pooled = self
            .pool
            .lock()
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?
            .with_session(&probe, &path, &root, |client| {
                client.run_text_operation(
                    &input.operation,
                    &path,
                    input.line,
                    input.character,
                    input.query.as_deref(),
                    input.new_name.as_deref(),
                )
            });
        let output = match pooled {
            Ok(output) => output,
            Err(_) => run_one_shot_request(&probe, &path, &input)
                .map_err(|error| ErrorData::invalid_params(error.to_string(), None))?,
        };
        json_success(&request_success_json(&input, &path, &probe, output))
    }

    #[tool(
        name = "diagnostics",
        description = "Collect LSP diagnostics and store them in ct lens."
    )]
    async fn diagnostics(
        &self,
        Parameters(input): Parameters<DiagnosticsIn>,
    ) -> Result<CallToolResult, ErrorData> {
        let path = std::path::PathBuf::from(&input.file_path);
        let path = if path.is_absolute() {
            path
        } else {
            std::env::current_dir()
                .map_err(|error| ErrorData::internal_error(error.to_string(), None))?
                .join(path)
        };
        let Some(probe) = crate::lsp::registry::probe_for_file(&path) else {
            return json_success(&json!({
                "filePath": path,
                "server": null,
                "diagnostics": [],
                "resultCount": 0,
                "failureKind": "no_server_definition"
            }));
        };
        if !probe.available {
            return json_success(&json!({
                "filePath": path,
                "server": probe,
                "diagnostics": [],
                "resultCount": 0,
                "failureKind": "server_unavailable"
            }));
        }
        let root = std::env::current_dir()
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        let pooled = self
            .pool
            .lock()
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?
            .with_session(&probe, &path, &root, |client| {
                client.collect_diagnostics(&path)
            });
        let diagnostics = match pooled {
            Ok(diagnostics) => diagnostics,
            Err(_) => run_one_shot_diagnostics(&probe, &path)
                .map_err(|error| ErrorData::internal_error(error.to_string(), None))?,
        };
        let lens_diagnostics = lsp_diagnostics_for_store(&path, &diagnostics)?;
        let mut store = crate::lens::LensStore::open_for_project(&root)
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        store
            .record_diagnostic_snapshot(crate::lens::DiagnosticSnapshotInput {
                source: crate::lens::DiagnosticSource::Lsp,
                scope: crate::lens::DiagnosticScope::file(
                    lens_diagnostics
                        .first()
                        .and_then(|diagnostic| diagnostic.rel_path.clone())
                        .unwrap_or_else(|| path.display().to_string()),
                ),
                diagnostics: lens_diagnostics.clone(),
                raw_output: Some(
                    serde_json::to_string(&diagnostics)
                        .map_err(|error| ErrorData::internal_error(error.to_string(), None))?,
                ),
                metadata: crate::lens::DiagnosticSnapshotMetadata::default(),
            })
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        json_success(&json!({
            "filePath": path,
            "server": probe,
            "diagnostics": diagnostics,
            "resultCount": diagnostics.len(),
            "recordedDiagnostics": lens_diagnostics.len(),
            "failureKind": null
        }))
    }
}

fn run_one_shot_request(
    probe: &crate::lsp::registry::LspServerProbe,
    path: &std::path::Path,
    input: &RequestIn,
) -> anyhow::Result<crate::lsp::client::LspOperationResult> {
    let mut client = crate::lsp::client::LspClient::start(probe)?;
    client.initialize(probe)?;
    client.open_file(probe, path)?;
    client.run_text_operation(
        &input.operation,
        path,
        input.line,
        input.character,
        input.query.as_deref(),
        input.new_name.as_deref(),
    )
}

fn run_one_shot_diagnostics(
    probe: &crate::lsp::registry::LspServerProbe,
    path: &std::path::Path,
) -> anyhow::Result<Vec<serde_json::Value>> {
    let mut client = crate::lsp::client::LspClient::start(probe)?;
    client.initialize(probe)?;
    client.open_file(probe, path)?;
    client.collect_diagnostics(path)
}

fn request_success_json(
    input: &RequestIn,
    path: &std::path::Path,
    probe: &crate::lsp::registry::LspServerProbe,
    output: crate::lsp::client::LspOperationResult,
) -> Value {
    json!({
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
    })
}

fn lsp_diagnostics_for_store(
    path: &std::path::Path,
    diagnostics: &[serde_json::Value],
) -> Result<Vec<crate::lens::Diagnostic>, ErrorData> {
    let cwd = std::env::current_dir()
        .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
    let rel_path = path
        .strip_prefix(&cwd)
        .unwrap_or(path)
        .to_string_lossy()
        .to_string();
    Ok(diagnostics
        .iter()
        .map(|diagnostic| {
            let range = diagnostic.get("range");
            let start_line = range
                .and_then(|range| range.get("start"))
                .and_then(|start| start.get("line"))
                .and_then(serde_json::Value::as_i64)
                .map(|line| line + 1);
            let end_line = range
                .and_then(|range| range.get("end"))
                .and_then(|end| end.get("line"))
                .and_then(serde_json::Value::as_i64)
                .map(|line| line + 1);
            let message = diagnostic
                .get("message")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("LSP diagnostic")
                .to_string();
            let code = diagnostic.get("code").map(|code| match code {
                serde_json::Value::String(value) => value.clone(),
                other => other.to_string(),
            });
            let severity = match diagnostic
                .get("severity")
                .and_then(serde_json::Value::as_i64)
                .unwrap_or(2)
            {
                1 => crate::lens::DiagnosticSeverity::Error,
                3 => crate::lens::DiagnosticSeverity::Info,
                4 => crate::lens::DiagnosticSeverity::Hint,
                _ => crate::lens::DiagnosticSeverity::Warning,
            };
            let fingerprint = crate::apply_patch::sha1_hex(
                format!("{rel_path}:{start_line:?}:{end_line:?}:{code:?}:{message}").as_bytes(),
            );
            crate::lens::Diagnostic {
                source: crate::lens::DiagnosticSource::Lsp,
                scope: crate::lens::DiagnosticScope::file(rel_path.clone()),
                severity,
                code,
                message,
                rel_path: Some(rel_path.clone()),
                start_line,
                end_line,
                fingerprint,
                content_hash: None,
                raw_output_id: None,
                snapshot_id: None,
                first_seen_at: None,
                last_seen_at: None,
                resolved_at: None,
            }
        })
        .collect())
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
