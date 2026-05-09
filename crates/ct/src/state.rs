use std::path::{Path, PathBuf};
use std::process::Command;

use sha1::{Digest, Sha1};

pub fn state_root() -> Result<PathBuf, Box<dyn std::error::Error>> {
    Ok(match std::env::var_os("XDG_STATE_HOME") {
        Some(path) => PathBuf::from(path),
        None => dirs::home_dir()
            .ok_or("home directory unavailable")?
            .join(".local")
            .join("state"),
    }
    .join("ct"))
}

pub fn project_state_dir(root: &Path) -> Result<PathBuf, Box<dyn std::error::Error>> {
    Ok(state_root()?.join("projects").join(repo_id(root)?))
}

pub fn repo_id(root: &Path) -> Result<String, Box<dyn std::error::Error>> {
    let canonical = root.canonicalize()?;
    let mut identity = canonical.to_string_lossy().to_string();
    if let Some(top) = git_output(&canonical, &["rev-parse", "--show-toplevel"]) {
        identity = top;
    }
    if let Some(git_dir) = git_output(&canonical, &["rev-parse", "--git-common-dir"]) {
        identity.push('|');
        identity.push_str(&git_dir);
    }

    let mut hasher = Sha1::new();
    hasher.update(identity.as_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write;
        write!(&mut out, "{byte:02x}").expect("writing to String never fails");
    }
    Ok(out)
}

fn git_output(cwd: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!text.is_empty()).then_some(text)
}
