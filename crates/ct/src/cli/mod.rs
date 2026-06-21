use clap::{Parser, Subcommand};

mod apply_patch;
mod args;
mod shell;
mod tool;
mod tui;

pub use apply_patch::run_apply_patch;
pub use args::{ApplyPatchArgs, ShellAction, TuiAction};
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
    #[command(about = "Apply patches from stdin")]
    ApplyPatch(ApplyPatchArgs),

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

    #[command(hide = true, about = "Handle notification hooks")]
    Notify,
}
