use std::fs;
use std::path::Path;
use std::process::Command;

use anyhow::Result;

#[test]
fn version_ai_outputs_plain_text_without_prefix() -> Result<()> {
    let output = Command::new(sym_bin())
        .args(["--format", "ai", "version"])
        .output()?;

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let text = String::from_utf8(output.stdout)?;
    assert!(text.starts_with("sym "));
    assert!(!text.contains("SYM_AI"));
    assert!(!text.contains('{'));
    Ok(())
}

#[test]
fn search_ai_outputs_symbol_results() -> Result<()> {
    let fixture = Fixture::new()?;

    let output = Command::new(sym_bin())
        .current_dir(fixture.root())
        .args(["--format", "ai", "search", "HandleRequest"])
        .output()?;

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let text = String::from_utf8(output.stdout)?;
    assert!(text.starts_with("[RESULTS:1]\n"));
    assert!(text.contains("HandleRequest|f|src/main.go|3-3"));
    assert!(!text.contains('{'));
    Ok(())
}

#[test]
fn ls_stats_ai_outputs_repo_stats() -> Result<()> {
    let fixture = Fixture::new()?;

    let output = Command::new(sym_bin())
        .current_dir(fixture.root())
        .args(["--format", "ai", "ls", "--stats"])
        .output()?;

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let text = String::from_utf8(output.stdout)?;
    assert!(text.starts_with("[STATS]\n"));
    let canonical_root = fixture.root().canonicalize()?;
    assert!(text.contains("LANGS:"));
    assert!(text.contains("go:1"));
    assert!(text.contains("python:1"));
    assert!(text.contains("files:2"));
    assert!(text.contains(canonical_root.to_string_lossy().as_ref()));
    Ok(())
}

#[test]
fn non_tty_defaults_to_ai_format() -> Result<()> {
    let fixture = Fixture::new()?;

    let output = Command::new(sym_bin())
        .current_dir(fixture.root())
        .args(["search", "HandleRequest"])
        .output()?;

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let text = String::from_utf8(output.stdout)?;
    assert!(text.starts_with("[RESULTS:1]\n"));
    assert!(text.contains("HandleRequest|f|src/main.go|3-3"));
    assert!(!text.contains("SYM_AI"));
    assert!(!text.contains('{'));
    Ok(())
}

struct Fixture {
    root: tempfile::TempDir,
}

impl Fixture {
    fn new() -> Result<Self> {
        let root = tempfile::tempdir()?;
        fs::create_dir(root.path().join(".git"))?;
        write(
            root.path(),
            "src/main.go",
            "package main\n\nfunc HandleRequest() {}\n",
        )?;
        write(root.path(), "src/worker.py", "def run():\n    pass\n")?;
        Ok(Self { root })
    }

    fn root(&self) -> &Path {
        self.root.path()
    }
}

fn sym_bin() -> &'static str {
    // Cargo sets this for integration tests so they exercise the just-built binary.
    env!("CARGO_BIN_EXE_sym")
}

fn write(root: &Path, rel_path: &str, contents: &str) -> Result<()> {
    let path = root.join(rel_path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, contents)?;
    Ok(())
}
