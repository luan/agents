use std::fs;
use std::path::Path;
use std::process::Command;

use anyhow::{Context, Result, bail};

use crate::stow;

pub fn run() -> Result<()> {
    let root = crate::repo_root();
    assert_fresh_agents(&root)?;
    assert_no_checkout_paths(&root)?;
    validate_json(&root.join("plugins/marketplace.json"))?;
    validate_json(&root.join("codex/hooks.json"))?;
    validate_json(&root.join("plugins/git-tool/.claude-plugin/plugin.json"))?;
    validate_json(&root.join("plugins/git-tool/hooks/hooks.json"))?;
    validate_json(&root.join("plugins/gt/.codex-plugin/plugin.json"))?;
    validate_json(&root.join("plugins/gt/.claude-plugin/plugin.json"))?;
    validate_json(&root.join("plugins/gs/.codex-plugin/plugin.json"))?;
    validate_json(&root.join("plugins/gs/.claude-plugin/plugin.json"))?;
    let global_agents = root.join("GLOBAL_AGENTS.md");
    assert_symlink(&root.join("claude/CLAUDE.md"), &global_agents)?;
    assert_symlink(&root.join("codex/AGENTS.md"), &global_agents)?;
    assert_symlink(&root.join("pi/agent/AGENTS.md"), &global_agents)?;
    assert_symlink(
        &root.join("claude/local-plugins/plugins/git-tool"),
        &root.join("plugins/git-tool"),
    )?;
    assert_symlink(
        &root.join("claude/local-plugins/plugins/gt"),
        &root.join("plugins/gt"),
    )?;
    assert_symlink(
        &root.join("claude/local-plugins/plugins/gs"),
        &root.join("plugins/gs"),
    )?;
    assert_symlink(
        &root.join("claude/local-plugins/plugins/ghs"),
        &root.join("plugins/ghs"),
    )?;
    stow::run(stow::Mode::DryRun).context("stow dry-run")?;
    Ok(())
}

fn assert_fresh_agents(root: &Path) -> Result<()> {
    let path = root.join("GLOBAL_AGENTS.md");
    let before = fs::read_to_string(&path).unwrap_or_default();
    crate::render_agents::run()?;
    let after = fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
    if before != after {
        bail!("GLOBAL_AGENTS.md was stale; regenerated it. Re-run validation.");
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
        "AGENTS.template.md",
        "GLOBAL_AGENTS.md",
        "README.md",
        "docs/",
        "rules/",
        "codex/",
        "scripts/",
        "bin/",
        "claude/",
        "pi/",
        "plugins/",
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
