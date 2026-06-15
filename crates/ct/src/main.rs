mod apply_patch;
mod churn;
mod cli;
mod cochanges;
mod gitcontext;
mod hook;
mod lsp;
mod mcp;
mod notify;
mod phases;
mod refs;
mod slug;
mod state;

use clap::{CommandFactory, Parser};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = cli::Cli::parse();

    match cli.command {
        None => {
            cli::Cli::command().print_help()?;
            println!();
            Ok(())
        }
        Some(cli::Command::Repo { action }) => cli::run_repo(action),
        Some(cli::Command::Notify) => notify::run(),
        Some(cli::Command::Mcp { action }) => match action {
            cli::McpAction::ApplyPatch => mcp::run_apply_patch_server(),
            cli::McpAction::Ast => mcp::run_ast_server(),
            cli::McpAction::Lsp => mcp::run_lsp_server(),
            cli::McpAction::Vault => vlt::mcp::run_vault_server(),
        },
        Some(cli::Command::Hook { name }) => Ok(hook::run_hook(&name)?),
        Some(cli::Command::ApplyPatch(args)) => cli::run_apply_patch(args),
        Some(cli::Command::Shell { action }) => cli::run_shell(action),
        Some(cli::Command::Tui { action }) => cli::run_tui(action),
        Some(cli::Command::Dev { action }) => cli::run_dev(action),
    }
}
