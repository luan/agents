use rusqlite::Connection;
use serde_json::{Value, json};
use std::io::Write;
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

fn call(request: Value) -> Value {
    let mut child = Command::new(env!("CARGO_BIN_EXE_context-guard"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn context-guard");
    child
        .stdin
        .as_mut()
        .expect("stdin")
        .write_all(request.to_string().as_bytes())
        .expect("write request");
    let output = child.wait_with_output().expect("read response");
    serde_json::from_slice(&output.stdout).expect("response JSON")
}

fn payload(response: &Value) -> Value {
    serde_json::from_str(
        response["content"][0]["text"]
            .as_str()
            .expect("response text"),
    )
    .expect("nested JSON")
}

fn db_path(name: &str) -> String {
    std::env::temp_dir()
        .join(format!(
            "context-guard-v2-{name}-{}.sqlite",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time")
                .as_nanos()
        ))
        .to_string_lossy()
        .into_owned()
}

fn capture(db_path: &str, session_id: &str, output: &str) -> Value {
    capture_with(
        db_path,
        session_id,
        "command",
        "tool executed",
        output,
        0,
        "exited",
    )
}

fn capture_with(
    db_path: &str,
    session_id: &str,
    source_kind: &str,
    label: &str,
    output: &str,
    exit_code: i64,
    terminal_state: &str,
) -> Value {
    payload(&call(json!({
        "command": "capture",
        "params": {
            "dbPath": db_path,
            "projectDir": "/project",
            "sessionId": session_id,
            "sourceKind": source_kind,
            "label": label,
            "metadata": { "test": true },
            "originalCommand": label,
            "executedCommand": label,
            "cwd": "/project",
            "output": output,
            "exitCode": exit_code,
            "terminalState": terminal_state
        }
    })))
}

#[test]
fn large_success_returns_notice_and_final_twenty_lines() {
    let db = db_path("success-preview");
    let output = (0..100)
        .map(|index| format!("line-{index}"))
        .collect::<Vec<_>>()
        .join("\n")
        + &"x".repeat(10_000);
    let result = capture(&db, "one", &output);
    let preview = result["preview"].as_str().expect("preview");

    assert!(preview.len() <= 8_192);
    assert!(preview.starts_with("Captured "));
    assert!(preview.contains("artifact"));
    assert!(preview.contains("final 20 lines"));
    assert!(result["omittedBytes"].as_u64().expect("omitted") > 0);
}

#[test]
fn failed_command_prioritizes_diagnostic_tail() {
    let db = db_path("failure-preview");
    let output = format!("{}\nFATAL-DIAGNOSTIC", "noise".repeat(3_000));
    let result = capture_with(&db, "one", "command", "bad", &output, 1, "exited");
    let preview = result["preview"].as_str().expect("preview");

    assert!(preview.contains("diagnostic tail"));
    assert!(preview.ends_with("FATAL-DIAGNOSTIC"));
}

#[test]
fn search_reads_full_output_and_filters_artifact() {
    let db = db_path("search");
    let first = format!("begin\n{}\nneedle-after-preview\n", "x".repeat(10_000));
    let first_capture = capture(&db, "one", &first);
    capture(&db, "two", "different needle");

    let result = payload(&call(json!({
        "command": "search",
        "params": {
            "dbPath": db,
            "artifactId": first_capture["artifactId"],
            "query": "needle-after-preview"
        }
    })));
    let results = result["results"].as_array().expect("results");
    assert_eq!(results.len(), 1);
    assert_eq!(results[0]["label"], "tool executed");
    assert!(
        results[0]["snippet"]
            .as_str()
            .expect("snippet")
            .contains("needle-after-preview")
    );
}

#[test]
fn artifact_only_search_returns_ordered_chunks() {
    let db = db_path("artifact-read");
    let result = capture(&db, "one", &format!("head\n{}\ntail", "x".repeat(20_000)));
    let search = payload(&call(json!({
        "command": "search",
        "params": { "dbPath": db, "artifactId": result["artifactId"], "limit": 10 }
    })));
    let chunks = search["results"].as_array().expect("chunks");
    assert!(chunks.len() > 1);
    assert_eq!(chunks[0]["chunkIndex"], 0);
}

#[test]
fn artifact_only_search_pages_past_fifty_chunks() {
    let db = db_path("artifact-pagination");
    let result = capture(&db, "one", &"x".repeat(450_000));
    let first = payload(&call(json!({
        "command": "search",
        "params": { "dbPath": db, "artifactId": result["artifactId"], "limit": 50 }
    })));
    let second = payload(&call(json!({
        "command": "search",
        "params": { "dbPath": db, "artifactId": result["artifactId"], "limit": 50, "offset": 50 }
    })));
    let first_chunks = first["results"].as_array().expect("first page");
    let second_chunks = second["results"].as_array().expect("second page");

    assert_eq!(first_chunks.len(), 50);
    assert_eq!(first_chunks[0]["chunkIndex"], 0);
    assert!(!second_chunks.is_empty());
    assert_eq!(second_chunks[0]["chunkIndex"], 50);
}

#[test]
fn repeated_labels_and_content_do_not_overwrite_captures() {
    let db = db_path("dedup");
    capture(&db, "one", "same output");
    capture(&db, "two", "same output");
    let status = payload(&call(
        json!({ "command": "status", "params": { "dbPath": db } }),
    ));

    assert_eq!(status["artifacts"], 1);
    assert_eq!(status["captures"], 2);
    assert_eq!(status["captureCalls"], 2);
}

#[test]
fn status_reports_bytes_latency_storage_and_source_counts() {
    let db = db_path("status");
    capture(&db, "one", &"z".repeat(9_000));
    capture_with(&db, "one", "eval", "cell", "displayed", 0, "exited");
    payload(&call(json!({
        "command": "search",
        "params": { "dbPath": db, "query": "displayed" }
    })));
    payload(&call(json!({
        "command": "record_failure",
        "params": { "dbPath": db, "operation": "capture" }
    })));

    let status = payload(&call(
        json!({ "command": "status", "params": { "dbPath": db } }),
    ));
    assert_eq!(status["captures"], 2);
    assert_eq!(status["bySourceKind"]["command"], 1);
    assert_eq!(status["bySourceKind"]["eval"], 1);
    assert_eq!(status["captureFailures"], 1);
    assert!(status["capturedBytes"].as_i64().expect("captured") >= 9_009);
    assert!(status["omittedBytes"].as_i64().expect("omitted") > 0);
    assert!(
        status["searchReturnedBytes"]
            .as_i64()
            .expect("search bytes")
            > 0
    );
    assert!(status["databaseBytes"].as_u64().expect("database bytes") > 0);
    assert_eq!(status["retentionDays"], 90);
    assert_eq!(status["retentionBytes"], 1_073_741_824_i64);
}

#[test]
fn capture_prunes_old_captures_and_orphans() {
    let db = db_path("age-retention");
    capture(&db, "old", "old output");
    let conn = Connection::open(&db).expect("open db");
    conn.execute(
        "UPDATE captures SET started_at = '2000-01-01T00:00:00Z'",
        [],
    )
    .expect("age capture");
    drop(conn);

    capture(&db, "new", "new output");
    let status = payload(&call(
        json!({ "command": "status", "params": { "dbPath": db } }),
    ));
    assert_eq!(status["captures"], 1);
    assert_eq!(status["artifacts"], 1);
}

#[test]
fn capture_prunes_to_storage_limit() {
    let db = db_path("size-retention");
    capture(&db, "old", "old output");
    let conn = Connection::open(&db).expect("open db");
    conn.execute("UPDATE artifacts SET byte_count = 2000000000", [])
        .expect("inflate artifact");
    drop(conn);

    capture(&db, "new", "new output");
    let status = payload(&call(
        json!({ "command": "status", "params": { "dbPath": db } }),
    ));
    assert_eq!(status["captures"], 1);
    assert_eq!(status["indexedBytes"], 10);
}

#[test]
fn session_purge_removes_only_target_session() {
    let db = db_path("purge-session");
    capture(&db, "one", "one output");
    capture(&db, "two", "two output");
    let purged = payload(&call(json!({
        "command": "purge",
        "params": { "dbPath": db, "confirm": true, "scope": "session", "sessionId": "one" }
    })));
    assert_eq!(purged["deleted"], 1);
    let status = payload(&call(
        json!({ "command": "status", "params": { "dbPath": db } }),
    ));
    assert_eq!(status["captures"], 1);
}

#[test]
fn project_purge_removes_store_files() {
    let db = db_path("purge-project");
    capture(&db, "one", "output");
    let purged = payload(&call(json!({
        "command": "purge",
        "params": { "dbPath": db, "confirm": true, "scope": "project" }
    })));
    assert_eq!(purged["purged"], true);
    assert!(!std::path::Path::new(&db).exists());
}
