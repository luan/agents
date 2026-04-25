use std::path::PathBuf;

use anyhow::{Context, Result, bail};

const REQUIRED: &[&str] = &["stow", "just", "cargo", "codex", "claude", "opencode"];
const OPTIONAL: &[&str] = &["ct"];

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

    if !missing.is_empty() {
        bail!("missing required tools: {}", missing.join(", "));
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
