use crate::kernel::Kernel;
use anyhow::{Result, ensure};
use fs2::FileExt;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    fs::{File, OpenOptions},
    path::{Path, PathBuf},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const MAX_FRAME: usize = 16 * 1024 * 1024;
#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    Execute { code: String },
    Checkpoint,
    Restart,
    Reset,
    Status,
    SaveProfile { name: String },
    LoadProfile { name: String },
}
struct Notebook {
    deno: PathBuf,
    cwd: PathBuf,
    directory: PathBuf,
    profiles: PathBuf,
    kernel: Option<Kernel>,
    _lock: File,
}
impl Notebook {
    async fn kernel(&mut self) -> Result<&mut Kernel> {
        if self.kernel.is_none() {
            let mut kernel = Kernel::start(&self.deno, &self.cwd).await?;
            let checkpoint = self.directory.join("checkpoint.json");
            if checkpoint.exists() {
                kernel.restore(&read_state(&checkpoint)?).await?;
            }
            self.kernel = Some(kernel);
        }
        self.kernel
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("Notebook did not start"))
    }
    async fn checkpoint(&mut self) -> Result<Value> {
        let state = self.kernel().await?.capture().await?;
        write_state(&self.directory.join("checkpoint.json"), &state)?;
        Ok(state)
    }
    async fn execute(&mut self, request: Request) -> Result<Value> {
        match request {
            Request::Execute { code } => {
                let output = self.kernel().await?.execute(&code).await?;
                // Preserve the last valid checkpoint if any binding or storage operation fails.
                let checkpoint = match self.checkpoint().await {
                    Ok(state) => json!({"saved":true,"skipped":state["skipped"]}),
                    Err(error) => json!({"saved":false,"error":error.to_string()}),
                };
                Ok(json!({"output":output, "checkpoint":checkpoint}))
            }
            Request::Checkpoint => {
                let state = self.checkpoint().await?;
                let bindings = state["values"]
                    .as_object()
                    .map(|values| values.keys().collect::<Vec<_>>())
                    .unwrap_or_default();
                Ok(
                    json!({"message":"Checkpoint saved", "bindings":bindings, "skipped":state["skipped"]}),
                )
            }
            Request::Restart => {
                self.checkpoint().await?;
                self.kernel = None;
                self.kernel().await?;
                Ok(json!({"message":"Restarted from saved bindings"}))
            }
            Request::Reset => {
                let path = self.directory.join("checkpoint.json");
                if path.exists() {
                    std::fs::remove_file(path)?;
                }
                self.kernel = None;
                Ok(json!({"message":"Notebook reset; stored profiles remain available"}))
            }
            Request::Status => {
                let names = self.kernel().await?.names().await?;
                Ok(json!({"bindings":names}))
            }
            Request::SaveProfile { name } => {
                let path = profile_path(&self.profiles, &name)?;
                let state = self.checkpoint().await?;
                write_state(&path, &state)?;
                Ok(json!({"message":format!("Saved profile {name}"),"skipped":state["skipped"]}))
            }
            Request::LoadProfile { name } => {
                let state = read_state(&profile_path(&self.profiles, &name)?)?;
                // Validate and restore into a replacement kernel before replacing live state.
                let mut replacement = Kernel::start(&self.deno, &self.cwd).await?;
                replacement.restore(&state).await?;
                write_state(&self.directory.join("checkpoint.json"), &state)?;
                self.kernel = Some(replacement);
                Ok(json!({"message":format!("Loaded profile {name}")}))
            }
        }
    }
}
fn profile_path(root: &Path, name: &str) -> Result<PathBuf> {
    ensure!(
        !name.is_empty()
            && name.len() <= 80
            && name
                .bytes()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == b'-' || ch == b'_'),
        "Profile names use letters, numbers, hyphens, or underscores"
    );
    Ok(root.join(format!("{name}.json")))
}
fn read_state(path: &Path) -> Result<Value> {
    let file = File::open(path)?;
    ensure!(
        file.metadata()?.len() <= MAX_FRAME as u64,
        "Notebook checkpoint exceeds 16 MiB"
    );
    Ok(serde_json::from_reader(file)?)
}
fn write_state(path: &Path, value: &Value) -> Result<()> {
    let bytes = serde_json::to_vec(value)?;
    ensure!(
        bytes.len() <= MAX_FRAME,
        "Notebook checkpoint exceeds 16 MiB"
    );
    let directory = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("Checkpoint has no parent"))?;
    std::fs::create_dir_all(directory)?;
    let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
    std::io::Write::write_all(&mut temporary, &bytes)?;
    temporary.as_file().sync_all()?;
    temporary.persist(path)?;
    Ok(())
}
pub async fn run() -> Result<()> {
    let mut args = std::env::args_os().skip(1);
    let cache = PathBuf::from(
        args.next()
            .ok_or_else(|| anyhow::anyhow!("Expected Deno cache directory"))?,
    );
    let deno = crate::install::ensure(&cache).await?;
    let cwd = PathBuf::from(
        args.next()
            .ok_or_else(|| anyhow::anyhow!("Expected working directory"))?,
    );
    let directory = PathBuf::from(
        args.next()
            .ok_or_else(|| anyhow::anyhow!("Expected session directory"))?,
    );
    let profiles = PathBuf::from(
        args.next()
            .ok_or_else(|| anyhow::anyhow!("Expected profile directory"))?,
    );
    ensure!(args.next().is_none(), "Unexpected notebook argument");
    std::fs::create_dir_all(&directory)?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(directory.join("runtime.lock"))?;
    lock.try_lock_exclusive()
        .map_err(|_| anyhow::anyhow!("This notebook session is already open in another process"))?;
    let mut notebook = Notebook {
        deno,
        cwd,
        directory,
        profiles,
        kernel: None,
        _lock: lock,
    };
    let (sender, mut receiver) = tokio::sync::mpsc::channel(1);
    tokio::spawn(async move {
        let mut input = tokio::io::stdin();
        loop {
            let length = match input.read_u32_le().await {
                Ok(length) => length as usize,
                Err(_) => return,
            };
            if length > MAX_FRAME {
                return;
            }
            let mut bytes = vec![0; length];
            if input.read_exact(&mut bytes).await.is_err() || sender.send(bytes).await.is_err() {
                return;
            }
        }
    });
    let mut output = tokio::io::stdout();
    while let Some(bytes) = receiver.recv().await {
        let response = match serde_json::from_slice::<Request>(&bytes) {
            Ok(request) => match tokio::select! {
                response = notebook.execute(request) => response,
                next = receiver.recv() => {
                    ensure!(next.is_none(), "Only one notebook operation may run at a time");
                    break;
                }
            } {
                Ok(result) => json!({"version":1,"ok":true,"result":result}),
                Err(error) => json!({"version":1,"ok":false,"error":error.to_string()}),
            },
            Err(error) => json!({"version":1,"ok":false,"error":error.to_string()}),
        };
        let bytes = serde_json::to_vec(&response)?;
        ensure!(bytes.len() <= MAX_FRAME, "Notebook response exceeds 16 MiB");
        output.write_u32_le(u32::try_from(bytes.len())?).await?;
        output.write_all(&bytes).await?;
        output.flush().await?;
    }
    Ok(())
}
