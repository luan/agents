use std::env;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use xtask::harness::{run, Operation};

fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("xtask must remain under crates/xtask")
        .to_path_buf()
}

fn parse_args() -> Result<(Operation, PathBuf)> {
    let mut args = env::args().skip(1);
    if args.next().as_deref() != Some("harness") {
        anyhow::bail!("usage: cargo xtask harness <setup|check|unlink> [--home <path>]");
    }
    let operation = match args.next().as_deref() {
        Some("setup") => Operation::Setup,
        Some("check") => Operation::Check,
        Some("unlink") => Operation::Unlink,
        _ => anyhow::bail!("usage: cargo xtask harness <setup|check|unlink> [--home <path>]"),
    };
    let mut home = env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .context("HOME or USERPROFILE is required")?;
    while let Some(argument) = args.next() {
        if argument != "--home" {
            anyhow::bail!("unknown argument: {argument}");
        }
        home = PathBuf::from(args.next().context("--home requires a path")?);
    }
    Ok((operation, home))
}

fn main() -> Result<()> {
    let (operation, home) = parse_args()?;
    run(operation, &workspace_root(), &home)
}
