use std::collections::HashMap;
use std::path::PathBuf;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use exec_command::{ExecParams, Server};
use pretty_assertions::assert_eq;
use proptest::prelude::*;
use proptest_derive::Arbitrary;

fn collect_until_exit(
    server: &Server,
    process_id: &str,
    max_bytes: Option<usize>,
) -> (Vec<u8>, i64) {
    let mut after_seq = 0;
    let mut output = Vec::new();
    for _ in 0..40 {
        let response = server
            .read(process_id, Some(after_seq), max_bytes, Some(100))
            .unwrap();
        for chunk in response["chunks"].as_array().unwrap() {
            after_seq = after_seq.max(chunk["seq"].as_u64().unwrap());
            output.extend(
                BASE64_STANDARD
                    .decode(chunk["chunk"].as_str().unwrap())
                    .unwrap(),
            );
        }
        if response["more"] == false {
            if let Some(exit_code) = response["exitCode"].as_i64() {
                return (output, exit_code);
            }
        }
    }
    panic!("process did not exit");
}

fn params(process_id: &str, argv: &[&str], tty: bool, pipe_stdin: bool) -> ExecParams {
    ExecParams {
        process_id: process_id.into(),
        argv: argv.iter().map(|arg| (*arg).into()).collect(),
        cwd: std::env::current_dir().unwrap(),
        env: std::env::vars().collect(),
        tty,
        pipe_stdin,
        arg0: None,
        rows: None,
        cols: None,
    }
}

#[rstest::fixture]
fn server() -> Server {
    Server::default()
}

#[rstest::rstest]
fn pipe_process_returns_stdout_and_exit_code(mut server: Server) {
    server
        .exec(&params("test", &["sh", "-c", "printf hello"], false, false))
        .unwrap();
    assert_eq!(
        server.write("test", b"input").unwrap()["status"],
        "stdin_closed"
    );
    let (output, exit_code) = collect_until_exit(&server, "test", None);
    assert_eq!(exit_code, 0);
    assert_eq!(output, b"hello");
}

#[rstest::rstest]
fn pty_process_accepts_input(mut server: Server) {
    server
        .exec(&params(
            "interactive",
            &["sh", "-c", "read value; printf 'got:%s\\n' \"$value\""],
            true,
            true,
        ))
        .unwrap();
    server.write("interactive", b"hello\n").unwrap();
    let (output, exit_code) = collect_until_exit(&server, "interactive", None);
    assert_eq!(exit_code, 0);
    assert!(String::from_utf8_lossy(&output).contains("got:hello"));
}

#[rstest::rstest]
fn pty_process_starts_at_the_requested_size(mut server: Server) {
    let mut request = params("sized", &["sh", "-c", "stty size"], true, true);
    request.rows = Some(41);
    request.cols = Some(121);
    server.exec(&request).unwrap();

    let (output, exit_code) = collect_until_exit(&server, "sized", None);

    assert_eq!(exit_code, 0);
    assert_eq!(String::from_utf8_lossy(&output).trim(), "41 121");
}

#[rstest::rstest]
fn pty_process_resizes_before_forwarding_input(mut server: Server) {
    let process_id = "resizable";
    server
        .exec(&params(
            process_id,
            &["sh", "-c", "printf ready; read value; stty size"],
            true,
            true,
        ))
        .unwrap();
    assert_eq!(server.resize(process_id, 40, 120).unwrap()["resized"], true);
    server.write(process_id, b"\n").unwrap();

    let (output, exit_code) = collect_until_exit(&server, process_id, None);

    assert_eq!(exit_code, 0);
    assert!(String::from_utf8_lossy(&output).contains("40 120"));
}

#[rstest::rstest]
fn running_process_group_accepts_interrupt(mut server: Server) {
    let process_id = "interruptible";
    server
        .exec(&params(
            process_id,
            &[
                "sh",
                "-c",
                "trap 'exit 23' INT; printf ready; while :; do sleep 1; done",
            ],
            false,
            false,
        ))
        .unwrap();
    let mut trapped = false;
    for _ in 0..20 {
        let response = server.read(process_id, Some(0), None, Some(50)).unwrap();
        let ready = response["chunks"].as_array().unwrap().iter().any(|chunk| {
            BASE64_STANDARD
                .decode(chunk["chunk"].as_str().unwrap())
                .unwrap()
                .windows(5)
                .any(|window| window == b"ready")
        });
        if ready {
            trapped = true;
            break;
        }
    }
    assert!(trapped, "process did not install its interrupt trap");

    assert_eq!(server.interrupt(process_id).unwrap()["running"], true);
    let (_, exit_code) = collect_until_exit(&server, process_id, None);
    assert_eq!(exit_code, 23);
}

#[rstest::rstest]
fn completed_processes_are_reaped_after_final_output_is_read(mut server: Server) {
    let process_id = "command";
    server
        .exec(&params(
            process_id,
            &["sh", "-c", "printf done"],
            false,
            false,
        ))
        .unwrap();
    let (output, exit_code) = collect_until_exit(&server, process_id, None);
    assert_eq!(output, b"done");
    assert_eq!(exit_code, 0);
    assert_eq!(server.reap(process_id).unwrap()["removed"], true);
}

#[rstest::rstest]
fn bounded_reads_report_closed_output_until_the_backlog_is_drained(mut server: Server) {
    let process_id = "bounded-output";
    server
        .exec(&params(
            process_id,
            &["sh", "-c", "yes x | head -c 100000; printf 'final-marker'"],
            false,
            false,
        ))
        .unwrap();

    let (output, exit_code) = collect_until_exit(&server, process_id, Some(1));

    assert_eq!(exit_code, 0);
    assert!(output.ends_with(b"final-marker"));
}

#[derive(Debug, Arbitrary)]
struct ProcessId(#[proptest(regex = "[a-z0-9_-]{1,16}")] String);

proptest! {
    #![proptest_config(ProptestConfig::with_cases(16))]

    // Property: invalid empty argv is rejected before any process is spawned.
    #[test]
    fn empty_argv_is_rejected_for_every_process_id(input: ProcessId) {
        let mut server = Server::default();
        let error = server
            .exec(&ExecParams {
                process_id: input.0,
                argv: Vec::new(),
                cwd: PathBuf::from("."),
                env: HashMap::new(),
                tty: false,
                pipe_stdin: false,
                arg0: None,
                rows: None,
                cols: None,
            })
            .expect_err("empty argv must be rejected");
        prop_assert_eq!(error.to_string(), "argv must not be empty");
    }
}
