mod apply_patch;
mod cli;
mod notify;
mod usage_bars;

use clap::{CommandFactory, Parser};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = cli::Cli::parse();

    match cli.command {
        None => {
            cli::Cli::command().print_help()?;
            println!();
            Ok(())
        }
        Some(cli::Command::Notify) => notify::run(),
        Some(cli::Command::ApplyPatch(args)) => cli::run_apply_patch(args),
        Some(cli::Command::Shell { action }) => cli::run_shell(action),
        Some(cli::Command::Tui { action }) => cli::run_tui(action),
    }
}
