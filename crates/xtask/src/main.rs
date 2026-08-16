use anyhow::Result;
use clap::{Parser, Subcommand};

mod doctor;
mod stow;
mod validate;

#[derive(Parser)]
#[command(name = "xtask", about = "Task automation for the agents repo")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Preview stow operations without changing the filesystem
    LinkDryRun,
    /// Stow packages into ~/
    Link,
    /// Unstow packages from their canonical install locations
    Unlink,
    /// Symlink pi/agent/node_modules -> the workspace-root node_modules
    LinkNodeModules,
    /// Run static checks, dry-run stow, and run cargo tests
    Validate,
    /// Check that required external tools are present on PATH
    Doctor,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.cmd {
        Cmd::LinkDryRun => stow::run(stow::Mode::DryRun),
        Cmd::Link => stow::run(stow::Mode::Link),
        Cmd::Unlink => stow::run(stow::Mode::Unlink),
        Cmd::LinkNodeModules => stow::link_pi_node_modules(),
        Cmd::Validate => validate::run(),
        Cmd::Doctor => doctor::run(),
    }
}

pub(crate) fn repo_root() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .map(std::path::Path::to_path_buf)
        .expect("CARGO_MANIFEST_DIR points outside the workspace")
}
