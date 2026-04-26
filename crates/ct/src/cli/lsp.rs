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
            let out = serde_json::json!({
                "operation": operation,
                "filePath": file_path,
                "line": line,
                "character": character,
                "query": query,
                "newName": new_name,
                "result": null,
                "resultCount": 0,
                "failureKind": "no_server",
                "note": "LSP client is not wired yet"
            });
            if json {
                println!("{}", serde_json::to_string_pretty(&out)?);
            } else {
                println!("no LSP server available (client not wired yet)");
            }
        }
        LspAction::Diagnostics { file_path, json } => {
            let out = serde_json::json!({
                "filePath": file_path,
                "diagnostics": [],
                "resultCount": 0,
                "failureKind": "no_server",
                "note": "LSP diagnostics are not wired yet"
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
