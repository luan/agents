use std::fs;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;

use anyhow::{Context, Result, bail};

use crate::stow;

pub fn run() -> Result<()> {
    let root = crate::repo_root();
    assert_no_checkout_paths(&root)?;
    validate_json(&root.join("codex/hooks.json"))?;
    let global_agents = root.join("GLOBAL_AGENTS.md");
    assert_symlink(&root.join("claude/CLAUDE.md"), &global_agents)?;
    assert_symlink(&root.join("codex/AGENTS.md"), &global_agents)?;
    assert_symlink(&root.join("pi/agent/AGENTS.md"), &global_agents)?;
    // These match `workspaceBinary()` in pi/agent/extensions/shared/workspace.ts.
    assert_native_host(&root.join("target/release/codex-code-mode-host"))?;
    assert_native_host(&root.join("target/release/apply_patch"))?;
    stow::run(stow::Mode::DryRun).context("stow dry-run")?;
    Ok(())
}

fn assert_native_host(path: &Path) -> Result<()> {
    #[cfg(windows)]
    let path = path.with_extension("exe");
    #[cfg(not(windows))]
    let path = path.to_path_buf();
    let metadata =
        fs::metadata(&path).with_context(|| format!("stat native host {}", path.display()))?;
    if !metadata.is_file() {
        bail!("native host {} must be a file", path.display());
    }
    #[cfg(unix)]
    if metadata.permissions().mode() & 0o111 == 0 {
        bail!("native host {} must be executable", path.display());
    }
    Ok(())
}
fn validate_json(path: &Path) -> Result<()> {
    let text = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    serde_json::from_str::<serde_json::Value>(&text)
        .with_context(|| format!("parse {}", path.display()))?;
    Ok(())
}

fn assert_symlink(path: &Path, expected: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(path).with_context(|| format!("stat {}", path.display()))?;
    if !meta.file_type().is_symlink() {
        bail!("{} must be a symlink", path.display());
    }
    let resolved = fs::canonicalize(path).with_context(|| format!("resolve {}", path.display()))?;
    let want =
        fs::canonicalize(expected).with_context(|| format!("resolve {}", expected.display()))?;
    if resolved != want {
        bail!(
            "{} resolves to {}, expected {}",
            path.display(),
            resolved.display(),
            want.display(),
        );
    }
    Ok(())
}

/// Files that get read rather than executed -- prompts, docs, configs, skills --
/// must not carry one machine's absolute paths. Scanning only what git tracks keeps
/// gitignored runtime state out of it: pi's sessions, caches and debug logs all
/// embed this checkout's cwd by design, and enumerating them by hand meant every
/// new artifact broke validation until someone appended another line.
fn assert_no_checkout_paths(root: &Path) -> Result<()> {
    let needles = ["/".to_string() + "Users/", "/".to_string() + "private/"];
    const SCANNED: &[&str] = &[
        "AGENTS.md",
        "GLOBAL_AGENTS.md",
        "README.md",
        "docs/",
        "codex/",
        "scripts/",
        "bin/",
        "claude/",
        "pi/",
        "plugins/",
        "skills/",
    ];

    for rel in tracked_files(root)? {
        if !SCANNED
            .iter()
            .any(|s| rel == *s || (s.ends_with('/') && rel.starts_with(s)))
        {
            continue;
        }
        // Codex writes its own resolved paths here; test fixtures assert on path
        // parsing, so literal paths are their input data.
        if rel == "codex/config.toml" || rel.contains(".test.") {
            continue;
        }
        let path = root.join(&rel);
        let meta = match fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !meta.is_file() || meta.file_type().is_symlink() {
            continue;
        }
        let bytes = match fs::read(&path) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let text = String::from_utf8_lossy(&bytes);
        for needle in &needles {
            if text.contains(needle) {
                bail!("{rel} contains checkout-specific absolute path {needle}");
            }
        }
    }
    Ok(())
}

fn tracked_files(root: &Path) -> Result<Vec<String>> {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["ls-files", "-z"])
        .output()
        .context("run git ls-files")?;
    if !out.status.success() {
        bail!("git ls-files failed in {}", root.display());
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_a_missing_native_host() {
        let dir = tempfile::tempdir().unwrap();
        assert!(assert_native_host(&dir.path().join("missing")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn requires_an_executable_native_host() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("host");
        fs::write(&path, b"host").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(assert_native_host(&path).is_err());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(assert_native_host(&path).is_ok());
    }
}
