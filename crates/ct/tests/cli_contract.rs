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
            "dev",
            "debug",
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
        .args([
            "lens",
            "status",
            "--cwd",
            &project.path().to_string_lossy(),
            "--json",
            "--disk",
        ])
        .assert()
        .success();
    let stdout = String::from_utf8(assert.get_output().stdout.clone()).expect("stdout utf8");
    let value: serde_json::Value = serde_json::from_str(&stdout).expect("status json");

    assert_eq!(value["schema_version"], "lens.response.v1");
    assert!(value["warnings"].is_array());
    assert!(value["errors"].is_array());
    assert!(value["data"]["policy"]["policy"].get("guard").is_none());
    assert!(
        value["data"]["state"]["counts"]
            .get("read_events")
            .is_none()
    );
    assert!(
        value["data"]["state"]["counts"]
            .get("guard_overrides")
            .is_none()
    );
    assert_eq!(value["data"]["state"]["stored_outside_repository"], true);
    assert!(value["data"]["state"]["db_bytes"].is_number());
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
fn lens_prune_surface_is_removed() {
    let (bp, _remote) = setup_blueprints();
    let project = project_dir();

    ct_cmd(bp.path())
        .current_dir(project.path())
        .args(["lens", "prune", "--dry-run", "--json"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("unrecognized subcommand"));
}

#[test]
fn lens_removed_discover_read_guard_surfaces_fail() {
    let (bp, _remote) = setup_blueprints();
    let project = project_dir();

    for args in [
        vec!["lens", "discover", "--help"],
        vec!["lens", "read", "--help"],
        vec!["lens", "guard", "--help"],
        vec!["lens", "guard", "allow-once", "--path", "main.rs", "--json"],
        vec!["lens", "status", "--guard-mode", "warn", "--json"],
        vec!["lens", "turn", "record", "--json"],
        vec!["lens", "turn", "touched", "--session", "s", "--turn", "t"],
    ] {
        ct_cmd(bp.path())
            .current_dir(project.path())
            .args(args)
            .assert()
            .failure();
    }
}

#[test]
fn lens_touched_json_is_schema_versioned_and_stable() {
    let (bp, _remote) = setup_blueprints();
    let project = project_dir();
    let state = tempfile::tempdir().expect("state dir");
    fs::write(project.path().join("main.rs"), "fn main() {}\n").expect("write source");
    let event = serde_json::json!({
        "schema_version": "lens.hook_event.v1",
        "host": {"name": "contract-test", "kind": "test"},
        "session": {"id": "cli-session"},
        "cwd": project.path().to_string_lossy(),
        "turn": {"id": "turn-1"},
        "event": "post_tool",
        "tool": {"name": "edit", "status": "success"},
        "known_files": [{
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
        .args(["hook", "lens-post-tool"])
        .write_stdin(event.to_string())
        .assert()
        .success()
        .stdout(predicate::str::contains("\"source\": \"structured_event\""));

    let assert = ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .args([
            "lens",
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
fn lens_health_and_final_outputs_are_schema_versioned() {
    let (bp, _remote) = setup_blueprints();
    let project = project_dir();
    let state = tempfile::tempdir().expect("state dir");
    fs::write(project.path().join("main.rs"), "fn main() {}\n").expect("write source");
    let event = serde_json::json!({
        "schema_version": "lens.hook_event.v1",
        "host": {"name": "contract-test", "kind": "test"},
        "session": {"id": "health-cli"},
        "cwd": project.path().to_string_lossy(),
        "turn": {"id": "turn-health"},
        "event": "post_tool",
        "tool": {"name": "edit", "status": "success"},
        "known_files": [{"path": "main.rs", "operation": "modify"}],
        "policy": {"git_fallback": false, "include_ignored": false}
    });

    ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .env("XDG_CONFIG_HOME", state.path())
        .args(["hook", "lens-post-tool"])
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
    assert!(value["data"].get("action_context").is_none());
    assert!(value["data"]["compact"].as_str().unwrap().contains("clean"));
    assert_eq!(
        value["data"]["summary"]["validation_plan"]["turn_active"],
        true
    );
    assert!(value["data"]["summary"].get("cleanup").is_none());
    assert!(value["data"]["summary"].get("patch_refs").is_none());

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
        ])
        .assert()
        .failure()
        .stderr(predicate::str::contains("unrecognized subcommand"));

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
        ])
        .assert()
        .failure()
        .stderr(predicate::str::contains("unrecognized subcommand"));

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
fn lens_warning_context_stays_clear_and_report_uses_canonical_source_actions() {
    let (bp, _remote) = setup_blueprints();
    let project = project_dir();
    let state = tempfile::tempdir().expect("state dir");
    fs::write(project.path().join("main.rs"), "fn main() {}\n").expect("write source");
    let event = serde_json::json!({
        "schema_version": "lens.hook_event.v1",
        "host": {"name": "contract-test", "kind": "test"},
        "session": {"id": "warn-cli"},
        "cwd": project.path().to_string_lossy(),
        "turn": {"id": "turn-warning"},
        "event": "post_tool",
        "tool": {"name": "edit", "status": "success"},
        "known_files": [{"path": "main.rs", "operation": "modify"}],
        "policy": {"git_fallback": false, "include_ignored": false}
    });

    ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .args(["hook", "lens-post-tool"])
        .write_stdin(event.to_string())
        .assert()
        .success();

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
            "needs attention",
            "--start-line",
            "1",
            "--end-line",
            "1",
            "--json",
        ])
        .assert()
        .success();

    let injection = ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .args(["hook", "lens-context-injection"])
        .write_stdin(
            serde_json::json!({
                "schema_version": "lens.hook_event.v1",
                "host": {"name": "contract-test", "kind": "test"},
                "session": {"id": "warn-cli"},
                "cwd": project.path().to_string_lossy(),
                "turn": {"id": "turn-warning"},
                "event": "context_injection",
                "policy": {"git_fallback": false, "include_ignored": false}
            })
            .to_string(),
        )
        .assert()
        .success();
    let injection_value: serde_json::Value =
        serde_json::from_slice(&injection.get_output().stdout).expect("context injection json");
    assert_eq!(injection_value["context"]["inject"], false);

    ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .args([
            "lens",
            "context",
            "--session",
            "warn-cli",
            "--turn",
            "turn-warning",
        ])
        .assert()
        .failure()
        .stderr(predicate::str::contains("unrecognized subcommand"));

    ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .args([
            "lens",
            "report",
            "--session",
            "warn-cli",
            "--turn",
            "turn-warning",
        ])
        .assert()
        .failure()
        .stderr(predicate::str::contains("unrecognized subcommand"));

    let health = ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .args([
            "lens",
            "health",
            "--session",
            "warn-cli",
            "--turn",
            "turn-warning",
            "--json",
        ])
        .assert()
        .success();
    let health_value: serde_json::Value =
        serde_json::from_slice(&health.get_output().stdout).expect("health json");
    let health_text = health_value.to_string();
    assert_eq!(health_value["data"]["status"], "warnings");
    assert!(!health_text.contains("action_context"));
    assert!(!health_text.contains("cleanup"));
    assert!(!health_text.contains("patch_refs"));
    assert!(!health_text.contains("symbol"));
    assert!(!health_text.contains("raw_output_ref"));
}

#[test]
fn lens_turn_end_does_not_run_formatter_cleanup() {
    let (bp, _remote) = setup_blueprints();
    let project = project_dir();
    let state = tempfile::tempdir().expect("state dir");
    fs::write(project.path().join("main.fixture"), "one\n").expect("write source");
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
        "schema_version": "lens.hook_event.v1",
        "host": {"name": "contract-test", "kind": "test"},
        "session": {"id": "cleanup-cli"},
        "cwd": project.path().to_string_lossy(),
        "turn": {"id": "turn-cleanup"},
        "event": "turn_end",
        "tool": {"name": "agent", "status": "success"},
        "known_files": [{"path": "main.fixture", "operation": "modify"}],
        "policy": {"include_ignored": false}
    });

    let assert = ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .env("CT_LENS_CLEANUP_REGISTRY", registry.to_string())
        .args(["hook", "lens-turn-end"])
        .write_stdin(event.to_string())
        .assert()
        .success();
    let stdout = String::from_utf8(assert.get_output().stdout.clone()).expect("stdout utf8");
    let value: serde_json::Value = serde_json::from_str(&stdout).expect("turn cleanup json");

    assert_eq!(value["schema_version"], "lens.hook_response.v1");
    assert!(value["data"]["turn"].get("cleanup").is_none());
    assert!(
        !fs::read_to_string(project.path().join("main.fixture"))
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

    let assert = ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .args(["lens", "diagnostics", "list", "--path", "main.rs", "--json"])
        .assert()
        .success();
    let stdout = String::from_utf8(assert.get_output().stdout.clone()).expect("stdout utf8");
    let value: serde_json::Value = serde_json::from_str(&stdout).expect("diagnostics json");
    assert_eq!(value["data"]["diagnostic_count"], 1);
    assert_eq!(value["data"]["diagnostics"][0]["message"], "watch this");
    assert!(value["data"].get("read_files").is_none());
    assert!(value["data"].get("guard").is_none());
    assert!(value["data"]["relevance"].get("read_files").is_none());
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
    let _first_assert = ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .args(["lens", "diagnostics", "snapshot", "--json"])
        .write_stdin(first.to_string())
        .assert()
        .success()
        .stdout(predicate::str::contains("\"redacted\": true"));
    ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .args(["lens", "raw-output", "list", "--json"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("unrecognized subcommand"));

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
        .args(["apply-patch", "--cwd", "."])
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
        .args(["lens", "checks", "list", "--json"])
        .assert()
        .success();
    let stdout = String::from_utf8(assert.get_output().stdout.clone()).expect("stdout utf8");
    let value: serde_json::Value = serde_json::from_str(&stdout).expect("checks list json");
    assert_eq!(value["schema_version"], "lens.response.v1");
    assert_eq!(value["data"]["configured_checks"][0]["name"], "fixture");
    assert!(value["data"].get("read_files").is_none());
    assert!(value["data"].get("guard").is_none());

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

    let assert = ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .env("XDG_CONFIG_HOME", state.path())
        .args([
            "lens",
            "health",
            "--session",
            "checks-cli",
            "--turn",
            "turn-checks",
            "--json",
        ])
        .assert()
        .success();
    let stdout = String::from_utf8(assert.get_output().stdout.clone()).expect("health utf8");
    let value: serde_json::Value = serde_json::from_str(&stdout).expect("health json");
    assert_eq!(value["data"]["status"], "clean");
    assert!(value["data"].get("action_context").is_none());
    assert!(value["data"]["summary"].get("cleanup").is_none());
    assert!(value["data"]["summary"].get("patch_refs").is_none());
    assert!(
        value["data"]["summary"]["checks"]["latest"]
            .as_array()
            .unwrap()
            .len()
            > 0
    );
    assert!(value["data"]["summary"].get("read_files").is_none());
    assert!(value["data"]["summary"].get("guard").is_none());
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
fn lens_lifecycle_hooks_adapt_native_host_output() {
    let (bp, _remote) = setup_blueprints();
    let project = project_dir();
    let state = tempfile::tempdir().expect("state dir");

    let payload = serde_json::json!({
        "session_id": "native-session",
        "cwd": project.path().to_string_lossy(),
        "hook_event_name": "Stop"
    });
    let assert = ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .env("XDG_CONFIG_HOME", state.path())
        .env("CT_LENS_HOST", "claude-code")
        .args(["hook", "lens-turn-end"])
        .write_stdin(payload.to_string())
        .assert()
        .success();

    let stdout = String::from_utf8(assert.get_output().stdout.clone()).expect("stdout utf8");
    let value: serde_json::Value = serde_json::from_str(&stdout).expect("hook json");
    assert!(value.get("schema_version").is_none());
    assert_eq!(value["continue"], true);
    assert_eq!(value["suppressOutput"], true);
    assert!(value.get("decision").is_none());
}

#[test]
fn lens_lifecycle_hooks_omit_claude_only_output_for_codex() {
    let (bp, _remote) = setup_blueprints();
    let project = project_dir();
    let state = tempfile::tempdir().expect("state dir");

    let payload = serde_json::json!({
        "session_id": "native-session",
        "cwd": project.path().to_string_lossy(),
        "hook_event_name": "Stop"
    });
    let assert = ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .env("XDG_CONFIG_HOME", state.path())
        .env("CT_LENS_HOST", "codex")
        .args(["hook", "lens-turn-end"])
        .write_stdin(payload.to_string())
        .assert()
        .success();

    let stdout = String::from_utf8(assert.get_output().stdout.clone()).expect("stdout utf8");
    let value: serde_json::Value = serde_json::from_str(&stdout).expect("hook json");
    assert!(value.get("schema_version").is_none());
    assert_eq!(value["continue"], true);
    assert!(value.get("suppressOutput").is_none());
    assert!(value.get("decision").is_none());
}

#[test]
fn lens_pre_tool_hook_omits_claude_permission_allow_for_codex() {
    let (bp, _remote) = setup_blueprints();
    let project = project_dir();
    let state = tempfile::tempdir().expect("state dir");

    let payload = serde_json::json!({
        "session_id": "native-session",
        "cwd": project.path().to_string_lossy(),
        "hook_event_name": "PreToolUse",
        "tool_name": "Bash",
        "tool_input": {"command": "date"}
    });
    let assert = ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .env("XDG_CONFIG_HOME", state.path())
        .env("CT_LENS_HOST", "codex")
        .args(["hook", "lens-pre-tool"])
        .write_stdin(payload.to_string())
        .assert()
        .success();

    let stdout = String::from_utf8(assert.get_output().stdout.clone()).expect("stdout utf8");
    let value: serde_json::Value = serde_json::from_str(&stdout).expect("hook json");
    assert_eq!(value["continue"], true);
    assert!(value.get("hookSpecificOutput").is_none());
}

#[test]
fn lens_pre_tool_hook_records_without_guard_advisory() {
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
    assert_eq!(value["status"], "ok");
    assert_eq!(value["decision"]["outcome"], "allow");
    assert_eq!(value["decision"]["reason"], "tool_allowed");
    assert!(value["decision"].get("guard").is_none());
    assert!(value["warnings"].as_array().unwrap().is_empty());
    assert!(value["errors"].as_array().unwrap().is_empty());
}

#[test]
fn lens_post_tool_hook_records_touched_files_and_raw_output_without_reads() {
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
}

#[test]
fn lens_post_tool_hook_parses_command_output_diagnostics_without_config() {
    let (bp, _remote) = setup_blueprints();
    let project = project_dir();
    let state = tempfile::tempdir().expect("state dir");
    fs::write(project.path().join("main.rs"), "fn main() {}\n").expect("write source");
    let mut event = lens_hook_event(project.path(), "post_tool");
    event["session"] = serde_json::json!({"id": "auto-output-diagnostics"});
    event["turn"] = serde_json::json!({"id": "turn-output"});
    event["tool"] = serde_json::json!({
        "name": "exec_command",
        "status": "error",
        "input": {"cmd": "cargo test"},
        "raw_output": "main.rs:1:warning:automatic output diagnostic",
        "raw_output_max_bytes": 128
    });
    event["known_files"] = serde_json::json!([{"path": "main.rs", "operation": "modify"}]);

    let hook_assert = ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .env("XDG_CONFIG_HOME", state.path())
        .args(["hook", "lens-post-tool"])
        .write_stdin(event.to_string())
        .assert()
        .success();
    let hook_stdout =
        String::from_utf8(hook_assert.get_output().stdout.clone()).expect("hook stdout utf8");
    let hook_value: serde_json::Value = serde_json::from_str(&hook_stdout).expect("post-tool json");
    assert_eq!(hook_value["status"], "warning");
    assert_eq!(hook_value["health"]["status"], "warnings");
    assert_eq!(
        hook_value["data"]["health"]["summary"]["diagnostics"]["warnings"],
        1
    );

    let assert = ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .env("XDG_CONFIG_HOME", state.path())
        .args([
            "lens",
            "health",
            "--session",
            "auto-output-diagnostics",
            "--turn",
            "turn-output",
            "--json",
        ])
        .assert()
        .success();
    let stdout = String::from_utf8(assert.get_output().stdout.clone()).expect("stdout utf8");
    let value: serde_json::Value = serde_json::from_str(&stdout).expect("health json");
    assert_eq!(value["data"]["status"], "warnings");
    assert_eq!(value["data"]["summary"]["diagnostics"]["warnings"], 1);
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

#[test]
fn repo_namespace_routes_project_and_removes_top_level_project() {
    let (bp, _remote) = setup_blueprints();
    let project = project_dir();

    let expected_project = project
        .path()
        .file_name()
        .unwrap()
        .to_string_lossy()
        .replace('.', "_");
    ct_cmd(bp.path())
        .current_dir(project.path())
        .args(["repo", "project"])
        .assert()
        .success()
        .stdout(predicate::str::contains(expected_project));

    ct_cmd(bp.path())
        .current_dir(project.path())
        .arg("project")
        .assert()
        .failure();
}

#[test]
fn support_namespaces_route_and_removed_homes_fail() {
    let (bp, _remote) = setup_blueprints();

    ct_cmd(bp.path())
        .args(["dev", "slug", "Fix:", "The", "Thing!"])
        .assert()
        .success()
        .stdout(predicate::eq("fix-thing\n"));

    ct_cmd(bp.path())
        .args(["dev", "phases"])
        .write_stdin("### Phase 1: Setup\n1. Install deps\n")
        .assert()
        .success()
        .stdout(predicate::str::contains("Setup"));

    ct_cmd(bp.path())
        .args(["shell", "completion", "bash"])
        .assert()
        .success()
        .stdout(predicate::str::contains("_ct"));

    let usage_req = serde_json::json!({
        "provider_label": "Codex",
        "provider_color": null,
        "windows": [{
            "label": "5h",
            "used_percent": 25.0,
            "window_secs": 18000,
            "reset_secs": 9000
        }],
        "width": 80
    });
    ct_cmd(bp.path())
        .args(["tui", "usage-bar", "--width", "80"])
        .write_stdin(usage_req.to_string())
        .assert()
        .success()
        .stdout(predicate::str::contains("Codex"));

    for removed in ["tool", "usage-bar", "sym", "ast", "lsp", "notify"] {
        ct_cmd(bp.path()).arg(removed).assert().failure();
    }
}

#[test]
fn top_level_help_exposes_only_canonical_public_domains() {
    let (bp, _remote) = setup_blueprints();

    let assert = ct_cmd(bp.path()).arg("--help").assert().success();
    let help = String::from_utf8(assert.get_output().stdout.clone()).expect("help utf8");

    for canonical in [
        "source",
        "lens",
        "vault",
        "repo",
        "apply-patch",
        "mcp",
        "hook",
        "shell",
        "tui",
        "dev",
    ] {
        assert!(
            help.contains(canonical),
            "help should contain {canonical}:\n{help}"
        );
    }
    for removed in [
        "sym",
        "ast",
        "lsp",
        "tool",
        "project",
        "usage-bar",
        "notify",
    ] {
        assert!(
            !help.contains(removed),
            "help should omit {removed}:\n{help}"
        );
    }
}

#[test]
fn checked_in_public_surfaces_avoid_removed_command_taxonomy() {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("repo root");
    let paths = [
        "AGENTS.md",
        "AGENTS.template.md",
        "README.md",
        "justfile",
        "claude/settings.json",
        "codex/config.toml",
        "codex/hooks.json",
        "opencode/opencode.jsonc",
        "opencode/dcp.jsonc",
        "pi/agent/settings.json",
        "rules/blueprints.md",
        "skills/crit/SKILL.md",
        "skills/superreview/SKILL.md",
        "skills/superreview/references/reviewer-prompts.md",
        "skills/vault-sweep/SKILL.md",
        "skills/source/SKILL.md",
    ];
    let denied = [
        "ct sym",
        "ct ast",
        "ct lsp",
        "ct tool",
        "ct patch",
        "ct project",
        "ct usage-bar",
        "ct mcp source",
        "ct mcp vault",
        "ct mcp sym",
        "ct mcp ast",
        "ct mcp lsp",
        "ct mcp apply-patch",
        "ct notify",
        "lens discover",
        "lens read",
        "lens guard",
        "Lens guard",
        "mcp__sym__",
    ];

    let mut failures = Vec::new();
    for path in paths {
        let body = fs::read_to_string(repo.join(path))
            .unwrap_or_else(|error| panic!("read {path}: {error}"));
        for needle in denied {
            if body.contains(needle) {
                failures.push(format!("{path}: {needle}"));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "stale public surface hits:\n{}",
        failures.join("\n")
    );
}

#[test]
fn source_search_routes_symbol_text_and_path_modes() {
    let (bp, _remote) = setup_blueprints();
    let project = project_dir();
    fs::create_dir_all(project.path().join("src")).expect("create src");
    fs::write(
        project.path().join("src/lib.rs"),
        "pub fn source_target() -> &'static str {\n    \"needle text\"\n}\n",
    )
    .expect("write source");

    let symbol = ct_cmd(bp.path())
        .current_dir(project.path())
        .args([
            "source",
            "search",
            "--json",
            "--mode",
            "symbol",
            "source_target",
        ])
        .assert()
        .success();
    let value: serde_json::Value =
        serde_json::from_slice(&symbol.get_output().stdout).expect("symbol json");
    assert_eq!(value["mode"], "symbol");
    assert_eq!(value["read_only"], true);
    assert!(value["result_count"].as_u64().unwrap_or(0) >= 1);
    assert!(
        value["results"][0]["name"]
            .as_str()
            .unwrap_or("")
            .contains("source_target")
    );

    let text = ct_cmd(bp.path())
        .current_dir(project.path())
        .args([
            "source",
            "search",
            "--json",
            "--mode",
            "text",
            "needle text",
        ])
        .assert()
        .success();
    let value: serde_json::Value =
        serde_json::from_slice(&text.get_output().stdout).expect("text json");
    assert_eq!(value["mode"], "text");
    assert_eq!(value["results"][0]["rel_path"], "src/lib.rs");

    let path = ct_cmd(bp.path())
        .current_dir(project.path())
        .args(["source", "search", "--json", "--mode", "path", "lib.rs"])
        .assert()
        .success();
    let value: serde_json::Value =
        serde_json::from_slice(&path.get_output().stdout).expect("path json");
    assert_eq!(value["mode"], "path");
    assert_eq!(value["results"][0]["path"], "src/lib.rs");
}

#[test]
fn source_search_routes_structural_mode_when_ast_grep_is_available() {
    if StdCommand::new("sg").arg("--version").status().is_err() {
        return;
    }

    let (bp, _remote) = setup_blueprints();
    let project = project_dir();
    fs::create_dir_all(project.path().join("src")).expect("create src");
    fs::write(
        project.path().join("src/lib.rs"),
        "pub fn structural_target() -> i32 {\n    42\n}\n",
    )
    .expect("write source");

    let assert = ct_cmd(bp.path())
        .current_dir(project.path())
        .args([
            "source",
            "search",
            "--json",
            "--mode",
            "structural",
            "--lang",
            "rust",
            "--pattern",
            "pub fn $NAME() -> i32 { $$BODY }",
            "--path",
            "src/lib.rs",
        ])
        .assert()
        .success();
    let value: serde_json::Value =
        serde_json::from_slice(&assert.get_output().stdout).expect("structural json");
    assert_eq!(value["mode"], "structural");
    assert_eq!(value["match_count"].as_u64().unwrap_or(0), 1);
    assert!(value["matches"].is_array());
}

#[test]
fn source_show_and_outline_are_read_only_without_lens_read_tracking() {
    let (bp, _remote) = setup_blueprints();
    let project = project_dir();
    let state = tempfile::tempdir().expect("state dir");
    fs::create_dir_all(project.path().join("src")).expect("create src");
    fs::write(
        project.path().join("src/lib.rs"),
        "pub fn nav_target() -> i32 {\n    7\n}\n",
    )
    .expect("write source");

    ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .args(["source", "show", "--json", "src/lib.rs:L1-L2"])
        .assert()
        .failure()
        .stderr(predicates::str::contains(
            "source show only resolves symbols; use read for source lines",
        ));

    ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .args(["source", "show", "--json", "src/lib.rs"])
        .assert()
        .failure()
        .stderr(predicates::str::contains(
            "source show only resolves symbols; use source outline or read for files",
        ));

    let symbol = ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .args(["source", "show", "--json", "nav_target"])
        .assert()
        .success();
    let value: serde_json::Value =
        serde_json::from_slice(&symbol.get_output().stdout).expect("show symbol json");
    assert_eq!(value["results"][0]["kind"], "symbol");
    assert_eq!(value["results"][0]["results"][0]["name"], "nav_target");
    assert_eq!(value["results"][0]["results"][0]["start_line"], 1);

    let outline = ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .args(["source", "outline", "--json", "src/lib.rs"])
        .assert()
        .success();
    let value: serde_json::Value =
        serde_json::from_slice(&outline.get_output().stdout).expect("outline json");
    assert_eq!(value["operation"], "outline");
    assert_eq!(value["read_only"], true);
    assert!(value["symbol_count"].as_u64().unwrap_or(0) >= 1);
    assert_eq!(value["symbols"][0]["name"], "nav_target");

    ct_cmd(bp.path())
        .current_dir(project.path())
        .env("XDG_STATE_HOME", state.path())
        .args(["lens", "guard", "check", "--path", "src/lib.rs"])
        .assert()
        .failure();
}

#[test]
fn source_graph_and_investigation_commands_route_to_read_only_sym_internals() {
    let (bp, _remote) = setup_blueprints();
    let project = project_dir();
    fs::create_dir_all(project.path().join("src")).expect("create src");
    fs::write(
        project.path().join("src/lib.rs"),
        "pub trait Service { fn run(&self) -> i32; }\n\
         pub struct Worker;\n\
         impl Service for Worker { fn run(&self) -> i32 { helper() } }\n\
         pub fn helper() -> i32 { 1 }\n\
         pub fn caller() -> i32 { helper() }\n",
    )
    .expect("write source");

    let refs = ct_cmd(bp.path())
        .current_dir(project.path())
        .args(["source", "refs", "--json", "helper"])
        .assert()
        .success();
    let value: serde_json::Value =
        serde_json::from_slice(&refs.get_output().stdout).expect("refs json");
    assert_eq!(value["operation"], "refs");
    assert_eq!(value["read_only"], true);
    assert!(value["result_count"].as_u64().unwrap_or(0) >= 1);

    let trace = ct_cmd(bp.path())
        .current_dir(project.path())
        .args(["source", "trace", "--json", "caller"])
        .assert()
        .success();
    let value: serde_json::Value =
        serde_json::from_slice(&trace.get_output().stdout).expect("trace json");
    assert_eq!(value["operation"], "trace");
    assert_eq!(value["results"][0]["callee"], "helper");

    let impls = ct_cmd(bp.path())
        .current_dir(project.path())
        .args(["source", "impls", "--json", "Service"])
        .assert()
        .success();
    let value: serde_json::Value =
        serde_json::from_slice(&impls.get_output().stdout).expect("impls json");
    assert_eq!(value["operation"], "impls");
    assert_eq!(value["read_only"], true);
    assert!(value["result_count"].as_u64().unwrap_or(0) >= 1);

    let investigation = ct_cmd(bp.path())
        .current_dir(project.path())
        .args(["source", "investigate", "--json", "helper"])
        .assert()
        .success();
    let value: serde_json::Value =
        serde_json::from_slice(&investigation.get_output().stdout).expect("investigate json");
    assert_eq!(value["operation"], "investigate");
    assert_eq!(value["results"][0]["results"]["kind"], "function");
}

#[test]
fn source_diff_scopes_git_diff_to_symbol() {
    let (bp, _remote) = setup_blueprints();
    let project = project_dir();
    run_git(project.path(), &["init", "--initial-branch=main"]);
    run_git(project.path(), &["config", "user.name", "ct-test"]);
    run_git(
        project.path(),
        &["config", "user.email", "ct-test@example.com"],
    );
    run_git(project.path(), &["config", "commit.gpgsign", "false"]);
    fs::create_dir_all(project.path().join("src")).expect("create src");
    fs::write(
        project.path().join("src/lib.rs"),
        "pub fn helper() -> i32 {\n    1\n}\n\npub fn untouched() -> i32 {\n    0\n}\n",
    )
    .expect("write source");
    run_git(project.path(), &["add", "src/lib.rs"]);
    run_git(project.path(), &["commit", "-m", "init"]);
    fs::write(
        project.path().join("src/lib.rs"),
        "pub fn helper() -> i32 {\n    2\n}\n\npub fn untouched() -> i32 {\n    0\n}\n",
    )
    .expect("modify source");

    let diff = ct_cmd(bp.path())
        .current_dir(project.path())
        .args(["source", "diff", "--json", "helper"])
        .assert()
        .success();
    let value: serde_json::Value =
        serde_json::from_slice(&diff.get_output().stdout).expect("diff json");
    assert_eq!(value["operation"], "diff");
    assert_eq!(value["read_only"], true);
    assert!(
        value["result"]["content"]
            .as_str()
            .unwrap_or("")
            .contains("+    2")
    );
}

#[test]
fn vault_and_source_mcp_servers_are_removed_from_help() {
    let (bp, _remote) = setup_blueprints();

    ct_cmd(bp.path())
        .args(["mcp", "source", "--help"])
        .assert()
        .failure();

    ct_cmd(bp.path())
        .args(["mcp", "vault", "--help"])
        .assert()
        .failure();

    ct_cmd(bp.path())
        .args(["mcp", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("lens"))
        .stdout(predicate::str::contains("source").not())
        .stdout(predicate::str::contains("vault").not())
        .stdout(predicate::str::contains("apply-patch").not())
        .stdout(predicate::str::contains("sym").not())
        .stdout(predicate::str::contains("ast").not())
        .stdout(predicate::str::contains("lsp").not());
}
