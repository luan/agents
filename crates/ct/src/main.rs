mod ansi;
mod apply_patch;
mod artifact;
mod churn;
mod cli;
mod cochanges;
mod gitcontext;
mod hook;
pub mod lens;
mod lsp;
mod mcp;
mod notify;
mod phases;
mod refs;
mod slug;
mod vault;

use clap::{CommandFactory, Parser};

fn dispatch_vault(action: cli::VaultAction) -> Result<(), Box<dyn std::error::Error>> {
    let cwd = std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    match action {
        cli::VaultAction::List {
            kind,
            json,
            all,
            project,
            archived,
            include_dives,
        } => {
            let kind = cli::parse_kind_filter(&kind);
            cli::run_vault_list(kind, &cwd, json, all, project, archived, include_dives)
        }
        cli::VaultAction::Create {
            kind,
            topic,
            project,
            slug,
            source,
            tags,
            dive,
        } => {
            let kind = cli::parse_kind_filter(&kind).expect("clap rejects 'all' for create");
            cli::run_vault_create(cli::ArtifactCreateArgs {
                kind,
                topic,
                project,
                slug,
                source,
                tags,
                dive,
            })
        }
        cli::VaultAction::Read {
            kind,
            file,
            frontmatter,
        } => {
            let kind = cli::parse_kind_filter(&kind);
            cli::run_vault_read(kind, file, frontmatter)
        }
        cli::VaultAction::Archive {
            kind,
            file,
            batch,
            dry_run,
        } => {
            let kind = cli::parse_kind_filter(&kind);
            cli::run_vault_archive(kind, file, batch, dry_run)
        }
        cli::VaultAction::Prune {
            kind,
            days,
            dry_run,
            project,
        } => {
            let kind = cli::parse_kind_filter(&kind);
            cli::run_vault_prune(kind, days, dry_run, project)
        }
        cli::VaultAction::Comments { kind, file, json } => {
            let kind = cli::parse_kind_filter(&kind);
            cli::run_vault_comments(kind, file, json)
        }
        cli::VaultAction::Rename {
            kind,
            old,
            new_slug,
        } => {
            let kind = cli::parse_kind_filter(&kind);
            cli::run_vault_rename(kind, old, new_slug)
        }
        cli::VaultAction::Retag { kind, file } => {
            let kind = cli::parse_kind_filter(&kind);
            cli::run_vault_retag(kind, file)
        }
        cli::VaultAction::Related {
            project,
            topic,
            archive,
        } => {
            let project = project.unwrap_or_else(artifact::current_project);
            vault::cmd_related(&project, &topic, archive);
            Ok(())
        }
        cli::VaultAction::Check { archive } => {
            vault::cmd_check(archive);
            Ok(())
        }
        cli::VaultAction::Search {
            query,
            json,
            kind,
            project,
            archive,
        } => {
            let kind = kind.as_deref().and_then(cli::parse_kind_filter);
            vault::cmd_search(&query, json, kind, project.as_deref(), archive);
            Ok(())
        }
        cli::VaultAction::Status => {
            vault::cmd_status();
            Ok(())
        }
        cli::VaultAction::Commit { path, message } => {
            vault::cmd_commit(&path, message);
            Ok(())
        }
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = cli::Cli::parse();

    match cli.command {
        None => {
            cli::Cli::command().print_help()?;
            println!();
            Ok(())
        }
        Some(cli::Command::Vault { action }) => dispatch_vault(action),
        Some(cli::Command::Repo { action }) => cli::run_repo(action),
        Some(cli::Command::Notify) => notify::run(),
        Some(cli::Command::Source { action }) => cli::run_source(action),
        Some(cli::Command::Lens { action }) => cli::run_lens(action),
        Some(cli::Command::Mcp { action }) => match action {
            cli::McpAction::Source => mcp::run_source_server(),
            cli::McpAction::Vault => mcp::run_vault_server(),
            cli::McpAction::ApplyPatch => mcp::run_apply_patch_server(),
            cli::McpAction::Sym => mcp::run_sym_server(),
            cli::McpAction::Ast => mcp::run_ast_server(),
            cli::McpAction::Lens => mcp::run_lens_server(),
            cli::McpAction::Lsp => mcp::run_lsp_server(),
        },
        Some(cli::Command::Hook { name }) => Ok(hook::run_hook(&name)?),
        Some(cli::Command::ApplyPatch(args)) => cli::run_apply_patch(args),
        Some(cli::Command::Shell { action }) => cli::run_shell(action),
        Some(cli::Command::Tui { action }) => cli::run_tui(action),
        Some(cli::Command::Dev { action }) => cli::run_dev(action),
    }
}
