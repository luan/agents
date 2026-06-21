use clap::{Args, Subcommand};
use clap_complete::Shell;

#[derive(Args)]
pub struct ApplyPatchArgs {
    #[arg(long, help = "Working directory for raw apply; default: process cwd")]
    pub cwd: Option<String>,

    #[arg(long, help = "Preview raw apply without writing to disk")]
    pub dry_run: bool,
}

#[derive(Subcommand)]
pub enum ShellAction {
    #[command(about = "Generate shell completion scripts")]
    Completion {
        #[arg(help = "Shell type (bash, zsh, fish, powershell, elvish)")]
        shell: Shell,
    },
}

#[derive(Subcommand)]
pub enum TuiAction {
    #[command(about = "Render subscription usage bars from JSON on stdin")]
    UsageBar {
        #[arg(long, default_value_t = 80, help = "Terminal width in cells")]
        width: usize,
    },
    #[command(about = "Render subscription usage bars for all local providers")]
    UsageBars {
        #[arg(long, default_value_t = 80, help = "Terminal width in cells")]
        width: usize,
        #[arg(long, help = "Render the tmux mux-sidebar layout")]
        sidebar: bool,
        #[arg(long, help = "Continuously redraw and reload config changes")]
        watch: bool,
        #[arg(
            long,
            default_value_t = 1000,
            help = "Watch redraw interval in milliseconds"
        )]
        interval_ms: u64,
    },
}
