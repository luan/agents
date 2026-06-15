use clap::{Parser, Subcommand};

mod apply_patch;
mod args;
pub(crate) mod ast;
mod dev;
mod lsp;
mod patch;
mod repo;
mod shell;
mod tool;
mod tui;

pub use apply_patch::run_apply_patch;
pub use args::{ApplyPatchArgs, DevAction, McpAction, RepoAction, ShellAction, TuiAction};
pub use dev::run_dev;
pub use repo::run_repo;
pub use shell::run_shell;
pub use tui::run_tui;

#[derive(Parser)]
#[command(name = "ct")]
#[command(about = "Claude Tool CLI", long_about = None)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<Command>,
}

#[derive(Subcommand)]
pub enum Command {
    #[command(about = "Repository and git analysis")]
    Repo {
        #[command(subcommand)]
        action: RepoAction,
    },

    #[command(about = "Apply patches and inspect apply_patch telemetry")]
    ApplyPatch(ApplyPatchArgs),

    #[command(about = "Run the MCP stdio server")]
    Mcp {
        #[command(subcommand)]
        action: McpAction,
    },

    #[command(about = "Run a harness hook")]
    Hook {
        #[arg(
            help = "Hook name: apply-patch-remind, notify, gt-session-start, gt-validate-git, rtk-rewrite"
        )]
        name: String,
    },

    #[command(about = "Shell integration helpers")]
    Shell {
        #[command(subcommand)]
        action: ShellAction,
    },

    #[command(about = "Terminal UI helpers")]
    Tui {
        #[command(subcommand)]
        action: TuiAction,
    },

    #[command(about = "Developer/internal helpers")]
    Dev {
        #[command(subcommand)]
        action: DevAction,
    },

    #[command(hide = true, visible_alias = "n", about = "Handle notification hooks")]
    Notify,
}
