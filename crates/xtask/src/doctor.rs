use std::path::PathBuf;

use anyhow::{Context, Result, bail};

const REQUIRED: &[&str] = &["just", "cargo", "npm", "codex", "claude", "opencode"];
const OPTIONAL: &[&str] = &["ct", "wt"];

pub fn run() -> Result<()> {
    let mut missing: Vec<&str> = Vec::new();
    for tool in REQUIRED {
        match which(tool) {
            Some(p) => println!("{tool}: {}", p.display()),
            None => {
                eprintln!("missing required tool: {tool}");
                missing.push(tool);
            }
        }
    }
    for tool in OPTIONAL {
        match which(tool) {
            Some(p) => println!("{tool}: {}", p.display()),
            None => println!("{tool}: not found (optional)"),
        }
    }

    let home = dirs::home_dir().context("cannot determine HOME")?;
    let pi_dir = home.join(".pi");
    if !pi_dir.is_dir() {
        eprintln!("warning: {} does not exist yet", pi_dir.display());
    }

    let mut symlink_failed = false;
    match check_symlinks() {
        Ok(()) => println!("symlink support: ok"),
        Err(err) => {
            eprintln!("symlink support: FAILED");
            eprintln!("{err:#}");
            symlink_failed = true;
        }
    }

    let mut repo_symlinks_failed = false;
    match check_repo_symlinks() {
        Ok(()) => println!("repo symlinks: ok"),
        Err(err) => {
            eprintln!("repo symlinks: FAILED");
            eprintln!("{err:#}");
            repo_symlinks_failed = true;
        }
    }

    if !missing.is_empty() {
        bail!("missing required tools: {}", missing.join(", "));
    }
    if symlink_failed {
        bail!("symlink support is required for `cargo xtask link`");
    }
    if repo_symlinks_failed {
        bail!("repo symlinks must be materialised before `cargo xtask link`");
    }
    Ok(())
}

fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
        #[cfg(windows)]
        for ext in ["exe", "cmd", "bat"] {
            let with_ext = candidate.with_extension(ext);
            if with_ext.is_file() {
                return Some(with_ext);
            }
        }
    }
    None
}

fn check_symlinks() -> Result<()> {
    let dir = tempfile::tempdir().context("create tempdir for symlink probe")?;
    let target = dir.path().join("probe-target.txt");
    std::fs::write(&target, b"probe").context("write probe target")?;
    let link = dir.path().join("probe-link.txt");

    #[cfg(unix)]
    let res = std::os::unix::fs::symlink(&target, &link);
    #[cfg(windows)]
    let res = std::os::windows::fs::symlink_file(&target, &link);

    match res {
        Ok(()) => Ok(()),
        Err(err) => {
            #[cfg(windows)]
            {
                let dev_mode = check_developer_mode();
                let git_symlinks = check_git_symlinks();
                return Err(anyhow::anyhow!(
                    "could not create a test symlink: {err}\n  - Windows Developer Mode: {dev_mode}\n  - git core.symlinks: {git_symlinks}\n\nFix:\n  1. Enable Developer Mode: Settings -> System -> For developers -> turn ON \"Developer Mode\"\n     (or set HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AppModelUnlock\\AllowDevelopmentWithoutDevLicense = 1 in an elevated shell)\n  2. Tell Git to honour symlinks: `git config --global core.symlinks true`\n  3. Re-clone or run `git checkout -- .` so existing symlink placeholders are materialised as real symlinks."
                ));
            }
            #[cfg(unix)]
            Err(anyhow::Error::from(err).context("symlink probe failed"))
        }
    }
}

fn check_repo_symlinks() -> Result<()> {
    // These paths are tracked as symlinks in the repo. On Git for Windows the
    // default is `core.symlinks=false`, in which case git checks them out as
    // small text files containing the symlink target. If we then ran `link`,
    // we'd produce dotfile symlinks pointing at those placeholder files —
    // worse than failing outright. Detect the placeholder shape here.
    let root = crate::repo_root();
    let probes: &[&[&str]] = &[
        &["claude", "CLAUDE.md"],
        &["codex", "AGENTS.md"],
        &["opencode", "AGENTS.md"],
        &["pi", "AGENTS.md"],
    ];
    let mut bad: Vec<(PathBuf, String)> = Vec::new();
    for parts in probes {
        let mut path = root.clone();
        for p in *parts {
            path.push(p);
        }
        match std::fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_symlink() => {}
            Ok(_) => {
                let preview = std::fs::read_to_string(&path)
                    .ok()
                    .and_then(|s| s.lines().next().map(|l| l.to_string()))
                    .unwrap_or_default();
                bad.push((path, preview));
            }
            Err(err) => {
                return Err(anyhow::Error::from(err))
                    .with_context(|| format!("stat {}", path.display()));
            }
        }
    }
    if bad.is_empty() {
        return Ok(());
    }
    let mut msg = String::from(
        "the following repo paths are checked out as plain files instead of symlinks:\n",
    );
    for (p, preview) in &bad {
        msg.push_str(&format!("  - {} (content: {:?})\n", p.display(), preview));
    }
    msg.push_str(
        "\nThis is the Git-for-Windows default (core.symlinks=false). Fix:\n  1. git config --global core.symlinks true\n  2. git config core.symlinks true   # in this repo\n  3. Re-materialise just the symlink-mode files (preserves any uncommitted work):\n       git ls-files -s | awk '$1==\"120000\"{print $4}' | tr '\\n' '\\0' | xargs -0 rm -f\n       git ls-files -s | awk '$1==\"120000\"{print $4}' | tr '\\n' '\\0' | xargs -0 git checkout HEAD --\n     (Or, on a clean tree, just re-clone the repo.)",
    );
    bail!("{msg}")
}

#[cfg(windows)]
fn check_developer_mode() -> &'static str {
    use std::process::Command;
    let out = Command::new("reg")
        .args([
            "query",
            r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock",
            "/v",
            "AllowDevelopmentWithoutDevLicense",
        ])
        .output();
    match out {
        Ok(o) if o.status.success() => {
            let s = String::from_utf8_lossy(&o.stdout);
            if s.contains("0x1") {
                "enabled"
            } else {
                "disabled (registry value is not 0x1)"
            }
        }
        _ => "unknown (`reg query` failed)",
    }
}

#[cfg(windows)]
fn check_git_symlinks() -> String {
    use std::process::Command;
    let out = Command::new("git")
        .args(["config", "--get", "core.symlinks"])
        .output();
    match out {
        Ok(o) if o.status.success() => {
            let v = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if v.is_empty() { "<unset>".into() } else { v }
        }
        _ => "<unset>".into(),
    }
}
