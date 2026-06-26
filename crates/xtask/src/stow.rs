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
    ("pi", &[".pi"]),
    ("omp/agent", &[".omp", "agent"]),
    ("skills", &[".claude", "skills"]),
];

const AGENTS_HOME: &[&str] = &[".agents"];

pub fn run(mode: Mode) -> Result<()> {
    let root = crate::repo_root();
    let home = dirs::home_dir().context("cannot determine HOME")?;

    let mut errors: usize = 0;
    let agents_home = target_from_segments(&home, AGENTS_HOME);
    eprintln!("+ {} . -> {}", mode_verb(mode), agents_home.display());
    if let Err(err) = process_agents_home(mode, &root, &agents_home) {
        eprintln!("  error: {err:#}");
        errors += 1;
    }

    for (package, segments) in TARGETS {
        let source = root.join(package);
        let target = target_from_segments(&home, segments);
        eprintln!(
            "+ {} {} -> {}",
            mode_verb(mode),
            display_rel(&source, &root),
            target.display()
        );
        if let Err(err) = process_package(mode, &source, &target) {
            eprintln!("  error: {err:#}");
            errors += 1;
        }
    }

    if errors > 0 {
        bail!("stow operation completed with {errors} package error(s)");
    }
    Ok(())
}

/// Symlink `pi/agent/node_modules` -> the workspace-root `node_modules` so the
/// pi agent resolves the single hoisted dependency tree installed by
/// `bun install`. Cross-platform: uses the same symlink primitives as `link`,
/// so on Windows it creates a real directory symlink (and surfaces Developer
/// Mode guidance via `create_symlink` on failure) instead of the file copy that
/// `ln` produces under Git's `sh`.
pub fn link_pi_node_modules() -> Result<()> {
    let root = crate::repo_root();
    let source = root.join("node_modules");
    let target = root.join("pi").join("agent").join("node_modules");

    if !source.is_dir() {
        bail!(
            "{} does not exist; run `bun install` first",
            source.display()
        );
    }

    match fs::symlink_metadata(&target) {
        Ok(meta) if meta.file_type().is_symlink() => {
            if same_canonical_path(&source, &target).unwrap_or(false) {
                eprintln!("  = {} (up to date)", target.display());
                return Ok(());
            }
            remove_symlink(&target).with_context(|| format!("remove {}", target.display()))?;
            create_symlink(&source, &target)?;
            eprintln!("  ~ {} -> {}", target.display(), source.display());
            Ok(())
        }
        Ok(_) => bail!(
            "{} already exists and is not a symlink (refusing to clobber a real node_modules)",
            target.display()
        ),
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            create_symlink(&source, &target)?;
            eprintln!("  + {} -> {}", target.display(), source.display());
            Ok(())
        }
        Err(err) => {
            Err(anyhow::Error::from(err)).with_context(|| format!("stat {}", target.display()))
        }
    }
}

fn mode_verb(mode: Mode) -> &'static str {
    match mode {
        Mode::DryRun => "[dry-run]",
        Mode::Link => "link",
        Mode::Unlink => "unlink",
    }
}

fn target_from_segments(home: &Path, segments: &[&str]) -> PathBuf {
    let mut target = home.to_path_buf();
    for s in segments {
        target.push(s);
    }
    target
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
        fs::create_dir_all(target).with_context(|| format!("mkdir -p {}", target.display()))?;
    }

    for source_entry in iter_children(source)? {
        let name = source_entry.file_name().expect("entry has filename");
        let target_entry = target.join(name);
        match mode {
            Mode::DryRun => act_dry_run(&source_entry, &target_entry)?,
            Mode::Link => act_link(&source_entry, &target_entry)?,
            Mode::Unlink => act_unlink(&source_entry, &target_entry)?,
        }
    }
    Ok(())
}

fn process_agents_home(mode: Mode, root: &Path, target: &Path) -> Result<()> {
    match mode {
        Mode::DryRun => act_agents_home_dry_run(root, target),
        Mode::Link => act_agents_home_link(root, target),
        Mode::Unlink => act_agents_home_unlink(root, target),
    }
}

fn act_agents_home_link(root: &Path, target: &Path) -> Result<()> {
    match fs::symlink_metadata(target) {
        Ok(meta) if meta.file_type().is_symlink() => {
            if same_canonical_path(root, target)? {
                eprintln!("  = {} (up to date)", target.display());
                Ok(())
            } else {
                bail_foreign_symlink(root, target)
            }
        }
        Ok(meta) if meta.is_dir() => {
            if same_canonical_path(root, target)? {
                eprintln!("  = {} (repo checkout)", target.display());
                return Ok(());
            }
            if directory_contains_only_repo_links(root, target)? {
                let backup = move_repo_owned_directory_aside(target)?;
                create_symlink(root, target)?;
                eprintln!(
                    "  ~ {} -> {} (moved existing repo-owned directory to {})",
                    target.display(),
                    root.display(),
                    backup.display()
                );
                return Ok(());
            }
            bail!(
                "{} already exists and is not this repo checkout (refusing to clobber)",
                target.display()
            );
        }
        Ok(_) => bail!(
            "{} already exists and is not a symlink or directory",
            target.display()
        ),
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            create_symlink(root, target)?;
            eprintln!("  + {} -> {}", target.display(), root.display());
            Ok(())
        }
        Err(err) => {
            Err(anyhow::Error::from(err)).with_context(|| format!("stat {}", target.display()))
        }
    }
}

fn act_agents_home_dry_run(root: &Path, target: &Path) -> Result<()> {
    match fs::symlink_metadata(target) {
        Ok(meta) if meta.file_type().is_symlink() => {
            if same_canonical_path(root, target)? {
                eprintln!("  = {} (up to date)", target.display());
                Ok(())
            } else {
                bail_foreign_symlink(root, target)
            }
        }
        Ok(meta) if meta.is_dir() => {
            if same_canonical_path(root, target)? {
                eprintln!("  = {} (repo checkout)", target.display());
                return Ok(());
            }
            if directory_contains_only_repo_links(root, target)? {
                let backup = next_backup_path(target)?;
                eprintln!(
                    "  ~ would move existing repo-owned directory {} to {} and link -> {}",
                    target.display(),
                    backup.display(),
                    root.display()
                );
                return Ok(());
            }
            bail!(
                "{} already exists and is not this repo checkout",
                target.display()
            );
        }
        Ok(_) => bail!(
            "{} already exists and is not a symlink or directory",
            target.display()
        ),
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            eprintln!("  + would link {} -> {}", target.display(), root.display());
            Ok(())
        }
        Err(err) => {
            Err(anyhow::Error::from(err)).with_context(|| format!("stat {}", target.display()))
        }
    }
}

fn act_agents_home_unlink(root: &Path, target: &Path) -> Result<()> {
    match fs::symlink_metadata(target) {
        Ok(meta) if meta.file_type().is_symlink() => {
            if same_canonical_path(root, target)? {
                remove_symlink(target).with_context(|| format!("remove {}", target.display()))?;
                eprintln!("  - {}", target.display());
            } else {
                eprintln!(
                    "  skip {} (symlink not owned by this repo)",
                    target.display()
                );
            }
        }
        Ok(meta) if meta.is_dir() => {
            if same_canonical_path(root, target)? {
                eprintln!("  skip {} (repo checkout)", target.display());
            } else {
                eprintln!("  skip {} (not owned by this repo)", target.display());
            }
        }
        Ok(_) => eprintln!("  skip {} (not a symlink)", target.display()),
        Err(_) => {}
    }
    Ok(())
}

fn same_canonical_path(a: &Path, b: &Path) -> Result<bool> {
    let a = fs::canonicalize(a).with_context(|| format!("canonicalize {}", a.display()))?;
    Ok(fs::canonicalize(b).ok().as_deref() == Some(a.as_path()))
}

fn bail_foreign_symlink(root: &Path, target: &Path) -> Result<()> {
    let root_canon =
        fs::canonicalize(root).with_context(|| format!("canonicalize {}", root.display()))?;
    let existing_canon = fs::canonicalize(target).ok();
    bail!(
        "{} already exists as a symlink to {} (expected {}; refusing to replace non-owned symlink)",
        target.display(),
        existing_canon
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| "<broken>".to_string()),
        root_canon.display(),
    )
}

fn directory_contains_only_repo_links(root: &Path, target: &Path) -> Result<bool> {
    let root =
        fs::canonicalize(root).with_context(|| format!("canonicalize {}", root.display()))?;
    directory_entries_are_repo_links(&root, target)
}

fn directory_entries_are_repo_links(root: &Path, target: &Path) -> Result<bool> {
    let mut saw_entry = false;
    for entry in fs::read_dir(target).with_context(|| format!("read_dir {}", target.display()))? {
        let entry = entry.with_context(|| format!("read_dir entry {}", target.display()))?;
        let path = entry.path();
        let meta =
            fs::symlink_metadata(&path).with_context(|| format!("stat {}", path.display()))?;
        if meta.file_type().is_symlink() {
            if !symlink_points_under(&path, root)? {
                return Ok(false);
            }
            saw_entry = true;
        } else if meta.is_dir() {
            if !directory_entries_are_repo_links(root, &path)? {
                return Ok(false);
            }
            saw_entry = true;
        } else {
            return Ok(false);
        }
    }
    Ok(saw_entry)
}

fn symlink_points_under(link: &Path, root: &Path) -> Result<bool> {
    if let Ok(target) = fs::canonicalize(link) {
        return Ok(path_is_at_or_under(&target, root));
    }

    let raw_target = fs::read_link(link).with_context(|| format!("readlink {}", link.display()))?;
    let target = if raw_target.is_absolute() {
        raw_target
    } else {
        link.parent()
            .unwrap_or_else(|| Path::new("."))
            .join(raw_target)
    };
    if target
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Ok(false);
    }
    Ok(path_is_at_or_under(&target, root))
}

fn path_is_at_or_under(path: &Path, root: &Path) -> bool {
    if path.starts_with(root) {
        return true;
    }

    #[cfg(windows)]
    {
        let path = comparable_path(path);
        let root = comparable_path(root);
        if path == root {
            return true;
        }
        path.strip_prefix(&root)
            .is_some_and(|rest| rest.starts_with('\\'))
    }

    #[cfg(not(windows))]
    {
        false
    }
}

#[cfg(windows)]
fn comparable_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('/', "\\")
        .trim_start_matches(r"\\?\")
        .trim_end_matches('\\')
        .to_ascii_lowercase()
}

fn iter_children(source: &Path) -> Result<Vec<PathBuf>> {
    let mut entries = fs::read_dir(source)
        .with_context(|| format!("read_dir {}", source.display()))?
        .collect::<std::result::Result<Vec<_>, _>>()
        .with_context(|| format!("read_dir entries {}", source.display()))?;
    entries.sort_by_key(|e| e.file_name());
    Ok(entries.into_iter().map(|e| e.path()).collect())
}

fn file_contents_match(source: &Path, target: &Path) -> Result<bool> {
    let source_meta =
        fs::metadata(source).with_context(|| format!("stat target of {}", source.display()))?;
    let target_meta =
        fs::metadata(target).with_context(|| format!("stat target of {}", target.display()))?;
    if !source_meta.is_file() || !target_meta.is_file() {
        return Ok(false);
    }
    let source_contents = fs::read(source).with_context(|| format!("read {}", source.display()))?;
    let target_contents = fs::read(target).with_context(|| format!("read {}", target.display()))?;
    Ok(contents_equivalent(&source_contents, &target_contents))
}

fn contents_equivalent(a: &[u8], b: &[u8]) -> bool {
    a == b || trim_one_final_newline(a) == trim_one_final_newline(b)
}

fn trim_one_final_newline(bytes: &[u8]) -> &[u8] {
    bytes.strip_suffix(b"\n").unwrap_or(bytes)
}

fn next_backup_path(target: &Path) -> Result<PathBuf> {
    let parent = target.parent().unwrap_or_else(|| Path::new("."));
    let file_name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "backup".to_string());

    for index in 0..1000 {
        let candidate_name = if index == 0 {
            format!("{file_name}.agents-backup")
        } else {
            format!("{file_name}.agents-backup.{index}")
        };
        let candidate = parent.join(candidate_name);
        match fs::symlink_metadata(&candidate) {
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(candidate),
            Ok(_) => {}
            Err(err) => {
                return Err(anyhow::Error::from(err))
                    .with_context(|| format!("stat {}", candidate.display()));
            }
        }
    }

    bail!(
        "could not find an available backup path for {} after 1000 attempts",
        target.display()
    )
}

fn move_conflicting_entry_aside(target: &Path) -> Result<PathBuf> {
    let backup = next_backup_path(target)?;
    fs::rename(target, &backup)
        .with_context(|| format!("move {} to {}", target.display(), backup.display()))?;
    Ok(backup)
}

fn move_repo_owned_directory_aside(target: &Path) -> Result<PathBuf> {
    let backup = next_backup_path(target)?;
    match fs::rename(target, &backup) {
        Ok(()) => Ok(backup),
        Err(rename_err) => {
            fs::create_dir(&backup).with_context(|| format!("mkdir {}", backup.display()))?;
            move_children_into_backup(target, &backup).with_context(|| {
                format!(
                    "move entries from {} to {} after rename failed: {rename_err}",
                    target.display(),
                    backup.display()
                )
            })?;
            fs::remove_dir(target).with_context(|| {
                format!(
                    "remove empty {} after moving entries to {}; original rename failed: {rename_err}",
                    target.display(),
                    backup.display()
                )
            })?;
            Ok(backup)
        }
    }
}

fn move_children_into_backup(source: &Path, backup: &Path) -> Result<()> {
    for child in iter_children(source)? {
        let name = child.file_name().expect("entry has filename");
        fs::rename(&child, backup.join(name)).with_context(|| {
            format!(
                "move {} to {}",
                child.display(),
                backup.join(name).display()
            )
        })?;
    }
    Ok(())
}

fn act_link(source: &Path, target: &Path) -> Result<()> {
    match fs::symlink_metadata(target) {
        Ok(meta) if meta.file_type().is_symlink() => {
            let source_canon = fs::canonicalize(source)
                .with_context(|| format!("canonicalize {}", source.display()))?;
            let existing_canon = fs::canonicalize(target).ok();
            if existing_canon.as_deref() == Some(source_canon.as_path()) {
                eprintln!("  = {} (up to date)", target.display());
                return Ok(());
            }
            bail!(
                "{} already exists as a symlink to {} (refusing to replace non-owned symlink)",
                target.display(),
                existing_canon
                    .map(|p| p.display().to_string())
                    .unwrap_or_else(|| "<broken>".to_string())
            );
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
            if file_contents_match(source, target)? {
                fs::remove_file(target).with_context(|| format!("remove {}", target.display()))?;
                create_symlink(source, target)?;
                eprintln!(
                    "  ~ {} -> {} (replaced identical file)",
                    target.display(),
                    source.display()
                );
            } else {
                let backup = move_conflicting_entry_aside(target)?;
                create_symlink(source, target)?;
                eprintln!(
                    "  ~ {} -> {} (moved existing entry to {})",
                    target.display(),
                    source.display(),
                    backup.display()
                );
            }
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
    match fs::symlink_metadata(target) {
        Ok(meta) if meta.file_type().is_symlink() => {
            let source_canon = fs::canonicalize(source)
                .with_context(|| format!("canonicalize {}", source.display()))?;
            let existing_canon = fs::canonicalize(target).ok();
            if existing_canon.as_deref() == Some(source_canon.as_path()) {
                eprintln!("  = {} (up to date)", target.display());
            } else {
                bail!(
                    "{} already exists as a symlink to {} (refusing to replace non-owned symlink)",
                    target.display(),
                    existing_canon
                        .map(|p| p.display().to_string())
                        .unwrap_or_else(|| "<broken>".to_string())
                );
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
            if file_contents_match(source, target)? {
                eprintln!(
                    "  ~ would replace identical file {} -> {}",
                    target.display(),
                    source.display()
                );
            } else {
                let backup = next_backup_path(target)?;
                eprintln!(
                    "  ~ would move existing entry {} to {} and link -> {}",
                    target.display(),
                    backup.display(),
                    source.display()
                );
            }
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
    match fs::symlink_metadata(target) {
        Ok(meta) if meta.file_type().is_symlink() => {
            let source_canon = fs::canonicalize(source)
                .with_context(|| format!("canonicalize {}", source.display()))?;
            let existing_canon = fs::canonicalize(target).ok();
            if existing_canon.as_deref() == Some(source_canon.as_path()) {
                remove_symlink(target).with_context(|| format!("remove {}", target.display()))?;
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
    std::os::unix::fs::symlink(source, target)
        .with_context(|| format!("symlink {} -> {}", target.display(), source.display()))
}

#[cfg(windows)]
fn create_symlink(source: &Path, target: &Path) -> Result<()> {
    use std::os::windows::fs::{symlink_dir, symlink_file};
    let meta =
        fs::metadata(source).with_context(|| format!("stat target of {}", source.display()))?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(unix)]
    fn link_replaces_identical_regular_file_with_symlink() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let source = dir.path().join("config.toml");
        let target = dir.path().join("target-config.toml");
        fs::write(&source, "model = \"gpt-5.5\"\n")?;
        fs::write(&target, "model = \"gpt-5.5\"\n")?;

        act_link(&source, &target)?;

        let meta = fs::symlink_metadata(&target)?;
        assert!(meta.file_type().is_symlink());
        assert_eq!(fs::canonicalize(&source)?, fs::canonicalize(&target)?);
        Ok(())
    }

    #[test]
    fn dry_run_accepts_identical_regular_file() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let source = dir.path().join("settings.json");
        let target = dir.path().join("target-settings.json");
        fs::write(&source, "{\"autoUpdate\":true}\n")?;
        fs::write(&target, "{\"autoUpdate\":true}\n")?;

        act_dry_run(&source, &target)?;

        let meta = fs::symlink_metadata(&target)?;
        assert!(!meta.file_type().is_symlink());
        Ok(())
    }

    #[test]
    #[cfg(unix)]
    fn link_replaces_regular_file_that_only_drops_final_newline() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let source = dir.path().join("settings.json");
        let target = dir.path().join("target-settings.json");
        fs::write(&source, "{\"autoUpdate\":true}\n")?;
        fs::write(&target, "{\"autoUpdate\":true}")?;

        act_link(&source, &target)?;

        let meta = fs::symlink_metadata(&target)?;
        assert!(meta.file_type().is_symlink());
        assert_eq!(fs::canonicalize(&source)?, fs::canonicalize(&target)?);
        Ok(())
    }

    #[test]
    #[cfg(unix)]
    fn link_moves_different_regular_file_aside_and_symlinks() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let source = dir.path().join("config.toml");
        let target = dir.path().join("target-config.toml");
        let backup = dir.path().join("target-config.toml.agents-backup");
        fs::write(&source, "model = \"gpt-5.5\"\n")?;
        fs::write(&target, "model = \"gpt-5\"\n")?;

        act_link(&source, &target)?;

        let meta = fs::symlink_metadata(&target)?;
        assert!(meta.file_type().is_symlink());
        assert_eq!(fs::canonicalize(&source)?, fs::canonicalize(&target)?);
        assert_eq!(fs::read_to_string(backup)?, "model = \"gpt-5\"\n");
        Ok(())
    }

    #[test]
    #[cfg(unix)]
    fn package_link_creates_target_dir_and_links_file_children() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let source = dir.path().join("source-agent");
        let target = dir.path().join(".omp").join("agent");
        fs::create_dir_all(&source)?;
        fs::write(source.join("config.yml"), "setupVersion: 1\n")?;

        process_package(Mode::Link, &source, &target)?;

        let target_meta = fs::symlink_metadata(&target)?;
        assert!(target_meta.is_dir());
        assert!(!target_meta.file_type().is_symlink());
        let config_link = target.join("config.yml");
        let config_meta = fs::symlink_metadata(&config_link)?;
        assert!(config_meta.file_type().is_symlink());
        assert_eq!(
            fs::canonicalize(source.join("config.yml"))?,
            fs::canonicalize(config_link)?
        );
        Ok(())
    }

    #[test]
    #[cfg(unix)]
    fn agents_home_link_migrates_repo_owned_directory() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let root = dir.path().join("repo");
        let target = dir.path().join(".agents");
        fs::create_dir_all(root.join("rules"))?;
        fs::create_dir_all(target.join("rules"))?;
        fs::write(root.join("rules").join("cargo.md"), "cargo\n")?;
        std::os::unix::fs::symlink(
            root.join("rules").join("cargo.md"),
            target.join("rules").join("cargo.md"),
        )?;
        std::os::unix::fs::symlink(
            root.join("rules").join("deleted.md"),
            target.join("rules").join("deleted.md"),
        )?;

        act_agents_home_link(&root, &target)?;

        let meta = fs::symlink_metadata(&target)?;
        assert!(meta.file_type().is_symlink());
        assert_eq!(fs::canonicalize(&root)?, fs::canonicalize(&target)?);
        let backup = dir.path().join(".agents.agents-backup");
        assert!(
            fs::symlink_metadata(backup.join("rules").join("cargo.md"))?
                .file_type()
                .is_symlink()
        );
        Ok(())
    }
}
