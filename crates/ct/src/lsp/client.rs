use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use serde_json::{Value, json};

use crate::lsp::registry::LspServerProbe;

const RESPONSE_WAIT: Duration = Duration::from_secs(8);
const DIAGNOSTICS_WAIT: Duration = Duration::from_secs(3);

#[derive(Debug, serde::Serialize)]
pub struct LspOperationResult {
    pub result: Value,
    pub result_count: usize,
}

pub struct LspClient {
    child: Child,
    stdin: ChildStdin,
    rx: mpsc::Receiver<Result<Value, String>>,
    next_id: i64,
}

impl LspClient {
    pub fn start(probe: &LspServerProbe) -> Result<Self> {
        let command = probe
            .command
            .as_ref()
            .ok_or_else(|| anyhow!("LSP command is unavailable"))?;
        let root = probe.root.as_deref().unwrap_or_else(|| Path::new("."));
        let mut child = Command::new(command)
            .args(probe.server.args)
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .with_context(|| format!("spawn {}", command.display()))?;
        let stdin = child.stdin.take().context("LSP stdin unavailable")?;
        let stdout = child.stdout.take().context("LSP stdout unavailable")?;
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut reader = std::io::BufReader::new(stdout);
            loop {
                match read_message(&mut reader) {
                    Ok(Some(message)) => {
                        if tx.send(Ok(message)).is_err() {
                            return;
                        }
                    }
                    Ok(None) => return,
                    Err(error) => {
                        let _ = tx.send(Err(error.to_string()));
                        return;
                    }
                }
            }
        });
        Ok(Self {
            child,
            stdin,
            rx,
            next_id: 1,
        })
    }

    pub fn initialize(&mut self, probe: &LspServerProbe) -> Result<()> {
        let root = probe.root.as_deref().unwrap_or_else(|| Path::new("."));
        let result = self.request(
            "initialize",
            json!({
                "processId": std::process::id(),
                "rootUri": file_uri(root)?,
                "capabilities": {
                    "textDocument": {
                        "hover": { "contentFormat": ["markdown", "plaintext"] },
                        "definition": { "linkSupport": true },
                        "implementation": { "linkSupport": true },
                        "references": {},
                        "documentSymbol": { "hierarchicalDocumentSymbolSupport": true },
                        "rename": { "prepareSupport": false },
                        "callHierarchy": { "dynamicRegistration": false },
                        "publishDiagnostics": { "relatedInformation": true }
                    },
                    "workspace": { "symbol": {} }
                },
                "clientInfo": { "name": "ct", "version": env!("CARGO_PKG_VERSION") }
            }),
            RESPONSE_WAIT,
        )?;
        if result.get("capabilities").is_none() {
            bail!("LSP initialize returned an invalid response");
        }
        self.notify("initialized", json!({}))?;
        Ok(())
    }

    pub fn open_file(&mut self, probe: &LspServerProbe, path: &Path) -> Result<()> {
        let text =
            std::fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
        self.notify(
            "textDocument/didOpen",
            json!({
                "textDocument": {
                    "uri": file_uri(path)?,
                    "languageId": probe.server.language_id,
                    "version": 1,
                    "text": text
                }
            }),
        )
    }

    pub fn run_text_operation(
        &mut self,
        operation: &str,
        path: &Path,
        line: Option<usize>,
        character: Option<usize>,
        query: Option<&str>,
        new_name: Option<&str>,
    ) -> Result<LspOperationResult> {
        let result = match operation {
            "hover" => self.request(
                "textDocument/hover",
                text_position_params(path, line, character)?,
                RESPONSE_WAIT,
            )?,
            "definition" => self.request(
                "textDocument/definition",
                text_position_params(path, line, character)?,
                RESPONSE_WAIT,
            )?,
            "implementation" => self.request(
                "textDocument/implementation",
                text_position_params(path, line, character)?,
                RESPONSE_WAIT,
            )?,
            "references" => {
                let mut params = text_position_params(path, line, character)?;
                params["context"] = json!({ "includeDeclaration": true });
                self.request("textDocument/references", params, RESPONSE_WAIT)?
            }
            "signatureHelp" | "signature_help" => self.request(
                "textDocument/signatureHelp",
                text_position_params(path, line, character)?,
                RESPONSE_WAIT,
            )?,
            "documentSymbol" | "document_symbol" => self.request(
                "textDocument/documentSymbol",
                json!({ "textDocument": { "uri": file_uri(path)? } }),
                RESPONSE_WAIT,
            )?,
            "workspaceSymbol" | "workspace_symbol" => self.request(
                "workspace/symbol",
                json!({ "query": query.unwrap_or_default() }),
                RESPONSE_WAIT,
            )?,
            "rename" => {
                let mut params = text_position_params(path, line, character)?;
                params["newName"] =
                    json!(new_name.ok_or_else(|| anyhow!("rename requires --new-name"))?);
                self.request("textDocument/rename", params, RESPONSE_WAIT)?
            }
            "prepareCallHierarchy" | "prepare_call_hierarchy" => self.request(
                "textDocument/prepareCallHierarchy",
                text_position_params(path, line, character)?,
                RESPONSE_WAIT,
            )?,
            "incomingCalls" | "incoming_calls" => {
                self.call_hierarchy(path, line, character, true)?
            }
            "outgoingCalls" | "outgoing_calls" => {
                self.call_hierarchy(path, line, character, false)?
            }
            other => bail!("unsupported LSP operation: {other}"),
        };
        Ok(LspOperationResult {
            result_count: result_count(&result),
            result,
        })
    }

    pub fn collect_diagnostics(&mut self, path: &Path) -> Result<Vec<Value>> {
        let uri = file_uri(path)?;
        let mut diagnostics = Vec::new();
        while let Ok(message) = self.rx.recv_timeout(DIAGNOSTICS_WAIT) {
            let message = message.map_err(|error| anyhow!(error))?;
            if message.get("method").and_then(Value::as_str)
                != Some("textDocument/publishDiagnostics")
            {
                continue;
            }
            let Some(params) = message.get("params") else {
                continue;
            };
            if params.get("uri").and_then(Value::as_str) != Some(uri.as_str()) {
                continue;
            }
            diagnostics = params
                .get("diagnostics")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            break;
        }
        Ok(diagnostics)
    }

    fn call_hierarchy(
        &mut self,
        path: &Path,
        line: Option<usize>,
        character: Option<usize>,
        incoming: bool,
    ) -> Result<Value> {
        let prepared = self.request(
            "textDocument/prepareCallHierarchy",
            text_position_params(path, line, character)?,
            RESPONSE_WAIT,
        )?;
        let Some(item) = prepared.as_array().and_then(|items| items.first()).cloned() else {
            return Ok(json!([]));
        };
        let method = if incoming {
            "callHierarchy/incomingCalls"
        } else {
            "callHierarchy/outgoingCalls"
        };
        self.request(method, json!({ "item": item }), RESPONSE_WAIT)
    }

    fn request(&mut self, method: &str, params: Value, wait: Duration) -> Result<Value> {
        let id = self.next_id;
        self.next_id += 1;
        self.write(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))?;
        loop {
            let message = self
                .rx
                .recv_timeout(wait)
                .with_context(|| format!("timed out waiting for {method}"))?
                .map_err(|error| anyhow!(error))?;
            if message.get("id").and_then(Value::as_i64) != Some(id) {
                continue;
            }
            if let Some(error) = message.get("error") {
                bail!("LSP {method} failed: {error}");
            }
            return Ok(message.get("result").cloned().unwrap_or(Value::Null));
        }
    }

    fn notify(&mut self, method: &str, params: Value) -> Result<()> {
        self.write(json!({ "jsonrpc": "2.0", "method": method, "params": params }))
    }

    fn write(&mut self, value: Value) -> Result<()> {
        let body = serde_json::to_vec(&value)?;
        write!(self.stdin, "Content-Length: {}\r\n\r\n", body.len())?;
        self.stdin.write_all(&body)?;
        self.stdin.flush()?;
        Ok(())
    }
}

impl Drop for LspClient {
    fn drop(&mut self) {
        let _ = self.notify("exit", Value::Null);
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn read_message(reader: &mut impl BufRead) -> Result<Option<Value>> {
    let mut content_length = None;
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line)?;
        if n == 0 {
            return Ok(None);
        }
        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            break;
        }
        if let Some(value) = line.strip_prefix("Content-Length:") {
            content_length = Some(value.trim().parse::<usize>()?);
        }
    }
    let length = content_length.context("LSP message missing Content-Length")?;
    let mut body = vec![0; length];
    reader.read_exact(&mut body)?;
    Ok(Some(serde_json::from_slice(&body)?))
}

fn text_position_params(
    path: &Path,
    line: Option<usize>,
    character: Option<usize>,
) -> Result<Value> {
    Ok(json!({
        "textDocument": { "uri": file_uri(path)? },
        "position": {
            "line": line.ok_or_else(|| anyhow!("operation requires --line"))?.saturating_sub(1),
            "character": character.ok_or_else(|| anyhow!("operation requires --character"))?.saturating_sub(1)
        }
    }))
}

fn result_count(value: &Value) -> usize {
    match value {
        Value::Array(items) => items.len(),
        Value::Null => 0,
        _ => 1,
    }
}

pub fn file_uri(path: &Path) -> Result<String> {
    let path = canonical_or_absolute(path)?;
    let mut uri = String::from("file://");
    for byte in path.to_string_lossy().as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'/' | b'-' | b'_' | b'.' | b'~' => {
                uri.push(*byte as char);
            }
            other => uri.push_str(&format!("%{other:02X}")),
        }
    }
    Ok(uri)
}

fn canonical_or_absolute(path: &Path) -> Result<PathBuf> {
    if let Ok(canonical) = path.canonicalize() {
        return Ok(canonical);
    }
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        Ok(std::env::current_dir()?.join(path))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_uri_escapes_spaces() {
        let uri = file_uri(Path::new("a b.rs")).unwrap();
        assert!(uri.ends_with("a%20b.rs"));
    }

    #[test]
    fn counts_lsp_result_shapes() {
        assert_eq!(result_count(&Value::Null), 0);
        assert_eq!(result_count(&json!([1, 2])), 2);
        assert_eq!(result_count(&json!({ "x": 1 })), 1);
    }
}
