use std::fs;
use std::path::Path;
use std::process::{Command, Output};

use anyhow::Result;

#[test]
fn help_exposes_core_subcommands_and_global_format_option() -> Result<()> {
    let output = sym_cmd().arg("--help").output()?;

    assert_success(&output);
    let stdout = String::from_utf8(output.stdout)?;
    for expected in [
        "Commands:",
        "index",
        "search",
        "refs",
        "callers",
        "callees",
        "impact",
        "trace",
        "tests",
        "test-deps",
        "untested",
        "investigate",
        "--format <FORMAT>",
    ] {
        assert!(
            stdout.contains(expected),
            "help should contain {expected:?}\n{stdout}"
        );
    }
    Ok(())
}

#[test]
fn command_help_documents_required_targets() -> Result<()> {
    for (command, expected) in [
        ("search", "[QUERY]..."),
        ("refs", "[TARGETS]..."),
        ("callers", "[TARGETS]..."),
        ("callees", "[TARGETS]..."),
        ("show", "[TARGETS]..."),
        ("test-deps", "<TARGET>"),
    ] {
        let output = sym_cmd().args([command, "--help"]).output()?;
        assert_success(&output);
        let stdout = String::from_utf8(output.stdout)?;
        assert!(
            stdout.contains(expected),
            "{command} help should document required target {expected:?}\n{stdout}"
        );
    }
    Ok(())
}

#[test]
fn missing_required_targets_fail_with_clear_messages() -> Result<()> {
    for (args, expected) in [
        (vec!["search"], "search query cannot be empty"),
        (vec!["refs"], "no symbol names provided"),
        (vec!["callers"], "callers requires at least one target"),
        (vec!["callees"], "callees requires at least one target"),
        (vec!["tests"], "tests requires at least one target"),
        (vec!["test-deps"], "required arguments were not provided"),
    ] {
        let output = sym_cmd().args(args).output()?;
        assert_failure(&output);
        let stderr = String::from_utf8(output.stderr)?;
        assert!(
            stderr.contains(expected),
            "stderr should contain {expected:?}\n{stderr}"
        );
    }
    Ok(())
}

#[test]
fn empty_repository_queries_keep_stable_ai_headers() -> Result<()> {
    let fixture = Fixture::new()?;

    for (args, expected_header) in [
        (
            vec!["--format", "ai", "refs", "missing"],
            "[REFS:missing|0]\n",
        ),
        (
            vec!["--format", "ai", "callers", "missing"],
            "[CALLERS:missing|0]\n",
        ),
        (
            vec!["--format", "ai", "callees", "missing"],
            "[CALLEES:missing|0]\n",
        ),
        (
            vec!["--format", "ai", "tests", "missing"],
            "[TESTS:missing|0]\n",
        ),
    ] {
        let output = sym_cmd().current_dir(fixture.root()).args(args).output()?;
        assert_success(&output);
        let stdout = String::from_utf8(output.stdout)?;
        assert!(
            stdout.starts_with(expected_header),
            "stdout should start with {expected_header:?}\n{stdout}"
        );
    }
    Ok(())
}

struct Fixture {
    root: tempfile::TempDir,
}

impl Fixture {
    fn new() -> Result<Self> {
        let root = tempfile::tempdir()?;
        fs::create_dir(root.path().join(".git"))?;
        fs::write(root.path().join("lib.rs"), "pub fn present() {}\n")?;
        Ok(Self { root })
    }

    fn root(&self) -> &Path {
        self.root.path()
    }
}

fn sym_cmd() -> Command {
    Command::new(env!("CARGO_BIN_EXE_sym"))
}

fn assert_success(output: &Output) {
    assert!(
        output.status.success(),
        "command failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn assert_failure(output: &Output) {
    assert!(
        !output.status.success(),
        "command unexpectedly succeeded\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
