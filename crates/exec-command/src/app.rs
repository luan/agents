use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, Read, Write};
use std::os::fd::AsFd;
use std::path::PathBuf;
use std::process::{Child, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use pty_process::blocking::{open as open_pty, Command as PtyCommand};
use pty_process::Size as PtySize;
use serde::{Deserialize, Serialize};
use serde_json::json;

// Backpressure one slow reader without dropping its output. Raise this only when a measured
// consumer benefits from a larger per-process burst budget.
const RETAINED_OUTPUT_BYTES: usize = 8 * 1024 * 1024;
// Bounds native process and reader-thread ownership. Raise this only with a measured concurrent
// workload and an explicit file-descriptor/thread budget.
const MAX_ACTIVE_PROCESSES: usize = 64;

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum Request {
    Exec {
        request_id: u64,
        process_id: String,
        argv: Vec<String>,
        cwd: String,
        env: HashMap<String, String>,
        tty: bool,
        pipe_stdin: bool,
        arg0: Option<String>,
        rows: Option<u16>,
        cols: Option<u16>,
    },
    Read {
        request_id: u64,
        process_id: String,
        after_seq: Option<u64>,
        max_bytes: Option<usize>,
        wait_ms: Option<u64>,
    },
    Write {
        request_id: u64,
        process_id: String,
        chunk: String,
    },
    Interrupt {
        request_id: u64,
        process_id: String,
    },
    Terminate {
        request_id: u64,
        process_id: String,
    },
    Resize {
        request_id: u64,
        process_id: String,
        rows: u16,
        cols: u16,
    },
    Reap {
        request_id: u64,
        process_id: String,
    },
    Shutdown {
        request_id: u64,
    },
}

impl Request {
    fn request_id(&self) -> u64 {
        match self {
            Self::Exec { request_id, .. }
            | Self::Read { request_id, .. }
            | Self::Write { request_id, .. }
            | Self::Interrupt { request_id, .. }
            | Self::Terminate { request_id, .. }
            | Self::Resize { request_id, .. }
            | Self::Reap { request_id, .. }
            | Self::Shutdown { request_id } => *request_id,
        }
    }
}

#[derive(Debug, Serialize)]
struct Response {
    request_id: u64,
    ok: bool,
    result: Option<serde_json::Value>,
    error: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum OutputStream {
    Stdout,
    Stderr,
    Pty,
}

struct OutputChunk {
    seq: u64,
    stream: OutputStream,
    bytes: Vec<u8>,
}

#[derive(Default)]
struct ProcessState {
    chunks: VecDeque<OutputChunk>,
    retained_bytes: usize,
    next_seq: u64,
    exit_code: Option<i32>,
    open_streams: usize,
    closed: bool,
    accepting_output: bool,
}

struct ProcessKiller {
    child: Arc<Mutex<Child>>,
    process_group: rustix::process::Pid,
}

struct ProcessEntry {
    state: Arc<(Mutex<ProcessState>, Condvar)>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    killer: Mutex<ProcessKiller>,
    tty: bool,
    control_pty: pty_process::blocking::Pty,
}

#[derive(Default)]
pub struct Server {
    processes: HashMap<String, Arc<ProcessEntry>>,
}

impl Server {
    pub fn exec(&mut self, params: &ExecParams) -> Result<serde_json::Value> {
        if params.argv.is_empty() {
            anyhow::bail!("argv must not be empty");
        }
        if self.processes.contains_key(&params.process_id) {
            anyhow::bail!("process {} already exists", params.process_id);
        }
        if self.processes.len() >= MAX_ACTIVE_PROCESSES {
            anyhow::bail!("exec_command supports at most {MAX_ACTIVE_PROCESSES} active processes");
        }
        let entry = if params.tty {
            spawn_pty(params)?
        } else {
            spawn_pipe(params)?
        };
        self.processes.insert(params.process_id.clone(), entry);
        Ok(json!({ "processId": params.process_id }))
    }

    pub fn read(
        &self,
        process_id: &str,
        after_seq: Option<u64>,
        max_bytes: Option<usize>,
        wait_ms: Option<u64>,
    ) -> Result<serde_json::Value> {
        let entry = self.processes.get(process_id).cloned();
        Self::read_entry(entry, process_id, after_seq, max_bytes, wait_ms)
    }

    fn read_entry(
        entry: Option<Arc<ProcessEntry>>,
        process_id: &str,
        after_seq: Option<u64>,
        max_bytes: Option<usize>,
        wait_ms: Option<u64>,
    ) -> Result<serde_json::Value> {
        let entry = entry.with_context(|| format!("unknown process id {process_id}"))?;
        let after_seq = after_seq.unwrap_or(0);
        let max_bytes = max_bytes.unwrap_or(usize::MAX);
        let deadline = Instant::now() + Duration::from_millis(wait_ms.unwrap_or(0));
        let (lock, wake) = &*entry.state;
        let mut state = lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        acknowledge_output(&mut state, after_seq);
        wake.notify_all();
        loop {
            let has_output = state
                .chunks
                .back()
                .is_some_and(|chunk| chunk.seq > after_seq);
            if has_output || state.closed || Instant::now() >= deadline {
                break;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            let result = wake
                .wait_timeout(state, remaining)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state = result.0;
            if result.1.timed_out() {
                break;
            }
        }

        let mut bytes = 0;
        let mut chunks: Vec<(u64, u64, OutputStream, Vec<u8>)> = Vec::new();
        let mut next_seq = state.next_seq.max(1);
        for chunk in state.chunks.iter().filter(|chunk| chunk.seq > after_seq) {
            if !chunks.is_empty() && bytes + chunk.bytes.len() > max_bytes {
                break;
            }
            bytes += chunk.bytes.len();
            next_seq = chunk.seq + 1;
            if let Some((_, last_seq, stream, grouped)) = chunks.last_mut() {
                if *stream == chunk.stream {
                    *last_seq = chunk.seq;
                    grouped.extend_from_slice(&chunk.bytes);
                    if bytes >= max_bytes {
                        break;
                    }
                    continue;
                }
            }
            chunks.push((chunk.seq, chunk.seq, chunk.stream, chunk.bytes.clone()));
            if bytes >= max_bytes {
                break;
            }
        }
        let chunks: Vec<_> = chunks
            .into_iter()
            .map(|(start_seq, seq, stream, bytes)| {
                json!({
                    "startSeq": start_seq,
                    "seq": seq,
                    "stream": stream,
                    "chunk": BASE64_STANDARD.encode(bytes),
                })
            })
            .collect();
        let more = state
            .chunks
            .back()
            .is_some_and(|chunk| chunk.seq >= next_seq);
        Ok(json!({
            "chunks": chunks,
            "nextSeq": next_seq,
            "more": more,
            "exited": state.exit_code.is_some(),
            "exitCode": state.exit_code,
            "closed": state.closed,
            "failure": null,
        }))
    }

    pub fn write(&self, process_id: &str, chunk: &[u8]) -> Result<serde_json::Value> {
        let entry = self.processes.get(process_id).cloned();
        Self::write_entry(entry, chunk)
    }

    fn write_entry(entry: Option<Arc<ProcessEntry>>, chunk: &[u8]) -> Result<serde_json::Value> {
        let Some(entry) = entry else {
            return Ok(json!({ "status": "unknown_process" }));
        };
        let mut writer = entry
            .writer
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(writer) = writer.as_mut() else {
            return Ok(json!({ "status": "stdin_closed" }));
        };
        writer.write_all(chunk)?;
        writer.flush()?;
        Ok(json!({ "status": "accepted" }))
    }

    pub fn terminate(&self, process_id: &str) -> Result<serde_json::Value> {
        let Some(entry) = self.processes.get(process_id) else {
            return Ok(json!({ "running": false }));
        };
        let running = entry
            .state
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .exit_code
            .is_none();
        if running {
            kill_process(entry)?;
        }
        Ok(json!({ "running": running }))
    }

    pub fn interrupt(&self, process_id: &str) -> Result<serde_json::Value> {
        let Some(entry) = self.processes.get(process_id) else {
            return Ok(json!({ "running": false }));
        };
        let running = entry
            .state
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .exit_code
            .is_none();
        if running {
            signal_process_group(entry, rustix::process::Signal::INT)?;
        }
        Ok(json!({ "running": running }))
    }

    pub fn resize(&self, process_id: &str, rows: u16, cols: u16) -> Result<serde_json::Value> {
        let Some(entry) = self.processes.get(process_id) else {
            return Ok(json!({ "resized": false }));
        };
        if !entry.tty {
            return Ok(json!({ "resized": false }));
        }
        entry.control_pty.resize(PtySize::new(rows, cols))?;
        Ok(json!({ "resized": true }))
    }

    pub fn reap(&mut self, process_id: &str) -> Result<serde_json::Value> {
        let Some(entry) = self.processes.get(process_id) else {
            return Ok(json!({ "removed": false }));
        };
        let closed = entry
            .state
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .closed;
        if !closed {
            anyhow::bail!("process {process_id} cannot be reaped before final output closes");
        }
        self.processes.remove(process_id);
        Ok(json!({ "removed": true }))
    }

    pub fn shutdown(&mut self) {
        for entry in self.processes.values() {
            let (lock, wake) = &*entry.state;
            let mut state = lock
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let running = state.exit_code.is_none();
            state.accepting_output = false;
            wake.notify_all();
            drop(state);
            if running {
                let _ = kill_process(entry);
            }
        }
        self.processes.clear();
    }
}

pub struct ExecParams {
    pub process_id: String,
    pub argv: Vec<String>,
    pub cwd: PathBuf,
    pub env: HashMap<String, String>,
    pub tty: bool,
    pub pipe_stdin: bool,
    pub arg0: Option<String>,
    pub rows: Option<u16>,
    pub cols: Option<u16>,
}

fn fresh_state(open_streams: usize) -> Arc<(Mutex<ProcessState>, Condvar)> {
    Arc::new((
        Mutex::new(ProcessState {
            next_seq: 1,
            open_streams,
            accepting_output: true,
            ..ProcessState::default()
        }),
        Condvar::new(),
    ))
}

fn spawn_pipe(params: &ExecParams) -> Result<Arc<ProcessEntry>> {
    // pty-process creates a new session and process group without unsafe code.
    // The child stdio still uses real pipes because all three streams are
    // overridden below. Retain the control PTY to avoid a premature hangup.
    let (control_pty, pts) = open_pty()?;
    let command = PtyCommand::new(&params.argv[0])
        .args(&params.argv[1..])
        .current_dir(&params.cwd)
        .env_clear()
        .envs(&params.env)
        .stdin(if params.pipe_stdin {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn(pts).context("failed to spawn command")?;
    let process_group = rustix::process::Pid::from_raw(child.id() as i32)
        .context("spawned command has an invalid process id")?;
    let stdin = child
        .stdin
        .take()
        .map(|writer| Box::new(writer) as Box<dyn Write + Send>);
    let stdout = child.stdout.take().context("missing stdout pipe")?;
    let stderr = child.stderr.take().context("missing stderr pipe")?;
    let state = fresh_state(2);
    spawn_reader(stdout, OutputStream::Stdout, Arc::clone(&state));
    spawn_reader(stderr, OutputStream::Stderr, Arc::clone(&state));
    let child = Arc::new(Mutex::new(child));
    spawn_pipe_waiter(Arc::clone(&child), Arc::clone(&state));
    Ok(Arc::new(ProcessEntry {
        state,
        writer: Mutex::new(stdin),
        killer: Mutex::new(ProcessKiller {
            child,
            process_group,
        }),
        tty: false,
        control_pty,
    }))
}

fn spawn_pty(params: &ExecParams) -> Result<Arc<ProcessEntry>> {
    let (pty, pts) = open_pty()?;
    let rows = params.rows.unwrap_or(24);
    let cols = params.cols.unwrap_or(80);
    if rows == 0 || cols == 0 {
        anyhow::bail!("PTY size must be non-zero");
    }
    pty.resize(PtySize::new(rows, cols))?;
    let program = params.arg0.as_ref().unwrap_or(&params.argv[0]);
    let command = PtyCommand::new(program)
        .args(&params.argv[1..])
        .current_dir(&params.cwd)
        .env_clear()
        .envs(&params.env);
    let child = Arc::new(Mutex::new(command.spawn(pts)?));
    let process_group = rustix::process::Pid::from_raw(
        child
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .id() as i32,
    )
    .context("spawned command has an invalid process id")?;
    let reader = std::fs::File::from(pty.as_fd().try_clone_to_owned()?);
    let writer =
        Box::new(std::fs::File::from(pty.as_fd().try_clone_to_owned()?)) as Box<dyn Write + Send>;
    let state = fresh_state(1);
    spawn_reader(reader, OutputStream::Pty, Arc::clone(&state));
    spawn_pipe_waiter(Arc::clone(&child), Arc::clone(&state));
    Ok(Arc::new(ProcessEntry {
        state,
        writer: Mutex::new(Some(writer)),
        killer: Mutex::new(ProcessKiller {
            child,
            process_group,
        }),
        tty: true,
        control_pty: pty,
    }))
}

fn spawn_reader<R: Read + Send + 'static>(
    mut reader: R,
    stream: OutputStream,
    state: Arc<(Mutex<ProcessState>, Condvar)>,
) {
    std::thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => append_output(&state, stream, buffer[..count].to_vec()),
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => break,
            }
        }
        close_stream(&state);
    });
}

fn append_output(
    state: &Arc<(Mutex<ProcessState>, Condvar)>,
    stream: OutputStream,
    bytes: Vec<u8>,
) {
    let (lock, wake) = &**state;
    let mut state = lock
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    while state.accepting_output
        && state.retained_bytes > 0
        && state.retained_bytes + bytes.len() > RETAINED_OUTPUT_BYTES
    {
        state = wake
            .wait(state)
            .unwrap_or_else(std::sync::PoisonError::into_inner);
    }
    if !state.accepting_output {
        return;
    }
    let seq = state.next_seq;
    state.next_seq += 1;
    state.retained_bytes += bytes.len();
    state.chunks.push_back(OutputChunk { seq, stream, bytes });
    wake.notify_all();
}

fn acknowledge_output(state: &mut ProcessState, after_seq: u64) {
    while state
        .chunks
        .front()
        .is_some_and(|chunk| chunk.seq <= after_seq)
    {
        let Some(removed) = state.chunks.pop_front() else {
            break;
        };
        state.retained_bytes = state.retained_bytes.saturating_sub(removed.bytes.len());
    }
}

fn close_stream(state: &Arc<(Mutex<ProcessState>, Condvar)>) {
    let (lock, wake) = &**state;
    let mut state = lock
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    state.open_streams = state.open_streams.saturating_sub(1);
    state.closed = state.open_streams == 0 && state.exit_code.is_some();
    wake.notify_all();
}

fn record_exit(state: &Arc<(Mutex<ProcessState>, Condvar)>, exit_code: i32) {
    let (lock, wake) = &**state;
    let mut state = lock
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    state.exit_code = Some(exit_code);
    state.closed = state.open_streams == 0;
    wake.notify_all();
}

fn spawn_pipe_waiter(child: Arc<Mutex<Child>>, state: Arc<(Mutex<ProcessState>, Condvar)>) {
    std::thread::spawn(move || loop {
        let status = child
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .try_wait();
        match status {
            Ok(Some(status)) => {
                record_exit(&state, status.code().unwrap_or(1));
                break;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(_) => {
                record_exit(&state, 1);
                break;
            }
        }
    });
}

fn kill_process(entry: &ProcessEntry) -> Result<()> {
    let killer = entry
        .killer
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let group_result =
        rustix::process::kill_process_group(killer.process_group, rustix::process::Signal::KILL);
    let child_result = killer
        .child
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .kill();
    group_result.or(child_result)?;
    Ok(())
}

fn signal_process_group(entry: &ProcessEntry, signal: rustix::process::Signal) -> Result<()> {
    let killer = entry
        .killer
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    rustix::process::kill_process_group(killer.process_group, signal)?;
    Ok(())
}

fn respond(request_id: u64, result: Result<serde_json::Value>) {
    let response = match result {
        Ok(result) => Response {
            request_id,
            ok: true,
            result: Some(result),
            error: None,
        },
        Err(error) => Response {
            request_id,
            ok: false,
            result: None,
            error: Some(error.to_string()),
        },
    };
    println!(
        "{}",
        serde_json::to_string(&response).expect("response must serialize")
    );
}

pub fn run_main() -> Result<()> {
    let mut server = Server::default();
    for line in std::io::stdin().lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let request: Request = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(error) => {
                respond(0, Err(error.into()));
                continue;
            }
        };
        let request_id = request.request_id();
        let mut shutdown = false;
        let result = match request {
            Request::Exec {
                process_id,
                argv,
                cwd,
                env,
                tty,
                pipe_stdin,
                arg0,
                rows,
                cols,
                ..
            } => server.exec(&ExecParams {
                process_id,
                argv,
                cwd: PathBuf::from(cwd),
                env,
                tty,
                pipe_stdin,
                arg0,
                rows,
                cols,
            }),
            Request::Read {
                process_id,
                after_seq,
                max_bytes,
                wait_ms,
                ..
            } => {
                let entry = server.processes.get(&process_id).cloned();
                std::thread::spawn(move || {
                    respond(
                        request_id,
                        Server::read_entry(entry, &process_id, after_seq, max_bytes, wait_ms),
                    );
                });
                continue;
            }
            Request::Write {
                process_id, chunk, ..
            } => server.write(&process_id, chunk.as_bytes()),
            Request::Interrupt { process_id, .. } => server.interrupt(&process_id),
            Request::Terminate { process_id, .. } => server.terminate(&process_id),
            Request::Resize {
                process_id,
                rows,
                cols,
                ..
            } => server.resize(&process_id, rows, cols),
            Request::Reap { process_id, .. } => server.reap(&process_id),
            Request::Shutdown { .. } => {
                server.shutdown();
                shutdown = true;
                Ok(json!({ "shutdown": true }))
            }
        };
        respond(request_id, result);
        if shutdown {
            break;
        }
    }
    server.shutdown();
    Ok(())
}
