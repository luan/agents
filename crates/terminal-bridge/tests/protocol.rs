use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};

use std::sync::mpsc;
use std::time::Duration;

use pretty_assertions::assert_eq;
use serde_json::{json, Value};

struct Bridge {
    child: Child,
    input: ChildStdin,
    output: mpsc::Receiver<String>,
}

impl Bridge {
    fn send(&mut self, request: &Value) {
        writeln!(self.input, "{request}").unwrap();
    }

    fn receive(&mut self) -> Value {
        let line = self
            .output
            .recv_timeout(Duration::from_secs(2))
            .expect("bridge did not respond");
        serde_json::from_str(&line).unwrap()
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[rstest::fixture]
fn bridge() -> Bridge {
    let mut child = Command::new(env!("CARGO_BIN_EXE_terminal-bridge"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let stdout = child.stdout.take().unwrap();
    let (responses, output) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            if responses.send(line.unwrap()).is_err() {
                break;
            }
        }
    });
    Bridge {
        input: child.stdin.take().unwrap(),
        output,
        child,
    }
}

#[rstest::rstest]
fn waiting_read_does_not_block_the_write_that_produces_output(mut bridge: Bridge) {
    bridge.send(&json!({
        "request_id": 1, "op": "exec", "process_id": "input",
        "argv": ["sh", "-c", "read value; printf '%s' \"$value\""],
        "cwd": ".", "env": {}, "tty": false, "pipe_stdin": true
    }));
    assert_eq!(
        bridge.receive(),
        json!({
            "request_id": 1, "ok": true, "result": { "processId": "input" }, "error": null
        })
    );
    bridge.send(&json!({"request_id": 2, "op": "read", "process_id": "input", "wait_ms": 1000}));
    bridge
        .send(&json!({"request_id": 3, "op": "write", "process_id": "input", "chunk": "hello\n"}));
    let mut responses = [bridge.receive(), bridge.receive()];
    responses.sort_by_key(|response| response["request_id"].as_u64().unwrap());
    assert_eq!(responses[0]["request_id"], 2);
    assert_eq!(responses[0]["ok"], true);
    assert_eq!(responses[0]["result"]["chunks"][0]["chunk"], "aGVsbG8=");
    assert_eq!(
        responses[1],
        json!({
            "request_id": 3, "ok": true, "result": { "status": "accepted" }, "error": null
        })
    );
    bridge.send(&json!({"request_id": 4, "op": "shutdown"}));
    assert_eq!(
        bridge.receive(),
        json!({
            "request_id": 4, "ok": true, "result": { "shutdown": true }, "error": null
        })
    );
    assert!(bridge.child.wait().unwrap().success());
}

#[rstest::rstest]
#[case(json!({"request_id": 1, "op": "unknown"}))]
#[case(json!({"op": "shutdown"}))]
#[case(json!({"request_id": 1, "op": "exec", "process_id": "missing-fields"}))]
fn malformed_request_does_not_stop_the_server(mut bridge: Bridge, #[case] request: Value) {
    bridge.send(&request);
    let response = bridge.receive();
    assert_eq!(response["request_id"], 0);
    assert_eq!(response["ok"], false);
    assert!(response["error"].is_string());
    bridge.send(&json!({"request_id": 2, "op": "shutdown"}));
    assert_eq!(bridge.receive()["ok"], true);
    assert!(bridge.child.wait().unwrap().success());
}

#[rstest::rstest]
fn discard_wakes_a_pending_read(mut bridge: Bridge) {
    bridge.send(&json!({
        "request_id": 1, "op": "exec", "process_id": "discarded",
        "argv": ["cat"], "cwd": ".", "env": {}, "tty": false, "pipe_stdin": true
    }));
    assert_eq!(bridge.receive()["ok"], true);
    bridge.send(&json!({
        "request_id": 2, "op": "read", "process_id": "discarded", "wait_ms": 10000
    }));
    bridge.send(&json!({"request_id": 3, "op": "discard", "process_id": "discarded"}));
    let mut responses = [bridge.receive(), bridge.receive()];
    responses.sort_by_key(|response| response["request_id"].as_u64().unwrap());
    assert_eq!(responses[0]["request_id"], 2);
    assert_eq!(responses[0]["ok"], true);
    assert_eq!(responses[1]["result"], json!({"removed": true}));
    bridge.send(&json!({"request_id": 4, "op": "shutdown"}));
    assert_eq!(bridge.receive()["ok"], true);
    assert!(bridge.child.wait().unwrap().success());
}

#[rstest::rstest]
#[case(false)]
#[case(true)]
fn blocked_stdin_does_not_block_termination(mut bridge: Bridge, #[case] tty: bool) {
    let command = if tty {
        "stty raw -echo; head -c 16777216 /dev/zero"
    } else {
        "head -c 16777216 /dev/zero"
    };
    bridge.send(&json!({
        "request_id": 1, "op": "exec", "process_id": "backpressure",
        "argv": ["sh", "-c", command],
        "cwd": ".", "env": {}, "tty": tty, "pipe_stdin": true
    }));
    assert_eq!(bridge.receive()["ok"], true);
    // Wait for raw mode before filling a PTY input queue; consume only one output chunk.
    bridge.send(&json!({"request_id": 40, "op": "read", "process_id": "backpressure", "max_bytes": 1, "wait_ms": 1000}));
    assert_eq!(bridge.receive()["ok"], true);
    // Output fills the retained budget while the child never reads its stdin.
    bridge.send(&json!({
        "request_id": 2, "op": "write", "process_id": "backpressure", "chunk": "x".repeat(2 * 1024 * 1024)
    }));
    // Excess queued writes fail promptly, leaving control requests responsive.
    for request_id in 3..=34 {
        bridge.send(&json!({"request_id": request_id, "op": "write", "process_id": "backpressure", "chunk": "queued"}));
    }
    bridge.send(&json!({"request_id": 35, "op": "terminate", "process_id": "backpressure"}));
    let mut responses: Vec<_> = (0..34).map(|_| bridge.receive()).collect();
    responses.sort_by_key(|response| response["request_id"].as_u64().unwrap());
    assert_eq!(responses[0]["request_id"], 2);
    assert!(responses
        .iter()
        .any(|response| response["error"] == "stdin write queue is full"));
    let terminated = responses.last().unwrap();
    assert_eq!(terminated["request_id"], 35);
    assert_eq!(terminated["ok"], true);
    assert_eq!(terminated["result"], json!({"running": true}));
    bridge.send(&json!({"request_id": 36, "op": "shutdown"}));
    assert_eq!(bridge.receive()["ok"], true);
    assert!(bridge.child.wait().unwrap().success());
}

#[rstest::rstest]
fn concurrent_writes_preserve_protocol_order(mut bridge: Bridge) {
    bridge.send(&json!({
        "request_id": 1, "op": "exec", "process_id": "ordered",
        "argv": ["sh", "-c", "IFS= read -r a; IFS= read -r b; printf '%s|%s' \"$a\" \"$b\""],
        "cwd": ".", "env": {}, "tty": false, "pipe_stdin": true
    }));
    assert_eq!(bridge.receive()["ok"], true);
    for (request_id, chunk) in [(2, "first\n"), (3, "second\n")] {
        bridge.send(&json!({"request_id": request_id, "op": "write", "process_id": "ordered", "chunk": chunk}));
    }
    for _ in 0..2 {
        let response = bridge.receive();
        assert_eq!(response["ok"], true);
        assert_eq!(response["result"], json!({"status": "accepted"}));
    }
    bridge.send(&json!({"request_id": 4, "op": "read", "process_id": "ordered", "wait_ms": 1000}));
    assert_eq!(
        bridge.receive()["result"]["chunks"][0]["chunk"],
        "Zmlyc3R8c2Vjb25k"
    );
    bridge.send(&json!({"request_id": 5, "op": "shutdown"}));
    assert_eq!(bridge.receive()["ok"], true);
    assert!(bridge.child.wait().unwrap().success());
}
