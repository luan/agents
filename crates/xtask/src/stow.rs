use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result, bail};

#[derive(Clone, Copy)]
pub enum Mode {
    DryRun,
    Link,
    Unlink,
}

const TARGETS: &[(&str, &[&str])] = &[
    ("claude", &[".claude"]),
    ("codex", &[".codex"]),
    ("opencode", &[".config", "opencode"]),
    ("pi", &[".pi"]),
    ("rules", &[".agents", "rules"]),
    ("skills", &[".agents", "skills"]),
    ("skills", &[".claude", "skills"]),
];

const LEGACY_BIN_LINKS: &[&str] = &["agents-hook", "opencode"];

pub fn run(mode: Mode) -> Result<()> {
    let root = crate::repo_root();
    let home = dirs::home_dir().context("cannot determine HOME")?;

    if matches!(mode, Mode::Link | Mode::Unlink) {
        cleanup_legacy_bin_links(&root, &home);
    }

    let mut last_status: i32 = 0;
    for (package, segments) in TARGETS {
        let mut target = home.clone();
        for s in *segments {
            target.push(s);
        }
        fs::create_dir_all(&target)
            .with_context(|| format!("mkdir -p {}", target.display()))?;
        let cmd = stow_args(mode, package, &target);
        eprintln!("+ {}", cmd.join(" "));
        let status = Command::new(&cmd[0])
            .args(&cmd[1..])
            .current_dir(&root)
            .status()
            .with_context(|| format!("invoke {}", cmd[0]))?;
        if !status.success() {
            last_status = status.code().unwrap_or(1);
            if matches!(mode, Mode::Link) {
                break;
            }
        }
    }

    if last_status != 0 {
        bail!("stow exited with status {last_status}");
    }
    Ok(())
}

fn stow_args(mode: Mode, package: &str, target: &Path) -> Vec<String> {
    let mut cmd: Vec<String> = vec!["stow".into()];
    match mode {
        Mode::DryRun => {
            cmd.push("-n".into());
            cmd.push("-v".into());
            cmd.push("-R".into());
        }
        Mode::Link => cmd.push("-R".into()),
        Mode::Unlink => cmd.push("-D".into()),
    }
    cmd.push(package.into());
    cmd.push("-t".into());
    cmd.push(target.display().to_string());
    cmd
}

fn cleanup_legacy_bin_links(root: &Path, home: &Path) {
    let bin_dir = home.join("bin");
    let repo_bin: PathBuf = root.join("bin");
    for name in LEGACY_BIN_LINKS {
        let link = bin_dir.join(name);
        let meta = match fs::symlink_metadata(&link) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !meta.file_type().is_symlink() {
            continue;
        }
        match fs::canonicalize(&link) {
            Ok(resolved) => {
                if let Ok(canon_repo) = fs::canonicalize(&repo_bin) {
                    if resolved.starts_with(&canon_repo) {
                        eprintln!("- unlink legacy {}", link.display());
                        let _ = fs::remove_file(&link);
                    }
                }
            }
            Err(_) => {
                let _ = fs::remove_file(&link);
            }
        }
    }
}
