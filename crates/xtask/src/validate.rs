use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result, bail};
use walkdir::WalkDir;

use crate::stow;

pub fn run() -> Result<()> {
    let root = crate::repo_root();
    assert_fresh_agents(&root)?;
    assert_no_checkout_paths(&root)?;
    validate_json(&root.join("codex/hooks.json"))?;
    validate_json(&root.join(".agents/plugins/marketplace.json"))?;
    validate_json(&root.join("plugins/gt/.codex-plugin/plugin.json"))?;
    validate_json(&root.join("plugins/gt/hooks.json"))?;
    let global_agents = root.join("GLOBAL_AGENTS.md");
    assert_symlink(&root.join("claude/CLAUDE.md"), &global_agents)?;
    assert_symlink(&root.join("codex/AGENTS.md"), &global_agents)?;
    assert_symlink(&root.join("opencode/AGENTS.md"), &global_agents)?;
    assert_symlink(&root.join("pi/AGENTS.md"), &global_agents)?;
    assert_symlink(
        &root.join("claude/local-plugins/plugins/gt"),
        &root.join("plugins/gt"),
    )?;
    stow::run(stow::Mode::DryRun).context("stow dry-run")?;
    cargo_test(&root)?;
    Ok(())
}

fn assert_fresh_agents(root: &Path) -> Result<()> {
    let path = root.join("GLOBAL_AGENTS.md");
    let before = fs::read_to_string(&path).unwrap_or_default();
    crate::render_agents::run()?;
    let after = fs::read_to_string(&path)
        .with_context(|| format!("read {}", path.display()))?;
    if before != after {
        bail!("GLOBAL_AGENTS.md was stale; regenerated it. Re-run validation.");
    }
    Ok(())
}

fn validate_json(path: &Path) -> Result<()> {
    let text = fs::read_to_string(path)
        .with_context(|| format!("read {}", path.display()))?;
    serde_json::from_str::<serde_json::Value>(&text)
        .with_context(|| format!("parse {}", path.display()))?;
    Ok(())
}

fn assert_symlink(path: &Path, expected: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(path)
        .with_context(|| format!("stat {}", path.display()))?;
    if !meta.file_type().is_symlink() {
        bail!("{} must be a symlink", path.display());
    }
    let resolved = fs::canonicalize(path)
        .with_context(|| format!("resolve {}", path.display()))?;
    let want = fs::canonicalize(expected)
        .with_context(|| format!("resolve {}", expected.display()))?;
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

fn assert_no_checkout_paths(root: &Path) -> Result<()> {
    let needles = ["/".to_string() + "Users/", "/".to_string() + "private/"];
    let roots: &[PathBuf] = &[
        root.join("AGENTS.md"),
        root.join("AGENTS.template.md"),
        root.join("GLOBAL_AGENTS.md"),
        root.join("README.md"),
        root.join("docs"),
        root.join("rules"),
        root.join("codex"),
        root.join("hooks"),
        root.join("scripts"),
        root.join("bin"),
        root.join("claude"),
        root.join("opencode"),
        root.join("pi"),
        root.join("plugins"),
        root.join(".agents"),
    ];
    for r in roots {
        if !r.exists() {
            continue;
        }
        let walker: Box<dyn Iterator<Item = PathBuf>> = if r.is_file() {
            Box::new(std::iter::once(r.clone()))
        } else {
            Box::new(
                WalkDir::new(r)
                    .into_iter()
                    // Vendored dependencies contain example absolute paths in docs.
                    .filter_entry(|e| e.file_name().to_str() != Some("node_modules"))
                    .filter_map(|e| e.ok())
                    .map(|e| e.into_path()),
            )
        };
        for path in walker {
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
                    bail!(
                        "{} contains checkout-specific absolute path {}",
                        path.display(),
                        needle
                    );
                }
            }
        }
    }
    Ok(())
}

fn cargo_test(root: &Path) -> Result<()> {
    let status = Command::new("cargo")
        .args(["test", "--workspace"])
        .current_dir(root)
        .status()
        .context("invoke cargo test")?;
    if !status.success() {
        bail!("cargo test exited with {status}");
    }
    Ok(())
}
