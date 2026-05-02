use clap::{Parser, Subcommand};

mod apply_patch;
mod args;
mod artifact;
pub(crate) mod ast;
mod dev;
mod lens;
mod lsp;
mod patch;
mod repo;
mod shell;
pub(crate) mod source;
mod tool;
mod tui;

pub use apply_patch::run_apply_patch;
pub use args::{
    ApplyPatchArgs, DevAction, LensAction, McpAction, RepoAction, ShellAction, SourceAction,
    TaskAction, TuiAction, VaultAction, parse_kind_filter,
};
pub use artifact::{
    ArtifactCreateArgs, run_vault_archive, run_vault_comments, run_vault_create, run_vault_list,
    run_vault_prune, run_vault_read, run_vault_rename, run_vault_retag,
};
pub use dev::run_dev;
pub use lens::run_lens;
pub use repo::run_repo;
pub use shell::run_shell;
pub use source::run_source;
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
    #[command(about = "Read-only source code search and navigation")]
    Source {
        #[command(subcommand)]
        action: SourceAction,
    },

    #[command(about = "Lens code intelligence and edit-safety state")]
    Lens {
        #[command(subcommand)]
        action: LensAction,
    },

    #[command(visible_alias = "v", about = "Vault operations")]
    Vault {
        #[command(subcommand)]
        action: VaultAction,
    },

    #[command(about = "Repository and git analysis")]
    Repo {
        #[command(subcommand)]
        action: RepoAction,
    },

    #[command(about = "Project task storage")]
    Task {
        #[command(subcommand)]
        action: TaskAction,
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
            help = "Hook name: apply-patch-remind, source-remind, notify, gt-session-start, gt-validate-git, lens-turn-event, rtk-rewrite"
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

pub(crate) fn handle_sync_error(e: crate::artifact::SyncError) -> ! {
    eprintln!("{e}");
    match e {
        crate::artifact::SyncError::Push(_) => std::process::exit(2),
        _ => std::process::exit(1),
    }
}

pub(crate) fn truncate_at_char_boundary(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut idx = max_bytes;
    while idx > 0 && !s.is_char_boundary(idx) {
        idx -= 1;
    }
    &s[..idx]
}
