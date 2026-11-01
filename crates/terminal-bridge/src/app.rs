use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, Read, Write};
use std::os::fd::{AsFd, OwnedFd};
use std::path::PathBuf;
use std::process::{Child, Stdio};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use pty_process::blocking::{open as open_pty, Command as PtyCommand};
use pty_process::Size as PtySize;
use rustix::event::{poll, PollFd, PollFlags};
use serde::{Deserialize, Serialize};
use serde_json::json;

// Backpressure one slow reader without dropping its output. Raise this only when a measured
// consumer benefits from a larger per-process burst budget.
const RETAINED_OUTPUT_BYTES: usize = 8 * 1024 * 1024;
// Bounds native process and reader-thread ownership. Raise this only with a measured concurrent
// workload and an explicit file-descriptor/thread budget.
const MAX_ACTIVE_PROCESSES: usize = 64;
// Bound input queued behind a blocked child. Raise only for a measured concurrent-input workload.
const MAX_PENDING_WRITES: usize = 16;

#[derive(Debug, Deserialize)]
struct Request {
    request_id: u64,
    #[serde(flatten)]
    operation: Operation,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum Operation {
    Exec(ExecParams),
    Read {
        process_id: String,
        after_seq: Option<u64>,
        max_bytes: Option<usize>,
        wait_ms: Option<u64>,
    },
    Write {
        process_id: String,
        chunk: String,
    },
    Interrupt {
        process_id: String,
    },
    Terminate {
        process_id: String,
    },
    Resize {
        process_id: String,
        rows: u16,
        cols: u16,
    },
    Reap {
        process_id: String,
    },
    Discard {
        process_id: String,
    },
    Shutdown,
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
    accepting_output: bool,
}

impl ProcessState {
    fn closed(&self) -> bool {
        self.open_streams == 0 && self.exit_code.is_some()
    }

    fn read_output(&self, after_seq: u64, max_bytes: usize) -> serde_json::Value {
        let mut bytes = 0;
        let mut chunks: Vec<(u64, u64, OutputStream, Vec<u8>)> = Vec::new();
        let mut next_seq = self.next_seq.max(1);
        for chunk in self.chunks.iter().filter(|chunk| chunk.seq > after_seq) {
            if !chunks.is_empty() && bytes + chunk.bytes.len() > max_bytes {
                break;
            }
            bytes += chunk.bytes.len();
            next_seq = chunk.seq + 1;
            match chunks.last_mut() {
                Some((_, last_seq, stream, grouped)) if *stream == chunk.stream => {
                    *last_seq = chunk.seq;
                    grouped.extend_from_slice(&chunk.bytes);
                }
                _ => chunks.push((chunk.seq, chunk.seq, chunk.stream, chunk.bytes.clone())),
            }
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
        let more = self
            .chunks
            .back()
            .is_some_and(|chunk| chunk.seq >= next_seq);
        json!({
            "chunks": chunks,
            "nextSeq": next_seq,
            "more": more,
            "exited": self.exit_code.is_some(),
            "exitCode": self.exit_code,
            "closed": self.closed(),
            "failure": null,
        })
    }
}

struct WriteRequest {
    chunk: Vec<u8>,
    respond: Box<dyn FnOnce(Result<serde_json::Value>) + Send>,
}

struct ProcessEntry {
    state: Arc<(Mutex<ProcessState>, Condvar)>,
    writer: Option<mpsc::SyncSender<WriteRequest>>,
    process_group: rustix::process::Pid,
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
            anyhow::bail!(
                "terminal bridge supports at most {MAX_ACTIVE_PROCESSES} active processes"
            );
        }
        let entry = spawn_process(params)?;
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
            if has_output || state.closed() || !state.accepting_output || Instant::now() >= deadline
            {
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

        Ok(state.read_output(after_seq, max_bytes))
    }

    pub fn write(&self, process_id: &str, chunk: &[u8]) -> Result<serde_json::Value> {
        let (response, result) = mpsc::sync_channel(1);
        self.queue_write(process_id, chunk.to_vec(), move |result| {
            let _ = response.send(result);
        });
        result
            .recv()
            .context("stdin writer ended without responding")?
    }

    fn queue_write(
        &self,
        process_id: &str,
        chunk: Vec<u8>,
        respond: impl FnOnce(Result<serde_json::Value>) + Send + 'static,
    ) {
        let Some(entry) = self.processes.get(process_id) else {
            respond(Ok(json!({ "status": "unknown_process" })));
            return;
        };
        let Some(writer) = &entry.writer else {
            respond(Ok(json!({ "status": "stdin_closed" })));
            return;
        };
        let request = WriteRequest {
            chunk,
            respond: Box::new(respond),
        };
        if let Err(error) = writer.try_send(request) {
            let (request, message) = match error {
                mpsc::TrySendError::Full(request) => (request, "stdin write queue is full"),
                mpsc::TrySendError::Disconnected(request) => (request, "stdin writer is closed"),
            };
            (request.respond)(Err(anyhow::anyhow!(message)));
        }
    }

    pub fn terminate(&self, process_id: &str) -> Result<serde_json::Value> {
        self.signal(process_id, rustix::process::Signal::KILL)
    }

    pub fn interrupt(&self, process_id: &str) -> Result<serde_json::Value> {
        self.signal(process_id, rustix::process::Signal::INT)
    }

    fn signal(
        &self,
        process_id: &str,
        signal: rustix::process::Signal,
    ) -> Result<serde_json::Value> {
        let Some(entry) = self.processes.get(process_id) else {
            return Ok(json!({ "running": false }));
        };
        // Descendants can retain the streams after the shell itself exits.
        let running = !entry
            .state
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .closed();
        if running {
            signal_process_group(entry, signal)?;
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
            .closed();
        if !closed {
            anyhow::bail!("process {process_id} cannot be reaped before final output closes");
        }
        self.processes.remove(process_id);
        Ok(json!({ "removed": true }))
    }

    pub fn shutdown(&mut self) {
        for entry in self.processes.values() {
            let _ = discard_output_and_terminate(entry);
        }
        self.processes.clear();
    }

    /// Abandon output and release native ownership when a consumer cancels or cannot read it.
    pub fn discard(&mut self, process_id: &str) -> Result<serde_json::Value> {
        let Some(entry) = self.processes.get(process_id) else {
            return Ok(json!({ "removed": false }));
        };
        discard_output_and_terminate(entry)?;
        self.processes.remove(process_id);
        Ok(json!({ "removed": true }))
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[derive(Debug, Deserialize)]
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

fn spawn_process(params: &ExecParams) -> Result<Arc<ProcessEntry>> {
    // Every child gets its own session/process group, including pipe commands.
    // Retain the control PTY so its closure cannot prematurely hang up the child.
    let (control_pty, pts) = open_pty()?;
    let terminal_io = if params.tty {
        let rows = params.rows.unwrap_or(24);
        let cols = params.cols.unwrap_or(80);
        if rows == 0 || cols == 0 {
            anyhow::bail!("PTY size must be non-zero");
        }
        control_pty.resize(PtySize::new(rows, cols))?;
        // A blocking master write can remain asleep after its slave closes. Duplicated
        // descriptors share this flag, so the reader also waits for readiness below.
        let flags = rustix::fs::fcntl_getfl(&control_pty)?;
        rustix::fs::fcntl_setfl(&control_pty, flags | rustix::fs::OFlags::NONBLOCK)?;
        Some((
            std::fs::File::from(control_pty.as_fd().try_clone_to_owned()?),
            std::fs::File::from(control_pty.as_fd().try_clone_to_owned()?),
        ))
    } else {
        None
    };
    let program = if params.tty {
        params.arg0.as_ref()
    } else {
        None
    }
    .unwrap_or(&params.argv[0]);
    let mut command = PtyCommand::new(program)
        .args(&params.argv[1..])
        .current_dir(&params.cwd)
        .env_clear()
        .envs(&params.env);
    if !params.tty {
        command = command
            .stdin(if params.pipe_stdin {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
    }
    let mut child = command.spawn(pts).context("failed to spawn command")?;
    let process_group = rustix::process::Pid::from_raw(child.id() as i32)
        .context("spawned command has an invalid process id")?;
    let state = fresh_state(if params.tty { 1 } else { 2 });
    let writer = if let Some((reader, writer)) = terminal_io {
        spawn_reader(reader, OutputStream::Pty, Arc::clone(&state));
        Some(writer)
    } else {
        spawn_reader(
            child.stdout.take().context("missing stdout pipe")?,
            OutputStream::Stdout,
            Arc::clone(&state),
        );
        spawn_reader(
            child.stderr.take().context("missing stderr pipe")?,
            OutputStream::Stderr,
            Arc::clone(&state),
        );
        child
            .stdin
            .take()
            .map(|writer| std::fs::File::from(OwnedFd::from(writer)))
    };
    spawn_waiter(child, Arc::clone(&state));
    Ok(Arc::new(ProcessEntry {
        state,
        writer: writer.map(spawn_writer),
        process_group,
        tty: params.tty,
        control_pty,
    }))
}

fn spawn_writer(mut writer: std::fs::File) -> mpsc::SyncSender<WriteRequest> {
    let (sender, requests) = mpsc::sync_channel::<WriteRequest>(MAX_PENDING_WRITES);
    std::thread::spawn(move || {
        for request in requests {
            let result = write_input(&mut writer, &request.chunk);
            (request.respond)(
                result
                    .map(|()| json!({ "status": "accepted" }))
                    .map_err(Into::into),
            );
        }
    });
    sender
}

fn wait_for_io(fd: &impl AsFd, events: PollFlags) -> std::io::Result<PollFlags> {
    let mut fds = [PollFd::new(fd, events)];
    loop {
        match poll(&mut fds, None) {
            Ok(_) => return Ok(fds[0].revents()),
            Err(rustix::io::Errno::INTR) => {}
            Err(error) => return Err(error.into()),
        }
    }
}

fn write_input(writer: &mut std::fs::File, mut bytes: &[u8]) -> std::io::Result<()> {
    while !bytes.is_empty() {
        if wait_for_io(writer, PollFlags::OUT)?.intersects(PollFlags::HUP | PollFlags::ERR) {
            return Err(std::io::ErrorKind::BrokenPipe.into());
        }
        match writer.write(bytes) {
            Ok(0) => return Err(std::io::ErrorKind::WriteZero.into()),
            Ok(count) => bytes = &bytes[count..],
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::Interrupted | std::io::ErrorKind::WouldBlock
                ) => {}
            Err(error) => return Err(error),
        }
    }
    writer.flush()
}

fn spawn_reader<R: Read + AsFd + Send + 'static>(
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
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    if wait_for_io(&reader, PollFlags::IN).is_err() {
                        break;
                    }
                }
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
    wake.notify_all();
}

fn record_exit(state: &Arc<(Mutex<ProcessState>, Condvar)>, exit_code: i32) {
    let (lock, wake) = &**state;
    let mut state = lock
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    state.exit_code = Some(exit_code);
    wake.notify_all();
}

fn spawn_waiter(mut child: Child, state: Arc<(Mutex<ProcessState>, Condvar)>) {
    // The waiter owns the child; signals use its session's process group.
    std::thread::spawn(move || {
        let exit_code = child
            .wait()
            .ok()
            .and_then(|status| status.code())
            .unwrap_or(1);
        record_exit(&state, exit_code);
    });
}

fn signal_process_group(entry: &ProcessEntry, signal: rustix::process::Signal) -> Result<()> {
    match rustix::process::kill_process_group(entry.process_group, signal) {
        // The process can exit between checking its state and sending the signal.
        Ok(()) | Err(rustix::io::Errno::SRCH) => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn discard_output_and_terminate(entry: &ProcessEntry) -> Result<()> {
    let (lock, wake) = &*entry.state;
    let mut state = lock
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if !state.closed() {
        signal_process_group(entry, rustix::process::Signal::KILL)?;
    }
    state.accepting_output = false;
    wake.notify_all();
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
        let request_id = request.request_id;
        let shutdown = matches!(request.operation, Operation::Shutdown);
        let result = match request.operation {
            Operation::Exec(params) => server.exec(&params),
            Operation::Read {
                process_id,
                after_seq,
                max_bytes,
                wait_ms,
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
            Operation::Write { process_id, chunk } => {
                server.queue_write(&process_id, chunk.into_bytes(), move |result| {
                    respond(request_id, result);
                });
                continue;
            }
            Operation::Interrupt { process_id } => server.interrupt(&process_id),
            Operation::Terminate { process_id } => server.terminate(&process_id),
            Operation::Resize {
                process_id,
                rows,
                cols,
            } => server.resize(&process_id, rows, cols),
            Operation::Reap { process_id } => server.reap(&process_id),
            Operation::Discard { process_id } => server.discard(&process_id),
            Operation::Shutdown => {
                server.shutdown();
                Ok(json!({ "shutdown": true }))
            }
        };
        respond(request_id, result);
        if shutdown {
            break;
        }
    }
    Ok(())
}
