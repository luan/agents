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
        } => {
            let probe = file_path
                .as_deref()
                .map(std::path::Path::new)
                .and_then(crate::lsp::registry::probe_for_file);
            let failure_kind = match &probe {
                Some(probe) if probe.available => "client_not_implemented",
                Some(_) => "server_unavailable",
                None => "no_server_definition",
            };
            let out = serde_json::json!({
                "operation": operation,
                "filePath": file_path,
                "line": line,
                "character": character,
                "query": query,
                "newName": new_name,
                "server": probe,
                "result": null,
                "resultCount": 0,
                "failureKind": failure_kind,
                "note": "LSP registry detection is wired; JSON-RPC client is not wired yet"
            });
            if json {
                println!("{}", serde_json::to_string_pretty(&out)?);
            } else {
                println!("no LSP server available (client not wired yet)");
            }
        }
        LspAction::Diagnostics { file_path, json } => {
            let probe = file_path
                .as_deref()
                .map(std::path::Path::new)
                .and_then(crate::lsp::registry::probe_for_file);
            let out = serde_json::json!({
                "filePath": file_path,
                "server": probe,
                "diagnostics": [],
                "resultCount": 0,
                "failureKind": "client_not_implemented",
                "note": "LSP registry detection is wired; diagnostics collection is not wired yet"
            });
            if json {
                println!("{}", serde_json::to_string_pretty(&out)?);
            } else {
                println!("no LSP diagnostics available");
            }
        }
    }
    Ok(())
}
