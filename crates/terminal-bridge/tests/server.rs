use std::collections::HashMap;
use std::path::PathBuf;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use pretty_assertions::assert_eq;
use proptest::prelude::*;
use proptest_derive::Arbitrary;
use terminal_bridge::{ExecParams, Server};

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
            assert_eq!(chunk["startSeq"].as_u64().unwrap(), after_seq + 1);
            after_seq = chunk["seq"].as_u64().unwrap();
            output.extend(
                BASE64_STANDARD
                    .decode(chunk["chunk"].as_str().unwrap())
                    .unwrap(),
            );
        }
        assert_eq!(response["nextSeq"].as_u64().unwrap(), after_seq + 1);
        if response["more"] == false && response["closed"] == true {
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
            &["sh", "-c", "trap 'exit 23' INT; printf ready; read value"],
            false,
            true,
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
    // Finish stdin too: the trap's exit code proves delivery without requiring read to unblock on SIGINT.
    let _ = server.write(process_id, b"\n");
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
fn termination_reaches_children_after_the_shell_exits(mut server: Server) {
    let process_id = "orphaned-child";
    server
        .exec(&params(
            process_id,
            &["sh", "-c", "trap '' HUP; cat <&0 &"],
            false,
            true,
        ))
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    let response = loop {
        let response = server.read(process_id, None, None, None).unwrap();
        if response["exited"] == true {
            break response;
        }
        assert!(std::time::Instant::now() < deadline, "shell did not exit");
        std::thread::yield_now();
    };
    assert_eq!(response["closed"], false);

    assert_eq!(server.terminate(process_id).unwrap()["running"], true);
    let (_, exit_code) = collect_until_exit(&server, process_id, None);
    assert_eq!(exit_code, 0, "the shell's status is preserved");
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

#[derive(Debug, Arbitrary)]
struct BinaryOutput {
    #[proptest(strategy = "proptest::collection::vec(any::<u8>(), 1..32768)")]
    bytes: Vec<u8>,
    #[proptest(strategy = "0usize..32768")]
    budget: usize,
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(16))]

    // Acknowledged reads preserve every byte even when one native chunk exceeds the budget.
    #[test]
    fn bounded_reads_preserve_binary_output(input: BinaryOutput) {
        let mut server = Server::default();
        let length = input.bytes.len().to_string();
        server.exec(&params("binary", &["head", "-c", &length], false, true)).unwrap();
        assert_eq!(server.write("binary", &input.bytes).unwrap()["status"], "accepted");
        let (output, code) = collect_until_exit(&server, "binary", Some(input.budget));
        prop_assert_eq!(output, input.bytes);
        prop_assert_eq!(code, 0);
        assert_eq!(server.reap("binary").unwrap()["removed"], true);
    }
}

#[rstest::rstest]
#[case(false)]
#[case(true)]
fn discarded_processes_release_their_ids(mut server: Server, #[case] tty: bool) {
    let request = params("discarded", &["cat"], tty, true);
    server.exec(&request).unwrap();
    assert_eq!(server.discard("discarded").unwrap()["removed"], true);
    assert_eq!(server.discard("discarded").unwrap()["removed"], false);
    assert_eq!(
        server.write("discarded", b"unreachable").unwrap()["status"],
        "unknown_process"
    );
    server.exec(&request).unwrap();
    assert_eq!(server.discard("discarded").unwrap()["removed"], true);
}

#[rstest::rstest]
#[case(false)]
#[case(true)]
fn termination_closes_all_streams_and_allows_reuse(mut server: Server, #[case] tty: bool) {
    let request = params(
        "reused",
        &["sh", "-c", "cat; printf unreachable"],
        tty,
        true,
    );
    server.exec(&request).unwrap();
    assert!(
        server.exec(&request).is_err(),
        "duplicate ids must not replace a process"
    );
    assert!(
        server.reap("reused").is_err(),
        "a running process must not be removed"
    );
    assert_eq!(server.terminate("reused").unwrap()["running"], true);
    let (_, exit_code) = collect_until_exit(&server, "reused", None);
    assert_ne!(exit_code, 0);
    assert_eq!(server.terminate("reused").unwrap()["running"], false);
    assert_eq!(server.reap("reused").unwrap()["removed"], true);
    server.exec(&request).unwrap();
    server.shutdown();
    assert_eq!(
        server.write("reused", b"hello").unwrap()["status"],
        "unknown_process"
    );
}
