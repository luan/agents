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
