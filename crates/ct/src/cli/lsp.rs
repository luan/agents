use std::path::{Path, PathBuf};

use crate::cli::args::LspAction;

pub fn run_lsp(action: LspAction) -> Result<(), Box<dyn std::error::Error>> {
    match action {
        LspAction::Request {
            operation,
            file_path,
            line,
            character,
            json,
            query,
            new_name,
        } => request(operation, file_path, line, character, query, new_name, json),
        LspAction::Diagnostics { file_path, json } => diagnostics(file_path, json),
    }
}

fn request(
    operation: String,
    file_path: Option<String>,
    line: Option<usize>,
    character: Option<usize>,
    query: Option<String>,
    new_name: Option<String>,
    json: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let path = file_path.as_deref().map(resolve_path).transpose()?;
    let probe_path = path.as_deref().unwrap_or_else(|| Path::new("."));
    let probe = crate::lsp::registry::probe_for_file(probe_path);
    let Some(probe) = probe else {
        return print_failure(
            json,
            serde_json::json!({
                "operation": operation,
                "filePath": file_path,
                "line": line,
                "character": character,
                "query": query,
                "newName": new_name,
                "server": null,
                "result": null,
                "resultCount": 0,
                "failureKind": "no_server_definition"
            }),
            "no LSP server definition for file",
        );
    };
    if !probe.available {
        return print_failure(
            json,
            serde_json::json!({
                "operation": operation,
                "filePath": file_path,
                "line": line,
                "character": character,
                "query": query,
                "newName": new_name,
                "server": probe,
                "result": null,
                "resultCount": 0,
                "failureKind": "server_unavailable"
            }),
            "LSP server command is unavailable",
        );
    }
    let Some(path) = path else {
        return print_failure(
            json,
            serde_json::json!({
                "operation": operation,
                "filePath": file_path,
                "server": probe,
                "result": null,
                "resultCount": 0,
                "failureKind": "file_required"
            }),
            "operation requires --file-path",
        );
    };

    let output = run_lsp_request(&probe, &operation, &path, line, character, query, new_name);
    match output {
        Ok(output) => {
            let out = serde_json::json!({
                "operation": operation,
                "filePath": path,
                "line": line,
                "character": character,
                "server": probe,
                "result": output.result,
                "resultCount": output.result_count,
                "failureKind": null
            });
            print_json_or_text(json, &out)
        }
        Err(error) => print_failure(
            json,
            serde_json::json!({
                "operation": operation,
                "filePath": path,
                "line": line,
                "character": character,
                "server": probe,
                "result": null,
                "resultCount": 0,
                "failureKind": "request_failed",
                "error": error.to_string()
            }),
            &format!("LSP request failed: {error}"),
        ),
    }
}

fn diagnostics(file_path: Option<String>, json: bool) -> Result<(), Box<dyn std::error::Error>> {
    let Some(file_path) = file_path else {
        return print_failure(
            json,
            serde_json::json!({
                "filePath": null,
                "server": null,
                "diagnostics": [],
                "resultCount": 0,
                "failureKind": "file_required"
            }),
            "diagnostics requires --file-path",
        );
    };
    let path = resolve_path(&file_path)?;
    let probe = crate::lsp::registry::probe_for_file(&path);
    let Some(probe) = probe else {
        return print_failure(
            json,
            serde_json::json!({
                "filePath": path,
                "server": null,
                "diagnostics": [],
                "resultCount": 0,
                "failureKind": "no_server_definition"
            }),
            "no LSP server definition for file",
        );
    };
    if !probe.available {
        return print_failure(
            json,
            serde_json::json!({
                "filePath": path,
                "server": probe,
                "diagnostics": [],
                "resultCount": 0,
                "failureKind": "server_unavailable"
            }),
            "LSP server command is unavailable",
        );
    }
    let output = run_lsp_diagnostics(&probe, &path);
    match output {
        Ok(diagnostics) => {
            let lens_diagnostics = lsp_diagnostics_for_store(&path, &diagnostics)?;
            let root = std::env::current_dir()?;
            let mut store = crate::lens::LensStore::open_for_project(&root)?;
            store.record_diagnostic_snapshot(crate::lens::DiagnosticSnapshotInput {
                source: crate::lens::DiagnosticSource::Lsp,
                scope: crate::lens::DiagnosticScope::file(
                    lens_diagnostics
                        .first()
                        .and_then(|diagnostic| diagnostic.rel_path.clone())
                        .unwrap_or_else(|| path.display().to_string()),
                ),
                diagnostics: lens_diagnostics.clone(),
                raw_output: Some(serde_json::to_string(&diagnostics)?),
                raw_output_max_bytes: None,
                metadata: crate::lens::DiagnosticSnapshotMetadata::default(),
            })?;
            let out = serde_json::json!({
                "filePath": path,
                "server": probe,
                "diagnostics": diagnostics,
                "resultCount": diagnostics.len(),
                "recordedDiagnostics": lens_diagnostics.len(),
                "failureKind": null
            });
            print_json_or_text(json, &out)
        }
        Err(error) => print_failure(
            json,
            serde_json::json!({
                "filePath": path,
                "server": probe,
                "diagnostics": [],
                "resultCount": 0,
                "failureKind": "request_failed",
                "error": error.to_string()
            }),
            &format!("LSP diagnostics failed: {error}"),
        ),
    }
}

fn run_lsp_request(
    probe: &crate::lsp::registry::LspServerProbe,
    operation: &str,
    path: &Path,
    line: Option<usize>,
    character: Option<usize>,
    query: Option<String>,
    new_name: Option<String>,
) -> anyhow::Result<crate::lsp::client::LspOperationResult> {
    let mut client = crate::lsp::client::LspClient::start(probe)?;
    client.initialize(probe)?;
    client.open_file(probe, path)?;
    client.run_text_operation(
        operation,
        path,
        line,
        character,
        query.as_deref(),
        new_name.as_deref(),
    )
}

fn run_lsp_diagnostics(
    probe: &crate::lsp::registry::LspServerProbe,
    path: &Path,
) -> anyhow::Result<Vec<serde_json::Value>> {
    let mut client = crate::lsp::client::LspClient::start(probe)?;
    client.initialize(probe)?;
    client.open_file(probe, path)?;
    client.collect_diagnostics(path)
}

fn resolve_path(path: &str) -> std::io::Result<PathBuf> {
    let path = PathBuf::from(path);
    if path.is_absolute() {
        Ok(path)
    } else {
        Ok(std::env::current_dir()?.join(path))
    }
}

fn print_failure(
    json: bool,
    value: serde_json::Value,
    text: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    if json {
        println!("{}", serde_json::to_string_pretty(&value)?);
    } else {
        println!("{text}");
    }
    Ok(())
}

fn print_json_or_text(
    json: bool,
    value: &serde_json::Value,
) -> Result<(), Box<dyn std::error::Error>> {
    let _ = json;
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

fn lsp_diagnostics_for_store(
    path: &Path,
    diagnostics: &[serde_json::Value],
) -> Result<Vec<crate::lens::Diagnostic>, Box<dyn std::error::Error>> {
    let cwd = std::env::current_dir()?;
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
