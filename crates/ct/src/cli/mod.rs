use clap::{Parser, Subcommand};

mod args;
mod artifact;
mod tool;

pub use args::{ApplyPatchCmd, McpAction, ToolAction, VaultAction, parse_kind_filter};
pub use artifact::{
    ArtifactCreateArgs, run_vault_archive, run_vault_comments, run_vault_create, run_vault_list,
    run_vault_prune, run_vault_read, run_vault_rename, run_vault_retag,
};
pub use tool::{
    run_apply_patch, run_apply_patch_prune, run_apply_patch_stats, run_cochanges, run_completion,
    run_slug,
};

#[derive(Parser)]
#[command(name = "ct")]
#[command(about = "Claude Tool CLI", long_about = None)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<Command>,
}

#[derive(Subcommand)]
pub enum Command {
    #[command(visible_alias = "v", about = "Vault operations")]
    Vault {
        #[command(subcommand)]
        action: VaultAction,
    },

    #[command(about = "Print detected project name")]
    Project,

    #[command(visible_alias = "n", about = "Handle notification hooks")]
    Notify,

    #[command(visible_alias = "o", about = "Utility tools")]
    Tool {
        #[command(subcommand)]
        action: ToolAction,
    },

    #[command(about = "Code indexing and symbol discovery")]
    Sym(sym::cli::SymArgs),

    #[command(about = "Run the MCP stdio server")]
    Mcp {
        #[command(subcommand)]
        action: McpAction,
    },

    #[command(about = "Run a harness hook")]
    Hook {
        #[arg(
            help = "Hook name: apply-patch-remind, codex-sym-nudge, gt-session-start, gt-validate-git, rtk-rewrite"
        )]
        name: String,
    },

    #[command(about = "Inspect or prune apply_patch telemetry")]
    ApplyPatch {
        #[command(subcommand)]
        cmd: ApplyPatchCmd,
    },
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
