use clap::{Parser, Subcommand};

mod args;
mod tool;

pub use args::{ApplyPatchArgs, ShellAction, TuiAction};

pub fn run_apply_patch(args: ApplyPatchArgs) -> Result<(), Box<dyn std::error::Error>> {
    tool::run_apply_patch_raw(args.cwd, args.dry_run)
}

pub fn run_shell(action: ShellAction) -> Result<(), Box<dyn std::error::Error>> {
    match action {
        ShellAction::Completion { shell } => tool::run_completion(shell),
    }
}

pub fn run_tui(action: TuiAction) -> Result<(), Box<dyn std::error::Error>> {
    match action {
        TuiAction::UsageBar { width } => tool::run_usage_bar(width),
        TuiAction::UsageBars {
            width,
            sidebar,
            watch,
            interval_ms,
        } => tool::run_usage_bars(width, sidebar, watch, interval_ms),
    }
}

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
