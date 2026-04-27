//! CLI contract baseline — locks the stdout/file shape of `ct vault create`.
//! If a future change alters the exposed contract these tests must fail loudly.

use std::fs;
use std::path::Path;
use std::process::Command as StdCommand;

use assert_cmd::Command;
use predicates::prelude::*;
use tempfile::TempDir;

/// Set up a blueprints vault with a remote so `commit_and_push` succeeds.
/// Returns `(blueprints, bare_remote)` — both must outlive the test.
fn setup_blueprints() -> (TempDir, TempDir) {
    let bp = tempfile::tempdir().expect("create blueprints tempdir");
    let remote = tempfile::tempdir().expect("create remote tempdir");

    run_git(remote.path(), &["init", "--bare", "--initial-branch=main"]);

    run_git(bp.path(), &["init", "--initial-branch=main"]);
    run_git(bp.path(), &["config", "user.name", "ct-test"]);
    run_git(bp.path(), &["config", "user.email", "ct-test@example.com"]);
    run_git(bp.path(), &["config", "commit.gpgsign", "false"]);

    // Seed an initial commit so HEAD exists before push.
    fs::write(bp.path().join(".gitkeep"), "").expect("write .gitkeep");
    run_git(bp.path(), &["add", ".gitkeep"]);
    run_git(bp.path(), &["commit", "-m", "init"]);

    let remote_url = remote.path().to_string_lossy().to_string();
    run_git(bp.path(), &["remote", "add", "origin", &remote_url]);
    run_git(bp.path(), &["push", "-u", "origin", "main"]);

    (bp, remote)
}

fn run_git(cwd: &Path, args: &[&str]) {
    let status = StdCommand::new("git")
        .current_dir(cwd)
        .args(args)
        .env("GIT_AUTHOR_NAME", "ct-test")
        .env("GIT_AUTHOR_EMAIL", "ct-test@example.com")
        .env("GIT_COMMITTER_NAME", "ct-test")
        .env("GIT_COMMITTER_EMAIL", "ct-test@example.com")
        .status()
        .unwrap_or_else(|e| panic!("git {args:?} failed to spawn: {e}"));
    assert!(status.success(), "git {args:?} exited {status}");
}

/// Build a `ct` command wired to the test vault with deterministic git identity.
fn ct_cmd(bp: &Path) -> Command {
    let mut cmd = Command::cargo_bin("ct").expect("locate ct binary");
    cmd.env("CT_BLUEPRINTS_DIR", bp)
        .env("GIT_AUTHOR_NAME", "ct-test")
        .env("GIT_AUTHOR_EMAIL", "ct-test@example.com")
        .env("GIT_COMMITTER_NAME", "ct-test")
        .env("GIT_COMMITTER_EMAIL", "ct-test@example.com");
    cmd
}

/// Make a throwaway project directory — project_name() uses the last path
/// component, so the tempdir name becomes the project slug in the vault.
fn project_dir() -> TempDir {
    tempfile::tempdir().expect("create project tempdir")
}

#[test]
fn spec_create_prints_absolute_path_then_newline() {
    let (bp, _remote) = setup_blueprints();
    let project = project_dir();

    let assert = ct_cmd(bp.path())
        .args([
            "vault",
            "create",
            "-t",
            "spec",
            "--topic",
            "test-contract",
            "--project",
            &project.path().to_string_lossy(),
        ])
        .assert()
        .success();

    let stdout = String::from_utf8(assert.get_output().stdout.clone()).expect("stdout utf8");
    assert!(
        stdout.ends_with('\n'),
        "stdout must end with newline, got {stdout:?}"
    );
    let path_str = stdout.trim_end_matches('\n');
    assert!(
        !path_str.contains('\n'),
        "stdout must be exactly one line, got {stdout:?}"
    );

    let path = Path::new(path_str);
    assert!(path.is_absolute(), "path {path_str} must be absolute");
    assert!(path.exists(), "created file {path_str} must exist");

    // Strict equality — no ANSI, no extra lines, nothing but `<path>\n`.
    let expected = format!("{path_str}\n");
    assert!(
        predicate::eq(expected).eval(&stdout),
        "stdout must exactly equal <path>\\n, got {stdout:?}"
    );

    let content = fs::read_to_string(path).expect("read created file");
    assert!(
        content.starts_with("---\ntopic: test-contract\n"),
        "file must start with frontmatter opening, got:\n{content}"
    );
}

#[test]
fn plan_create_with_source_includes_wiki_link() {
    let (bp, _remote) = setup_blueprints();
    let project = project_dir();

    let assert = ct_cmd(bp.path())
        .args([
            "vault",
            "create",
            "-t",
            "plan",
            "--topic",
            "child",
            "--source",
            "my-spec-stem",
            "--project",
            &project.path().to_string_lossy(),
        ])
        .assert()
        .success();

    let stdout = String::from_utf8(assert.get_output().stdout.clone()).expect("stdout utf8");
    let path_str = stdout.trim_end_matches('\n');
    let content = fs::read_to_string(path_str).expect("read created file");

    assert!(
        content.contains("source: \"[[my-spec-stem]]\""),
        "frontmatter must wiki-link the source, got:\n{content}"
    );
}

#[test]
fn create_writes_frontmatter_only_body() {
    let (bp, _remote) = setup_blueprints();
    let project = project_dir();

    let assert = ct_cmd(bp.path())
        .args([
            "vault",
            "create",
            "-t",
            "spec",
            "--topic",
            "no-body-here",
            "--project",
            &project.path().to_string_lossy(),
        ])
        // Force stdin to be a non-tty empty pipe — otherwise ct reads stdin.
        .write_stdin("")
        .assert()
        .success();

    let stdout = String::from_utf8(assert.get_output().stdout.clone()).expect("stdout utf8");
    let path_str = stdout.trim_end_matches('\n');
    let content = fs::read_to_string(path_str).expect("read created file");

    // Frontmatter only: file opens with `---\n`, has exactly one closing
    // `---\n` delimiter, and nothing after. (The literal spec regex
    // `^---\n[^-]*\n---\n$` rejects real frontmatter — `created: 2026-04-16`
    // and tag lines contain `-` — so we encode the underlying intent.)
    assert!(
        content.starts_with("---\n"),
        "must open with frontmatter delimiter, got:\n{content}"
    );
    assert!(
        content.ends_with("\n---\n"),
        "must end with frontmatter close and nothing after, got:\n{content}"
    );
    let close_count = content.match_indices("\n---\n").count();
    assert_eq!(
        close_count, 1,
        "expected exactly one frontmatter close, got {close_count}:\n{content}"
    );
}

#[test]
fn ast_replace_apply_routes_through_lens_patch_draft() {
    if StdCommand::new("sg").arg("--version").output().is_err() {
        return;
    }
    let (bp, _remote) = setup_blueprints();
    let project = project_dir();
    let state = tempfile::tempdir().expect("state dir");
    run_git(project.path(), &["init", "--initial-branch=main"]);
    fs::write(
        project.path().join("main.rs"),
        "fn main() {\n    let value = 1;\n}\n",
    )
    .expect("write source");

    ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .args([
            "ast",
            "replace",
            "--lang",
            "rust",
            "--pattern",
            "let $A = 1",
            "--rewrite",
            "let $A = 2",
            "--path",
            "main.rs",
            "--apply",
            "--json",
        ])
        .assert()
        .success()
        .stdout(predicate::str::contains("\"apply\": true"));

    let source = fs::read_to_string(project.path().join("main.rs")).expect("read source");
    assert!(source.contains("let value = 2;"));

    ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .args(["lens", "status", "--json"])
        .assert()
        .success()
        .stdout(predicate::str::contains("\"patch_drafts\": 1"));
}

#[test]
fn lens_status_json_is_schema_versioned_and_compact() {
    let (bp, _remote) = setup_blueprints();
    let project = project_dir();
    let state = tempfile::tempdir().expect("state dir");

    let assert = ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .env("XDG_CONFIG_HOME", state.path())
        .args(["lens", "status", "--json"])
        .assert()
        .success();
    let stdout = String::from_utf8(assert.get_output().stdout.clone()).expect("stdout utf8");
    let value: serde_json::Value = serde_json::from_str(&stdout).expect("status json");

    assert_eq!(value["schema_version"], "lens.response.v1");
    assert!(value["warnings"].is_array());
    assert!(value["errors"].is_array());
    assert_eq!(value["data"]["policy"]["policy"]["guard"]["mode"], "block");
    assert_eq!(value["data"]["state"]["stored_outside_repository"], true);
    assert!(value.get("debug").is_none());
    assert!(value.get("raw").is_none());

    let assert = ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .env("XDG_CONFIG_HOME", state.path())
        .args(["lens", "status", "--json", "--debug", "--raw"])
        .assert()
        .success();
    let stdout = String::from_utf8(assert.get_output().stdout.clone()).expect("stdout utf8");
    let value: serde_json::Value = serde_json::from_str(&stdout).expect("expanded status json");
    assert!(value.get("debug").is_some());
    assert!(value.get("raw").is_some());
}

#[test]
fn lens_prune_dry_run_uses_response_envelope() {
    let (bp, _remote) = setup_blueprints();
    let project = project_dir();
    let state = tempfile::tempdir().expect("state dir");

    let assert = ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .env("XDG_CONFIG_HOME", state.path())
        .args(["lens", "prune", "--dry-run", "--json"])
        .assert()
        .success();
    let stdout = String::from_utf8(assert.get_output().stdout.clone()).expect("stdout utf8");
    let value: serde_json::Value = serde_json::from_str(&stdout).expect("prune json");

    assert_eq!(value["schema_version"], "lens.response.v1");
    assert_eq!(value["data"]["dry_run"], true);
}

#[test]
fn lens_discover_symbol_json_is_compact_and_records_coverage() {
    let (bp, _remote) = setup_blueprints();
    let project = project_dir();
    let state = tempfile::tempdir().expect("state dir");
    fs::write(
        project.path().join("lib.rs"),
        "fn target() {\n    println!(\"hi\");\n}\n",
    )
    .expect("write source");

    let assert = ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .env("XDG_CACHE_HOME", state.path())
        .args([
            "lens",
            "discover",
            "--intent",
            "symbol",
            "--query",
            "target",
            "--session",
            "cli",
            "--json",
        ])
        .assert()
        .success();
    let stdout = String::from_utf8(assert.get_output().stdout.clone()).expect("stdout utf8");
    let value: serde_json::Value = serde_json::from_str(&stdout).expect("discover json");

    assert_eq!(value["schema_version"], "lens.response.v1");
    assert_eq!(value["data"]["route"]["backend"], "sym");
    assert_eq!(value["data"]["items"][0]["path"], "lib.rs");
    assert!(value["data"]["items"][0].get("file").is_none());
    assert!(!value["data"]["next_actions"].as_array().unwrap().is_empty());
    assert!(value.get("debug").is_none());
    assert!(value.get("raw").is_none());

    ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .args([
            "lens",
            "guard",
            "check",
            "--path",
            "lib.rs",
            "--start-line",
            "1",
            "--end-line",
            "1",
            "--session",
            "cli",
            "--json",
        ])
        .assert()
        .success()
        .stdout(predicate::str::contains("\"reason\": \"covered\""));
}

#[test]
fn lens_turn_touched_json_is_schema_versioned_and_stable() {
    let (bp, _remote) = setup_blueprints();
    let project = project_dir();
    let state = tempfile::tempdir().expect("state dir");
    fs::write(project.path().join("main.rs"), "fn main() {}\n").expect("write source");
    let event = serde_json::json!({
        "schema_version": "lens.turn_event.v1",
        "session": "cli-session",
        "turn": "turn-1",
        "host": "contract-test",
        "cwd": project.path().to_string_lossy(),
        "event": "tool_end",
        "tool": "edit",
        "phase": "post_tool",
        "status": "success",
        "files": [{
            "path": "main.rs",
            "operation": "modify",
            "generated": false,
            "include_ignored": false
        }],
        "policy": {"git_fallback": true, "include_ignored": false}
    });

    ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .args(["lens", "turn", "record", "--json"])
        .write_stdin(event.to_string())
        .assert()
        .success()
        .stdout(predicate::str::contains("\"git_fallback_used\": false"));

    let assert = ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .args([
            "lens",
            "turn",
            "touched",
            "--session",
            "cli-session",
            "--turn",
            "turn-1",
            "--json",
        ])
        .assert()
        .success();
    let stdout = String::from_utf8(assert.get_output().stdout.clone()).expect("stdout utf8");
    let value: serde_json::Value = serde_json::from_str(&stdout).expect("touched json");

    assert_eq!(value["schema_version"], "lens.response.v1");
    assert_eq!(value["data"]["session"], "cli-session");
    assert_eq!(value["data"]["turn"], "turn-1");
    assert_eq!(value["data"]["file_count"], 1);
    assert_eq!(value["data"]["files"][0]["path"], "main.rs");
    assert_eq!(value["data"]["files"][0]["operation"], "modify");
    assert_eq!(value["data"]["files"][0]["tool"], "edit");
    assert_eq!(value["data"]["files"][0]["source"], "structured_event");
    assert_eq!(value["data"]["files"][0]["explicit"], true);
    assert_eq!(value["data"]["files"][0]["ignored"], false);
    assert_eq!(value["data"]["files"][0]["generated"], false);
    assert!(value.get("debug").is_none());
    assert!(value.get("raw").is_none());
}

#[test]
fn lens_health_context_report_and_final_outputs_are_schema_versioned() {
    let (bp, _remote) = setup_blueprints();
    let project = project_dir();
    let state = tempfile::tempdir().expect("state dir");
    fs::write(project.path().join("main.rs"), "fn main() {}\n").expect("write source");
    let event = serde_json::json!({
        "schema_version": "lens.turn_event.v1",
        "session": "health-cli",
        "turn": "turn-health",
        "host": "contract-test",
        "cwd": project.path().to_string_lossy(),
        "event": "tool_end",
        "tool": "edit",
        "phase": "post_tool",
        "status": "success",
        "files": [{"path": "main.rs", "operation": "modify"}],
        "policy": {"git_fallback": false, "include_ignored": false}
    });

    ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .env("XDG_CONFIG_HOME", state.path())
        .args(["lens", "turn", "record", "--json"])
        .write_stdin(event.to_string())
        .assert()
        .success();

    let assert = ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .env("XDG_CONFIG_HOME", state.path())
        .args([
            "lens",
            "health",
            "--session",
            "health-cli",
            "--turn",
            "turn-health",
            "--json",
        ])
        .assert()
        .success();
    let stdout = String::from_utf8(assert.get_output().stdout.clone()).expect("stdout utf8");
    let value: serde_json::Value = serde_json::from_str(&stdout).expect("health json");
    assert_eq!(value["schema_version"], "lens.response.v1");
    assert_eq!(value["data"]["status"], "clean");
    assert_eq!(value["data"]["action_context"]["required"], false);
    assert!(value["data"]["compact"].as_str().unwrap().contains("clean"));

    ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .env("XDG_CONFIG_HOME", state.path())
        .args([
            "lens",
            "report",
            "--session",
            "health-cli",
            "--turn",
            "turn-health",
            "--path",
            "main.rs",
            "--json",
        ])
        .assert()
        .success()
        .stdout(predicate::str::contains("symbol_context"))
        .stdout(predicate::str::contains("next_actions"));

    ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .env("XDG_CONFIG_HOME", state.path())
        .args([
            "lens",
            "context",
            "--session",
            "health-cli",
            "--turn",
            "turn-health",
            "--ack",
            "--json",
        ])
        .assert()
        .success()
        .stdout(predicate::str::contains("\"state\": \"clear\""));

    ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .env("XDG_CONFIG_HOME", state.path())
        .args([
            "lens",
            "health",
            "--session",
            "health-cli",
            "--turn",
            "turn-health",
            "--final-output",
        ])
        .assert()
        .success()
        .stdout(predicate::str::contains("Lens final health: clean"));
}

#[test]
fn lens_turn_end_runs_safe_cleanup_for_changed_files() {
    let (bp, _remote) = setup_blueprints();
    let project = project_dir();
    let state = tempfile::tempdir().expect("state dir");
    fs::write(project.path().join("main.fixture"), "one\n").expect("write source");
    fs::write(project.path().join("other.fixture"), "other\n").expect("write other");
    run_git(project.path(), &["init", "--initial-branch=main"]);
    let registry = serde_json::json!({
        "tools": [{
            "id": "fixture-format",
            "command": "sh",
            "args": ["-c", "for f do printf 'cleaned:%s\\n' \"$f\" >> \"$f\"; done", "fixture", "{files}"],
            "extensions": ["fixture"],
            "filenames": [],
            "safety": "safe_auto_apply",
            "mutability": "mutates",
            "timeout_ms": 5000,
            "parser": "line_diagnostics",
            "raw_output_max_bytes": 128,
            "purpose": "fixture formatter",
            "install_hint": "fixture"
        }]
    });
    let event = serde_json::json!({
        "schema_version": "lens.turn_event.v1",
        "session": "cleanup-cli",
        "turn": "turn-cleanup",
        "host": "contract-test",
        "cwd": project.path().to_string_lossy(),
        "event": "turn_end",
        "tool": "agent",
        "phase": "post_tool",
        "status": "success",
        "files": [{"path": "main.fixture", "operation": "modify"}],
        "policy": {"git_fallback": false, "include_ignored": false}
    });

    let assert = ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .env("CT_LENS_CLEANUP_REGISTRY", registry.to_string())
        .args(["lens", "turn", "record", "--json"])
        .write_stdin(event.to_string())
        .assert()
        .success();
    let stdout = String::from_utf8(assert.get_output().stdout.clone()).expect("stdout utf8");
    let value: serde_json::Value = serde_json::from_str(&stdout).expect("turn cleanup json");

    assert_eq!(value["schema_version"], "lens.response.v1");
    assert_eq!(
        value["data"]["cleanup"]["runs"][0]["tool"],
        "fixture-format"
    );
    assert_eq!(value["data"]["cleanup"]["mutation_count"], 1);
    assert!(
        fs::read_to_string(project.path().join("main.fixture"))
            .unwrap()
            .contains("cleaned:main.fixture")
    );
    assert!(
        !fs::read_to_string(project.path().join("other.fixture"))
            .unwrap()
            .contains("cleaned")
    );
}

#[test]
fn lens_diagnostics_record_and_list_round_trip() {
    let (bp, _remote) = setup_blueprints();
    let project = project_dir();
    let state = tempfile::tempdir().expect("state dir");
    fs::write(project.path().join("main.rs"), "fn main() {}\n").expect("write source");

    ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .args([
            "lens",
            "diagnostics",
            "record",
            "--source",
            "test",
            "--severity",
            "warning",
            "--path",
            "main.rs",
            "--message",
            "watch this",
            "--start-line",
            "1",
            "--end-line",
            "1",
            "--json",
        ])
        .assert()
        .success()
        .stdout(predicate::str::contains("\"recorded\": true"));

    ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .args(["lens", "diagnostics", "list", "--path", "main.rs", "--json"])
        .assert()
        .success()
        .stdout(predicate::str::contains("watch this"))
        .stdout(predicate::str::contains("\"diagnostic_count\": 1"));
}

#[test]
fn lens_diagnostics_snapshot_reports_deltas_and_all_flag() {
    let (bp, _remote) = setup_blueprints();
    let project = project_dir();
    let state = tempfile::tempdir().expect("state dir");
    fs::write(project.path().join("main.rs"), "fn main() {}\n").expect("write source");
    let first = serde_json::json!({
        "source": "test",
        "scope": {"kind": "command", "key": "cargo test"},
        "diagnostics": [{
            "source": "test",
            "scope": {"kind": "command", "key": "cargo test"},
            "severity": "warning",
            "message": "kept",
            "rel_path": "main.rs",
            "start_line": 1,
            "end_line": 1,
            "fingerprint": "kept",
            "content_hash": null
        }, {
            "source": "test",
            "scope": {"kind": "command", "key": "cargo test"},
            "severity": "error",
            "message": "gone",
            "rel_path": "main.rs",
            "start_line": 1,
            "end_line": 1,
            "fingerprint": "gone",
            "content_hash": null
        }],
        "raw_output": "token=secret-value\ncompiler output",
        "metadata": {"command": "cargo test", "exit_code": 1}
    });
    ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .args(["lens", "diagnostics", "snapshot", "--json"])
        .write_stdin(first.to_string())
        .assert()
        .success()
        .stdout(predicate::str::contains("\"redacted\": true"));

    let second = serde_json::json!({
        "source": "test",
        "scope": {"kind": "command", "key": "cargo test"},
        "diagnostics": [{
            "source": "test",
            "scope": {"kind": "command", "key": "cargo test"},
            "severity": "warning",
            "message": "kept",
            "rel_path": "main.rs",
            "start_line": 1,
            "end_line": 1,
            "fingerprint": "kept",
            "content_hash": null
        }, {
            "source": "test",
            "scope": {"kind": "command", "key": "cargo test"},
            "severity": "warning",
            "message": "new",
            "rel_path": "main.rs",
            "start_line": 1,
            "end_line": 1,
            "fingerprint": "new",
            "content_hash": null
        }],
        "metadata": {"command": "cargo test", "exit_code": 1}
    });
    let assert = ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .args(["lens", "diagnostics", "snapshot", "--json"])
        .write_stdin(second.to_string())
        .assert()
        .success();
    let stdout = String::from_utf8(assert.get_output().stdout.clone()).expect("stdout utf8");
    let value: serde_json::Value = serde_json::from_str(&stdout).expect("snapshot json");
    assert_eq!(value["schema_version"], "lens.response.v1");
    assert_eq!(value["data"]["deltas"]["new"].as_array().unwrap().len(), 1);
    assert_eq!(
        value["data"]["deltas"]["resolved"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        value["data"]["deltas"]["unchanged"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    let assert = ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .args(["lens", "diagnostics", "list", "--all", "--json"])
        .assert()
        .success();
    let stdout = String::from_utf8(assert.get_output().stdout.clone()).expect("stdout utf8");
    let value: serde_json::Value = serde_json::from_str(&stdout).expect("list json");
    assert_eq!(value["data"]["diagnostic_count"], 2);
    assert_eq!(value["data"]["relevance"]["all"], true);
    assert_eq!(
        value["data"]["deltas"]["resolved"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn apply_patch_failure_creates_draft_and_patch_telemetry_not_lens_diagnostic() {
    let (bp, _remote) = setup_blueprints();
    let project = project_dir();
    let state = tempfile::tempdir().expect("state dir");
    let data = tempfile::tempdir().expect("data dir");
    fs::write(project.path().join("dup.rs"), "foo\nbar\nfoo\nbar\n").expect("write source");
    let patch = "\
*** Begin Patch
*** Update File: dup.rs
@@
-foo
+FOO
 bar
*** End Patch
";

    let assert = ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .env("XDG_DATA_HOME", data.path())
        .args(["tool", "apply-patch", "--cwd", "."])
        .write_stdin(patch)
        .assert()
        .failure();
    let stderr = String::from_utf8(assert.get_output().stderr.clone()).expect("stderr utf8");
    assert!(stderr.contains("repair: patch="), "stderr was: {stderr}");
    assert!(stderr.contains("diagnostic=apd-"), "stderr was: {stderr}");
    assert!(
        stderr.contains("kind=ambiguous_context"),
        "stderr was: {stderr}"
    );

    let status = ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .args(["lens", "status", "--json"])
        .assert()
        .success();
    let stdout = String::from_utf8(status.get_output().stdout.clone()).expect("status utf8");
    let value: serde_json::Value = serde_json::from_str(&stdout).expect("status json");
    assert_eq!(value["data"]["state"]["counts"]["patch_drafts"], 1);

    let list = ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .args(["lens", "diagnostics", "list", "--all", "--json"])
        .assert()
        .success();
    let stdout = String::from_utf8(list.get_output().stdout.clone()).expect("diagnostics utf8");
    let value: serde_json::Value = serde_json::from_str(&stdout).expect("diagnostics json");
    assert_eq!(value["data"]["diagnostic_count"], 0);

    let report = ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_DATA_HOME", data.path())
        .args(["apply-patch", "report", "--json"])
        .assert()
        .success();
    let stdout = String::from_utf8(report.get_output().stdout.clone()).expect("report utf8");
    let value: serde_json::Value = serde_json::from_str(&stdout).expect("report json");
    assert_eq!(value["diagnostics"].as_array().unwrap().len(), 1);
    let diagnostic_id = value["diagnostics"][0]["diagnostic_id"].as_str().unwrap();

    ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_DATA_HOME", data.path())
        .args(["apply-patch", "show", diagnostic_id])
        .assert()
        .success()
        .stdout(predicate::str::contains("apply-patch diagnostic"))
        .stdout(predicate::str::contains("ambiguous_context"));
}

#[test]
fn lens_guard_default_blocks_unread_code_and_allows_after_read() {
    let (bp, _remote) = setup_blueprints();
    let project = project_dir();
    let state = tempfile::tempdir().expect("state dir");
    fs::write(
        project.path().join("main.rs"),
        "fn main() {\n    println!(\"hi\");\n}\n",
    )
    .expect("write source");

    let assert = ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .env("XDG_CONFIG_HOME", state.path())
        .args([
            "lens",
            "guard",
            "check",
            "--path",
            "main.rs",
            "--start-line",
            "1",
            "--end-line",
            "1",
            "--session",
            "cli",
            "--json",
        ])
        .assert()
        .success();
    let stdout = String::from_utf8(assert.get_output().stdout.clone()).expect("stdout utf8");
    let value: serde_json::Value = serde_json::from_str(&stdout).expect("guard json");
    assert_eq!(value["schema_version"], "lens.response.v1");
    assert_eq!(value["status"], "error");
    assert_eq!(value["data"]["guard"]["decision"], "block");
    assert_eq!(value["data"]["guard"]["reason"], "zero_read");
    assert_eq!(value["data"]["guard"]["classification"]["kind"], "code");

    ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .env("XDG_CONFIG_HOME", state.path())
        .args([
            "lens",
            "read",
            "record",
            "--path",
            "main.rs",
            "--start-line",
            "1",
            "--end-line",
            "1",
            "--session",
            "cli",
            "--json",
        ])
        .assert()
        .success();

    ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .env("XDG_CONFIG_HOME", state.path())
        .args([
            "lens",
            "guard",
            "check",
            "--path",
            "main.rs",
            "--start-line",
            "1",
            "--end-line",
            "1",
            "--session",
            "cli",
            "--json",
        ])
        .assert()
        .success()
        .stdout(predicate::str::contains("\"decision\": \"allow\""))
        .stdout(predicate::str::contains("\"reason\": \"covered\""));
}

#[test]
fn lens_guard_has_no_default_public_override_path() {
    let (bp, _remote) = setup_blueprints();
    let project = project_dir();
    let state = tempfile::tempdir().expect("state dir");
    fs::write(project.path().join("main.rs"), "fn main() {}\n").expect("write source");

    ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .env("XDG_CONFIG_HOME", state.path())
        .args([
            "lens",
            "guard",
            "check",
            "--path",
            "main.rs",
            "--start-line",
            "1",
            "--end-line",
            "1",
            "--mode",
            "warn",
        ])
        .assert()
        .failure()
        .stderr(predicate::str::contains("allow_overrides is false"));

    ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .env("XDG_CONFIG_HOME", state.path())
        .args(["lens", "guard", "allow-once", "--path", "main.rs", "--json"])
        .assert()
        .failure()
        .stdout(predicate::str::contains("guard_overrides_disabled"));
}

#[test]
fn lens_checks_run_configured_fixture_and_records_snapshot() {
    let (bp, _remote) = setup_blueprints();
    let project = project_dir();
    let state = tempfile::tempdir().expect("state dir");
    fs::write(project.path().join("main.rs"), "fn main() {}\n").expect("write source");
    fs::create_dir_all(project.path().join(".ct")).expect("create config dir");
    fs::write(
        project.path().join("check.sh"),
        "#!/bin/sh\necho 'main.rs:1:error:fixture failed'\nexit 1\n",
    )
    .expect("write check script");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let script = project.path().join("check.sh");
        let mut perms = fs::metadata(&script)
            .expect("script metadata")
            .permissions();
        perms.set_mode(0o755);
        fs::set_permissions(script, perms).expect("chmod script");
    }
    fs::write(
        project.path().join(".ct/lens.json"),
        r#"{"checks":{"fixture":{"command":"./check.sh","automatic":true,"parser":"line","raw_output_max_bytes":128}}}"#,
    )
    .expect("write lens config");

    let assert = ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .args(["lens", "checks", "run", "--json"])
        .assert()
        .success();
    let stdout = String::from_utf8(assert.get_output().stdout.clone()).expect("stdout utf8");
    let value: serde_json::Value = serde_json::from_str(&stdout).expect("checks json");
    assert_eq!(value["schema_version"], "lens.response.v1");
    assert_eq!(value["status"], "warning");
    assert_eq!(value["data"]["runs"][0]["name"], "fixture");
    assert_eq!(value["data"]["runs"][0]["scope"]["kind"], "check");
    assert_eq!(value["data"]["runs"][0]["diagnostic_count"], 1);
    assert_eq!(
        value["data"]["runs"][0]["snapshot"]["raw_output"]["truncated"],
        false
    );

    ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .args(["lens", "diagnostics", "list", "--all", "--json"])
        .assert()
        .success()
        .stdout(predicate::str::contains("fixture failed"))
        .stdout(predicate::str::contains("\"kind\": \"check\""));
}

fn lens_hook_event(project: &Path, event: &str) -> serde_json::Value {
    serde_json::json!({
        "schema_version": "lens.hook_event.v1",
        "host": {"name": "codex", "kind": "non_pi", "version": "fixture"},
        "session": {"id": "hook-session", "seq": 1},
        "cwd": project.to_string_lossy(),
        "turn": {"id": "hook-turn", "index": 1},
        "event": event,
        "tool": {"name": "read", "status": "success"},
        "known_files": [{"path": "main.rs", "operation": "read", "start_line": 1, "end_line": 1}],
        "policy": {"git_fallback": false, "include_ignored": false, "run_cleanup": true, "run_checks": true}
    })
}

#[test]
fn lens_lifecycle_hooks_return_host_neutral_contracts() {
    let (bp, _remote) = setup_blueprints();
    let project = project_dir();
    let state = tempfile::tempdir().expect("state dir");
    fs::write(project.path().join("main.rs"), "fn main() {}\n").expect("write source");

    let cases = [
        ("lens-session-start", "session_start"),
        ("lens-turn-start", "turn_start"),
        ("lens-pre-tool", "pre_tool"),
        ("lens-post-tool", "post_tool"),
        ("lens-turn-end", "turn_end"),
        ("lens-context-injection", "context_injection"),
        ("lens-agent-end", "agent_end"),
        ("lens-session-shutdown", "session_shutdown"),
    ];

    for (command, event) in cases {
        let assert = ct_cmd(bp.path())
            .current_dir(project.path())
            .env("XDG_STATE_HOME", state.path())
            .env("XDG_CONFIG_HOME", state.path())
            .args(["hook", command])
            .write_stdin(lens_hook_event(project.path(), event).to_string())
            .assert()
            .success();
        let stdout = String::from_utf8(assert.get_output().stdout.clone()).expect("stdout utf8");
        let value: serde_json::Value = serde_json::from_str(&stdout).expect("hook json");
        assert_eq!(
            value["schema_version"], "lens.hook_response.v1",
            "{command}"
        );
        assert_eq!(value["host"]["name"], "codex", "{command}");
        assert_eq!(value["host"]["kind"], "non_pi", "{command}");
        assert_eq!(value["session"]["id"], "hook-session", "{command}");
        assert_eq!(value["turn"]["id"], "hook-turn", "{command}");
        assert_eq!(value["event"], event, "{command}");
        assert!(value["decision"]["outcome"].is_string(), "{command}");
        assert!(value["actions"].is_array(), "{command}");
        assert!(value["context"]["inject"].is_boolean(), "{command}");
        assert!(value["diagnostics"]["active"].is_number(), "{command}");
        assert!(value["health"]["status"].is_string(), "{command}");
        assert!(value["warnings"].is_array(), "{command}");
        assert!(value["errors"].is_array(), "{command}");
    }
}

#[test]
fn lens_pre_tool_hook_warns_on_unread_writes_with_advisory_guard() {
    let (bp, _remote) = setup_blueprints();
    let project = project_dir();
    let state = tempfile::tempdir().expect("state dir");
    fs::write(project.path().join("main.rs"), "fn main() {}\n").expect("write source");
    let mut event = lens_hook_event(project.path(), "pre_tool");
    event["tool"] = serde_json::json!({"name": "edit", "status": "pending"});
    event["known_files"] = serde_json::json!([{
        "path": "main.rs",
        "operation": "modify",
        "start_line": 1,
        "end_line": 1
    }]);
    event["policy"]["guard_mode"] = serde_json::json!("off");

    let assert = ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .env("XDG_CONFIG_HOME", state.path())
        .args(["hook", "lens-pre-tool"])
        .write_stdin(event.to_string())
        .assert()
        .success();
    let stdout = String::from_utf8(assert.get_output().stdout.clone()).expect("stdout utf8");
    let value: serde_json::Value = serde_json::from_str(&stdout).expect("pre-tool json");
    assert_eq!(value["schema_version"], "lens.hook_response.v1");
    assert_eq!(value["status"], "warning");
    assert_eq!(value["decision"]["outcome"], "warn");
    assert_eq!(value["decision"]["reason"], "guard_advisory");
    assert_eq!(value["decision"]["guard"][0]["decision"], "warn");
    assert_eq!(value["warnings"][0]["code"], "guard_advisory");
    assert!(value["errors"].as_array().unwrap().is_empty());
}

#[test]
fn lens_post_tool_hook_records_touched_files_reads_and_raw_output() {
    let (bp, _remote) = setup_blueprints();
    let project = project_dir();
    let state = tempfile::tempdir().expect("state dir");
    fs::write(project.path().join("main.rs"), "fn main() {}\n").expect("write source");
    let mut event = lens_hook_event(project.path(), "post_tool");
    event["tool"] = serde_json::json!({
        "name": "read",
        "status": "success",
        "raw_output": "token=secret-value\nread main.rs",
        "raw_output_max_bytes": 128
    });

    let assert = ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .env("XDG_CONFIG_HOME", state.path())
        .args(["hook", "lens-post-tool"])
        .write_stdin(event.to_string())
        .assert()
        .success();
    let stdout = String::from_utf8(assert.get_output().stdout.clone()).expect("stdout utf8");
    let value: serde_json::Value = serde_json::from_str(&stdout).expect("post-tool json");
    assert_eq!(value["schema_version"], "lens.hook_response.v1");
    assert_eq!(value["data"]["turn"]["file_count"], 1);
    assert_eq!(value["data"]["turn"]["files"][0]["operation"], "read");
    assert_eq!(value["data"]["raw_output"]["redacted"], true);

    ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .args([
            "lens",
            "guard",
            "check",
            "--path",
            "main.rs",
            "--start-line",
            "1",
            "--end-line",
            "1",
            "--session",
            "hook-session",
            "--json",
        ])
        .assert()
        .success()
        .stdout(predicate::str::contains("\"reason\": \"covered\""));
}

#[test]
fn lens_hook_reports_json_errors_for_malformed_and_unknown_schema() {
    let (bp, _remote) = setup_blueprints();
    let project = project_dir();
    let state = tempfile::tempdir().expect("state dir");

    let assert = ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .args(["hook", "lens-session-start"])
        .write_stdin("{not json")
        .assert()
        .failure();
    let stdout = String::from_utf8(assert.get_output().stdout.clone()).expect("stdout utf8");
    let value: serde_json::Value = serde_json::from_str(&stdout).expect("malformed json response");
    assert_eq!(value["schema_version"], "lens.hook_response.v1");
    assert_eq!(value["status"], "error");
    assert_eq!(value["errors"][0]["code"], "malformed_json");

    let bad_schema = serde_json::json!({
        "schema_version": "lens.hook_event.v0",
        "host": {"name": "opencode", "kind": "non_pi"},
        "session": {"id": "s"},
        "cwd": project.path().to_string_lossy(),
        "turn": {"id": "t"},
        "event": "session_start",
        "policy": {}
    });
    let assert = ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .args(["hook", "lens-session-start"])
        .write_stdin(bad_schema.to_string())
        .assert()
        .failure();
    let stdout = String::from_utf8(assert.get_output().stdout.clone()).expect("stdout utf8");
    let value: serde_json::Value = serde_json::from_str(&stdout).expect("unknown schema response");
    assert_eq!(value["schema_version"], "lens.hook_response.v1");
    assert_eq!(value["errors"][0]["code"], "unknown_schema");
}
