//! CLI contract baseline for the public `ct` command surface.

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

#[test]
fn support_namespaces_route_and_removed_homes_fail() {
    let (bp, _remote) = setup_blueprints();

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

    ct_cmd(bp.path())
        .args(["tui", "usage-bars", "--width", "80"])
        .assert()
        .success();

    for removed in [
        "repo",
        "vault",
        "tool",
        "usage-bar",
        "ast",
        "lsp",
        "mcp",
        "hook",
        "dev",
        "n",
    ] {
        ct_cmd(bp.path()).arg(removed).assert().failure();
    }
}

#[test]
fn top_level_help_exposes_only_canonical_public_domains() {
    let (bp, _remote) = setup_blueprints();

    let assert = ct_cmd(bp.path()).arg("--help").assert().success();
    let help = String::from_utf8(assert.get_output().stdout.clone()).expect("help utf8");

    for canonical in ["apply-patch", "shell", "tui"] {
        assert!(
            help.contains(canonical),
            "help should contain {canonical}:\n{help}"
        );
    }
    for removed in ["repo", "mcp", "hook", "dev"] {
        assert!(
            !help.contains(removed),
            "help should not contain removed command {removed}:\n{help}"
        );
    }
    assert!(
        !help.contains("source"),
        "help should not contain removed command source:\n{help}"
    );
    assert!(
        !help.contains("vault"),
        "vault commands live in the vlt binary:\n{help}"
    );
}

#[test]
fn mcp_namespace_is_removed_from_ct() {
    let (bp, _remote) = setup_blueprints();

    ct_cmd(bp.path())
        .args(["mcp", "vault", "--help"])
        .assert()
        .failure();
}
