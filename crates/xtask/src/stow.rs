use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};

#[derive(Clone, Copy, PartialEq, Eq)]
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

    if mode != Mode::DryRun {
        cleanup_legacy_bin_links(&root, &home);
    }

    let mut errors: usize = 0;
    for (package, segments) in TARGETS {
        let source = root.join(package);
        let mut target = home.clone();
        for s in *segments {
            target.push(s);
        }
        eprintln!(
            "+ {} {} -> {}",
            mode_verb(mode),
            display_rel(&source, &root),
            target.display()
        );
        if let Err(err) = process_package(mode, &source, &target) {
            eprintln!("  error: {err:#}");
            errors += 1;
            if mode == Mode::Link {
                break;
            }
        }
    }

    if errors > 0 {
        bail!("stow operation completed with {errors} package error(s)");
    }
    Ok(())
}

fn mode_verb(mode: Mode) -> &'static str {
    match mode {
        Mode::DryRun => "[dry-run]",
        Mode::Link => "link",
        Mode::Unlink => "unlink",
    }
}

fn display_rel(p: &Path, root: &Path) -> String {
    p.strip_prefix(root)
        .map(|r| r.display().to_string())
        .unwrap_or_else(|_| p.display().to_string())
}

fn process_package(mode: Mode, source: &Path, target: &Path) -> Result<()> {
    if !source.is_dir() {
        bail!("source {} is not a directory", source.display());
    }

    if mode == Mode::Link {
        fs::create_dir_all(target)
            .with_context(|| format!("mkdir -p {}", target.display()))?;
    }

    let mut entries: Vec<_> = fs::read_dir(source)
        .with_context(|| format!("read_dir {}", source.display()))?
        .filter_map(|e| e.ok())
        .collect();
    entries.sort_by_key(|e| e.file_name());

    for entry in entries {
        let name = entry.file_name();
        let source_entry = source.join(&name);
        let target_entry = target.join(&name);
        match mode {
            Mode::DryRun => act_dry_run(&source_entry, &target_entry)?,
            Mode::Link => act_link(&source_entry, &target_entry)?,
            Mode::Unlink => act_unlink(&source_entry, &target_entry)?,
        }
    }
    Ok(())
}

fn iter_children(source: &Path) -> Result<Vec<PathBuf>> {
    let mut entries: Vec<_> = fs::read_dir(source)
        .with_context(|| format!("read_dir {}", source.display()))?
        .filter_map(|e| e.ok())
        .collect();
    entries.sort_by_key(|e| e.file_name());
    Ok(entries.into_iter().map(|e| e.path()).collect())
}

fn act_link(source: &Path, target: &Path) -> Result<()> {
    let source_canon = fs::canonicalize(source)
        .with_context(|| format!("canonicalize {}", source.display()))?;

    match fs::symlink_metadata(target) {
        Ok(meta) if meta.file_type().is_symlink() => {
            let existing_canon = fs::canonicalize(target).ok();
            if existing_canon.as_deref() == Some(source_canon.as_path()) {
                eprintln!("  = {} (up to date)", target.display());
                return Ok(());
            }
            eprintln!(
                "  ~ replacing {} (was -> {})",
                target.display(),
                existing_canon
                    .map(|p| p.display().to_string())
                    .unwrap_or_else(|| "<broken>".to_string())
            );
            remove_symlink(target).with_context(|| {
                format!("remove existing symlink {}", target.display())
            })?;
            create_symlink(source, target)?;
        }
        Ok(meta) if meta.is_dir() => {
            // Tree-unfolding: target dir already exists, source is a dir → recurse.
            let src_meta = fs::metadata(source)
                .with_context(|| format!("stat target of {}", source.display()))?;
            if !src_meta.is_dir() {
                bail!(
                    "{} is a directory but source {} is a file",
                    target.display(),
                    source.display()
                );
            }
            for child in iter_children(source)? {
                let name = child.file_name().expect("entry has filename");
                act_link(&child, &target.join(name))?;
            }
        }
        Ok(_) => {
            bail!(
                "{} already exists and is not a symlink (refusing to clobber)",
                target.display()
            );
        }
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            create_symlink(source, target)?;
            eprintln!("  + {} -> {}", target.display(), source.display());
        }
        Err(err) => {
            return Err(anyhow::Error::from(err))
                .with_context(|| format!("stat {}", target.display()));
        }
    }
    Ok(())
}

fn act_dry_run(source: &Path, target: &Path) -> Result<()> {
    let source_canon = fs::canonicalize(source)
        .with_context(|| format!("canonicalize {}", source.display()))?;

    match fs::symlink_metadata(target) {
        Ok(meta) if meta.file_type().is_symlink() => {
            let existing_canon = fs::canonicalize(target).ok();
            if existing_canon.as_deref() == Some(source_canon.as_path()) {
                eprintln!("  = {} (up to date)", target.display());
            } else {
                eprintln!("  ~ would replace {}", target.display());
            }
        }
        Ok(meta) if meta.is_dir() => {
            let src_meta = fs::metadata(source)
                .with_context(|| format!("stat target of {}", source.display()))?;
            if !src_meta.is_dir() {
                bail!(
                    "{} is a directory but source {} is a file",
                    target.display(),
                    source.display()
                );
            }
            for child in iter_children(source)? {
                let name = child.file_name().expect("entry has filename");
                act_dry_run(&child, &target.join(name))?;
            }
        }
        Ok(_) => {
            bail!(
                "{} already exists and is not a symlink",
                target.display()
            );
        }
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            eprintln!(
                "  + would link {} -> {}",
                target.display(),
                source.display()
            );
        }
        Err(err) => {
            return Err(anyhow::Error::from(err))
                .with_context(|| format!("stat {}", target.display()));
        }
    }
    Ok(())
}

fn act_unlink(source: &Path, target: &Path) -> Result<()> {
    let source_canon = fs::canonicalize(source)
        .with_context(|| format!("canonicalize {}", source.display()))?;

    match fs::symlink_metadata(target) {
        Ok(meta) if meta.file_type().is_symlink() => {
            let existing_canon = fs::canonicalize(target).ok();
            if existing_canon.as_deref() == Some(source_canon.as_path()) {
                remove_symlink(target)
                    .with_context(|| format!("remove {}", target.display()))?;
                eprintln!("  - {}", target.display());
            } else {
                eprintln!(
                    "  skip {} (symlink not owned by this repo)",
                    target.display()
                );
            }
        }
        Ok(meta) if meta.is_dir() => {
            let src_meta = match fs::metadata(source) {
                Ok(m) => m,
                Err(_) => return Ok(()),
            };
            if !src_meta.is_dir() {
                return Ok(());
            }
            for child in iter_children(source)? {
                let name = child.file_name().expect("entry has filename");
                act_unlink(&child, &target.join(name))?;
            }
        }
        Ok(_) => {
            eprintln!("  skip {} (not a symlink)", target.display());
        }
        Err(_) => {}
    }
    Ok(())
}

// Remove a symlink at `target`, regardless of whether it points to a file or
// directory. On Unix both kinds are removed via fs::remove_file (the syscall
// operates on the link itself, not the target). On Windows fs::remove_file
// only removes file symlinks; directory symlinks must go through
// fs::remove_dir (which removes the link, not the dir's contents) and
// fs::remove_file would otherwise fail with ERROR_ACCESS_DENIED (os error 5).
fn remove_symlink(target: &Path) -> std::io::Result<()> {
    match fs::remove_file(target) {
        Ok(()) => Ok(()),
        #[cfg(windows)]
        Err(_) => fs::remove_dir(target),
        #[cfg(not(windows))]
        Err(err) => Err(err),
    }
}

#[cfg(unix)]
fn create_symlink(source: &Path, target: &Path) -> Result<()> {
    std::os::unix::fs::symlink(source, target).with_context(|| {
        format!("symlink {} -> {}", target.display(), source.display())
    })
}

#[cfg(windows)]
fn create_symlink(source: &Path, target: &Path) -> Result<()> {
    use std::os::windows::fs::{symlink_dir, symlink_file};
    let meta = fs::metadata(source)
        .with_context(|| format!("stat target of {}", source.display()))?;
    let res = if meta.is_dir() {
        symlink_dir(source, target)
    } else {
        symlink_file(source, target)
    };
    res.with_context(|| {
        format!(
            "symlink {} -> {} (Windows symlinks require Developer Mode or an elevated shell; run `cargo xtask doctor` for diagnostics)",
            target.display(),
            source.display()
        )
    })
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
