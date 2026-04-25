mod ansi;
mod apply_patch;
mod artifact;
mod churn;
mod cli;
mod cochanges;
mod gitcontext;
mod hook;
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
        Some(cli::Command::Project) => {
            vault::cmd_project();
            Ok(())
        }
        Some(cli::Command::Notify) => notify::run(),
        Some(cli::Command::Sym(args)) => sym::run(args).map_err(|e| e.into()),
        Some(cli::Command::Mcp { action }) => match action {
            cli::McpAction::Vault => mcp::run_vault_server(),
            cli::McpAction::ApplyPatch => mcp::run_apply_patch_server(),
            cli::McpAction::Sym => mcp::run_sym_server(),
        },
        Some(cli::Command::Hook { name }) => Ok(hook::run_hook(&name)?),
        Some(cli::Command::Tool { action }) => match action {
            cli::ToolAction::Slug { words } => cli::run_slug(words),
            cli::ToolAction::Phases { file } => phases::run_phases(file),
            cli::ToolAction::Completion { shell } => cli::run_completion(shell),
            cli::ToolAction::Gitcontext {
                base,
                format,
                max_total,
                max_file,
                stat,
                cochanges,
            } => gitcontext::run(base, format, max_total, max_file, stat, cochanges),
            cli::ToolAction::CheckRefs { file, project_root } => refs::run(file, project_root),
            cli::ToolAction::Cochanges {
                base,
                threshold,
                min_commits,
                max_files,
                num_commits,
            } => cli::run_cochanges(base, threshold, min_commits, max_files, num_commits),
            cli::ToolAction::Churn {
                project_root,
                since,
                min_loc,
            } => churn::run(project_root, since, min_loc),
            cli::ToolAction::ApplyPatch { cwd, dry_run } => cli::run_apply_patch(cwd, dry_run),
        },
        Some(cli::Command::ApplyPatch { cmd }) => match cmd {
            cli::ApplyPatchCmd::Stats { all_projects, days } => {
                cli::run_apply_patch_stats(all_projects, days)
            }
            cli::ApplyPatchCmd::Prune { days } => cli::run_apply_patch_prune(days),
        },
    }
}
