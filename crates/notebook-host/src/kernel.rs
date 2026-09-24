use crate::wire;
use anyhow::{Result, bail, ensure};
use serde_json::{Value, json};
use std::{collections::BTreeSet, path::Path, process::Stdio, time::Duration};
use tempfile::TempDir;
use tokio::{
    net::TcpListener,
    process::{Child, Command},
    time::timeout,
};
use uuid::Uuid;
use zeromq::{DealerSocket, Socket, SocketRecv, SocketSend, SubSocket};

pub struct Kernel {
    shell: DealerSocket,
    output: SubSocket,
    key: String,
    process: Child,
    _directory: TempDir,
    baseline: BTreeSet<String>,
}
impl Kernel {
    pub async fn start(deno: &Path, cwd: &Path) -> Result<Self> {
        let directory = tempfile::tempdir()?;
        let mut listeners = Vec::new();
        for _ in 0..5 {
            listeners.push(TcpListener::bind("127.0.0.1:0").await?);
        }
        let ports = listeners
            .iter()
            .map(|listener| listener.local_addr().map(|addr| addr.port()))
            .collect::<Result<Vec<_>, _>>()?;
        let key = Uuid::new_v4().to_string();
        let path = directory.path().join("connection.json");
        std::fs::write(
            &path,
            serde_json::to_vec(&json!({
                "ip":"127.0.0.1", "transport":"tcp", "shell_port":ports[0], "iopub_port":ports[1],
                "stdin_port":ports[2], "control_port":ports[3], "hb_port":ports[4],
                "signature_scheme":"hmac-sha256", "key":key, "kernel_name":"deno"
            }))?,
        )?;
        drop(listeners);
        let process = Command::new(deno)
            .args(["jupyter", "--kernel", "--conn"])
            .arg(&path)
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()?;
        let mut shell = DealerSocket::new();
        let mut output = SubSocket::new();
        timeout(Duration::from_secs(30), async {
            shell
                .connect(&format!("tcp://127.0.0.1:{}", ports[0]))
                .await?;
            output
                .connect(&format!("tcp://127.0.0.1:{}", ports[1]))
                .await?;
            output.subscribe("").await?;
            Ok::<_, anyhow::Error>(())
        })
        .await??;
        let mut kernel = Self {
            shell,
            output,
            key,
            process,
            _directory: directory,
            baseline: BTreeSet::new(),
        };
        kernel.request("kernel_info_request", json!({})).await?;
        kernel.execute("{ const parent = Deno.ppid; setInterval(() => { if (Deno.ppid !== parent) Deno.exit(70); }, 5000); }").await?;
        kernel.baseline = kernel.names().await?.into_iter().collect();
        Ok(kernel)
    }
    async fn request(&mut self, kind: &str, content: Value) -> Result<Value> {
        let (id, message) = wire::encode(kind, content, &self.key)?;
        self.shell.send(message).await?;
        timeout(Duration::from_secs(30), async {
            loop {
                let reply = wire::decode(self.shell.recv().await?, &self.key)?;
                if reply["parent_header"]["msg_id"] == id {
                    return Ok(reply["content"].clone());
                }
            }
        })
        .await?
    }
    pub async fn names(&mut self) -> Result<Vec<String>> {
        let reply = self
            .request("complete_request", json!({"code":"", "cursor_pos":0}))
            .await?;
        Ok(reply["matches"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|name| valid_name(name) && !self.baseline.contains(*name))
            .map(str::to_owned)
            .collect())
    }
    pub async fn execute(&mut self, code: &str) -> Result<Vec<Value>> {
        let (id, message) = wire::encode(
            "execute_request",
            json!({"code":code,"silent":false,"store_history":true,"user_expressions":{},"allow_stdin":false,"stop_on_error":true}),
            &self.key,
        )?;
        self.shell.send(message).await?;
        let mut result = Vec::new();
        let mut bytes: usize = 0;
        let mut idle = false;
        let mut replied = false;
        while !idle || !replied {
            tokio::select! {
                status = self.process.wait() => { bail!("Deno kernel exited: {}", status?); }
                response = self.shell.recv(), if !replied => {
                    let response = wire::decode(response?, &self.key)?;
                    if response["parent_header"]["msg_id"] != id { continue; }
                    replied = true;
                    if response["content"]["status"] == "error" {
                        result.push(json!({"type":"error", "text": response["content"]["evalue"].as_str().unwrap_or("Notebook execution failed")}));
                    }
                }
                response = self.output.recv() => {
                    let response = wire::decode(response?, &self.key)?;
                    if response["parent_header"]["msg_id"] != id { continue; }
                    let content = &response["content"];
                    let item = match response["header"]["msg_type"].as_str() {
                        Some("status") => { idle = content["execution_state"] == "idle"; None }
                        Some("stream") => Some(json!({"type":"text", "text":content["text"].as_str().unwrap_or("")})),
                        Some("execute_result" | "display_data") => {
                            let data = &content["data"];
                            if let Some(image) = data["image/png"].as_str() { Some(json!({"type":"image", "mimeType":"image/png", "data":image})) }
                            else { data["text/plain"].as_str().filter(|text| *text != "undefined").map(|text| json!({"type":"text", "text":text})) }
                        }
                        _ => None,
                    };
                    if let Some(item) = item {
                        let size = serde_json::to_vec(&item)?.len();
                        if bytes.saturating_add(size) <= 8 * 1024 * 1024 && result.len() < 1000 { bytes += size; result.push(item); }
                        else if bytes != usize::MAX { result.push(json!({"type":"text","text":"[Notebook output truncated at 8 MiB or 1000 items]"})); bytes = usize::MAX; }
                    }
                }
            }
        }
        Ok(result)
    }
    pub async fn capture(&mut self) -> Result<Value> {
        let names = self.names().await?;
        let mut temporary = "__pi_checkpoint".to_owned();
        while names.contains(&temporary) {
            temporary.push('_');
        }
        let mut captures = String::new();
        for name in &names {
            use std::fmt::Write;
            let quoted = serde_json::to_string(name)?;
            write!(
                captures,
                "try {{ {temporary}.values[{quoted}] = {temporary}.Buffer.from({temporary}.serialize({name})).toString('base64'); }} catch (error) {{ {temporary}.skipped.push({{name:{quoted}, reason:String(error)}}); }}"
            )?;
        }
        let code = format!(
            "{{ const {temporary} = {{serialize:(await import('node:v8')).serialize, Buffer:(await import('node:buffer')).Buffer, values:{{}}, skipped:[]}}; {captures} console.log(JSON.stringify({{version:1, deno:Deno.version.deno, values:{temporary}.values, skipped:{temporary}.skipped}})); }}"
        );
        let output = self.execute(&code).await?;
        let text = output
            .iter()
            .filter_map(|item| item["text"].as_str())
            .collect::<String>();
        let value: Value = serde_json::from_str(text.trim())?;
        ensure!(
            value["version"] == 1 && value["values"].is_object(),
            "Invalid notebook checkpoint"
        );
        Ok(value)
    }
    pub async fn restore(&mut self, state: &Value) -> Result<()> {
        ensure!(
            state["version"] == 1,
            "Unsupported notebook checkpoint version"
        );
        let values = state["values"]
            .as_object()
            .ok_or_else(|| anyhow::anyhow!("Invalid notebook values"))?;
        for (name, encoded) in values {
            ensure!(
                valid_name(name) && !self.baseline.contains(name),
                "Invalid saved binding name"
            );
            let data = encoded
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("Invalid saved binding"))?;
            let source = format!(
                "var {name} = (await import('node:v8')).deserialize((await import('node:buffer')).Buffer.from({},'base64'));",
                serde_json::to_string(data)?
            );
            let output = self.execute(&source).await?;
            if output.iter().any(|item| item["type"] == "error") {
                bail!("Could not restore binding {name}");
            }
        }
        Ok(())
    }
}
fn valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|ch| ch.is_ascii_alphabetic() || ch == '_' || ch == '$')
        && chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '$')
}
