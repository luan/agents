use crate::ansi;
use crate::artifact::{self, ALL_KINDS, Artifact, ArtifactKind, CtError};
use crate::graph;
use clap::Subcommand;

/// Parse a `-t` argument into an optional kind. `"all"` yields cross-kind
/// operation. Unknown valid names are custom artifact directories.
pub fn parse_kind_filter(s: &str) -> Option<ArtifactKind> {
    match s {
        "all" => None,
        _ => match ArtifactKind::from_dir_name(s) {
            Some(kind) => Some(kind),
            None => {
                eprintln!("invalid artifact type: {s}");
                std::process::exit(2);
            }
        },
    }
}

#[derive(Subcommand)]
pub enum Command {
    #[command(about = "List artifacts (defaults to current project)")]
    List {
        #[arg(short = 't', long = "type", default_value = "all", num_args = 0..=1, default_missing_value = "__types__", help = "Artifact type filter ('all' for cross-kind); pass without a value to list available types")]
        kind: String,
        #[arg(long, help = "Output as JSON")]
        json: bool,
        #[arg(long, help = "Show artifacts from all projects")]
        all: bool,
        #[arg(short, long, help = "Filter by project path")]
        project: Option<String>,
        #[arg(long, help = "Show archived artifacts instead of active")]
        archived: bool,
        #[arg(long, help = "Include dive/ files (research only)")]
        include_dives: bool,
    },

    #[command(about = "Create a new artifact")]
    Create {
        #[arg(
            short = 't',
            long = "type",
            help = "Artifact type; custom type directories are allowed"
        )]
        kind: String,
        #[arg(long, help = "Artifact topic")]
        topic: String,
        #[arg(long, help = "Project path (defaults to current git repo / cwd)")]
        project: Option<String>,
        #[arg(long, help = "Custom slug (auto-generated if omitted)")]
        slug: Option<String>,
        #[arg(long, help = "Source artifact stem for [[wiki-link]]")]
        source: Option<String>,
        #[arg(
            long,
            help = "Comma-separated tags (e.g. domain/combat,stage/research)"
        )]
        tags: Option<String>,
        #[arg(
            long,
            help = "Route to dive/ instead of research/ (requires --source; research only)"
        )]
        dive: bool,
        #[arg(long, help = "Output JSON")]
        json: bool,
    },

    #[command(about = "Read artifact body or frontmatter (universal stem resolution by default)")]
    Read {
        #[arg(
            short = 't',
            long = "type",
            default_value = "all",
            help = "Restrict resolution to this artifact type"
        )]
        kind: String,
        #[arg(help = "File path or stem")]
        file: String,
        #[arg(long, help = "Output frontmatter as JSON")]
        frontmatter: bool,
        #[arg(long, help = "Output JSON envelope")]
        json: bool,
        #[arg(
            long,
            help = "Include linked artifacts reachable within N outgoing hops"
        )]
        depth: Option<usize>,
    },

    #[command(about = "Build the local vault search index")]
    Index {
        #[arg(long, help = "Output JSON")]
        json: bool,
    },

    #[command(about = "Move an artifact to archive/")]
    Archive {
        #[arg(
            short = 't',
            long = "type",
            default_value = "all",
            help = "Restrict resolution to this artifact type"
        )]
        kind: String,
        #[arg(help = "File path or stem")]
        file: Option<String>,
        #[arg(long, num_args = 1.., help = "Batch archive multiple files")]
        batch: Vec<String>,
        #[arg(long, help = "Preview what would be archived without acting")]
        dry_run: bool,
        #[arg(long, help = "Output JSON")]
        json: bool,
    },

    #[command(about = "Archive artifacts older than N days")]
    Prune {
        #[arg(
            short = 't',
            long = "type",
            default_value = "all",
            help = "Restrict to this artifact type"
        )]
        kind: String,
        #[arg(long, default_value_t = 30, help = "Age threshold in days")]
        days: u64,
        #[arg(long, help = "Dry run - print what would be archived")]
        dry_run: bool,
        #[arg(short, long, help = "Filter by project path")]
        project: Option<String>,
        #[arg(long, help = "Output JSON")]
        json: bool,
    },

    #[command(about = "Rename an artifact and update its frontmatter")]
    Rename {
        #[arg(
            short = 't',
            long = "type",
            default_value = "all",
            help = "Restrict resolution to this artifact type"
        )]
        kind: String,
        #[arg(help = "Current file path or stem")]
        old: String,
        #[arg(help = "New slug for the file")]
        new_slug: String,
        #[arg(long, help = "Output JSON")]
        json: bool,
    },

    #[command(about = "Fix auto-derived tags (type/*, project/*) in frontmatter")]
    Retag {
        #[arg(
            short = 't',
            long = "type",
            default_value = "all",
            help = "Restrict resolution to this artifact type"
        )]
        kind: String,
        #[arg(help = "File path or stem")]
        file: String,
        #[arg(long, help = "Output JSON")]
        json: bool,
    },

    #[command(about = "Find related artifacts by topic keyword overlap")]
    Related {
        #[arg(long, help = "Project path (defaults to current git repo / cwd)")]
        project: Option<String>,
        #[arg(help = "Topic to match against")]
        topic: String,
        #[arg(long, help = "Include archived artifacts")]
        archive: bool,
        #[arg(long, help = "Output JSON")]
        json: bool,
    },

    #[command(about = "Check for unresolved wiki-links (via Obsidian CLI)")]
    Check {
        #[arg(long, help = "Include archived artifacts")]
        archive: bool,
        #[arg(long, help = "Output JSON")]
        json: bool,
    },

    #[command(about = "Read, update, and validate project context docs")]
    Context {
        #[command(subcommand)]
        command: ContextCommand,
    },

    #[command(about = "Search artifacts using the local BM25 index")]
    Search {
        #[arg(help = "Search query")]
        query: String,
        #[arg(long, help = "Output as JSON")]
        json: bool,
        #[arg(long = "type", help = "Filter by artifact type")]
        kind: Option<String>,
        #[arg(short, long, help = "Filter by project path")]
        project: Option<String>,
        #[arg(long, help = "Include archived artifacts")]
        archive: bool,
    },

    #[command(about = "Find artifacts similar to an artifact using the local BM25 index")]
    Similar {
        #[arg(help = "File path or stem")]
        file: String,
        #[arg(
            long = "type",
            default_value = "all",
            help = "Restrict resolution to this artifact type"
        )]
        kind: String,
        #[arg(short, long, help = "Filter by project path")]
        project: Option<String>,
        #[arg(long, help = "Include archived artifacts")]
        archive: bool,
        #[arg(long, default_value_t = 10, help = "Maximum results")]
        limit: usize,
        #[arg(long, help = "Output JSON")]
        json: bool,
    },

    #[command(about = "Add a typed, annotated wiki-link from one artifact to another")]
    Link {
        #[arg(help = "Source artifact path or stem")]
        from: String,
        #[arg(help = "Target artifact path or stem")]
        to: String,
        #[arg(
            long = "type",
            help = "Relationship type, e.g. source-of, supersedes, implements"
        )]
        link_type: String,
        #[arg(long, help = "Required relationship annotation")]
        annotation: String,
        #[arg(long, help = "Output JSON")]
        json: bool,
    },

    #[command(about = "Show outgoing typed wiki-links for an artifact")]
    Links {
        #[arg(help = "File path or stem")]
        file: String,
        #[arg(
            short = 't',
            long = "type",
            default_value = "all",
            help = "Restrict resolution to this artifact type"
        )]
        kind: String,
        #[arg(long, help = "Output JSON")]
        json: bool,
    },

    #[command(about = "Show artifacts that link to an artifact")]
    Backlinks {
        #[arg(help = "File path or stem")]
        file: String,
        #[arg(
            short = 't',
            long = "type",
            default_value = "all",
            help = "Restrict resolution to this artifact type"
        )]
        kind: String,
        #[arg(long, help = "Output JSON")]
        json: bool,
    },

    #[command(about = "Export vault wiki-link graph")]
    Graph {
        #[arg(long, help = "Output JSON")]
        json: bool,
    },

    #[command(about = "Review vault health and structural gaps")]
    Review {
        #[arg(
            long,
            default_value_t = 12000,
            help = "Body length threshold for long artifacts"
        )]
        long_threshold: usize,
        #[arg(long, help = "Output JSON")]
        json: bool,
    },

    #[command(about = "Update an artifact body and commit the edit")]
    Update {
        #[arg(help = "File path or stem")]
        file: String,
        #[arg(
            short = 't',
            long = "type",
            default_value = "all",
            help = "Restrict resolution to this artifact type"
        )]
        kind: String,
        #[arg(long, help = "Replace the whole body with this content")]
        content: Option<String>,
        #[arg(long, help = "Read replacement or append content from stdin")]
        stdin: bool,
        #[arg(long, help = "Append content to the existing body")]
        append: Option<String>,
        #[arg(long, help = "Replace the content under a level-2 heading")]
        replace_section: Option<String>,
        #[arg(long, help = "Commit message override")]
        message: Option<String>,
        #[arg(long, help = "Output JSON")]
        json: bool,
    },

    #[command(about = "Show vault status (git state, artifact count)")]
    Status {
        #[arg(long, help = "Output JSON")]
        json: bool,
    },

    #[command(about = "Commit and push edits to a vault file")]
    Commit {
        #[arg(help = "Absolute or vault-relative path to the edited file")]
        path: String,
        #[arg(
            long,
            help = "Commit message (defaults to '<kind>(<project>): edit <slug>')"
        )]
        message: Option<String>,
        #[arg(long, help = "Output JSON")]
        json: bool,
    },

    #[command(about = "Serve the vault MCP server over stdio")]
    Mcp,
}

#[derive(Subcommand)]
pub enum ContextCommand {
    #[command(about = "List root and named context docs")]
    List {
        #[arg(long, help = "Project path (defaults to current git repo / cwd)")]
        project: Option<String>,
        #[arg(long, help = "Output JSON")]
        json: bool,
    },
    #[command(about = "Show a context doc body")]
    Show {
        #[arg(help = "Context name; omit for root CONTEXT.md, use 'map' for CONTEXT-MAP.md")]
        name: Option<String>,
        #[arg(long, help = "Project path (defaults to current git repo / cwd)")]
        project: Option<String>,
        #[arg(long, help = "Output JSON")]
        json: bool,
    },
    #[command(about = "Create or replace a glossary term in a context doc")]
    Set {
        #[arg(help = "Canonical term")]
        term: String,
        #[arg(long, help = "One or two sentence term definition")]
        definition: String,
        #[arg(long, value_delimiter = ',', help = "Comma-separated aliases to avoid")]
        avoid: Vec<String>,
        #[arg(long, help = "Named context; omit for root CONTEXT.md")]
        context: Option<String>,
        #[arg(long, help = "Project path (defaults to current git repo / cwd)")]
        project: Option<String>,
        #[arg(long, help = "Output JSON")]
        json: bool,
    },
    #[command(about = "Validate context-map links and context layout")]
    Check {
        #[arg(long, help = "Project path (defaults to current git repo / cwd)")]
        project: Option<String>,
        #[arg(long, help = "Output JSON")]
        json: bool,
    },
}

pub fn dispatch(command: Command) -> Result<(), Box<dyn std::error::Error>> {
    let cwd = std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    match command {
        Command::List {
            kind,
            json,
            all,
            project,
            archived,
            include_dives,
        } => {
            if kind == "__types__" {
                run_vault_types(json)
            } else {
                run_vault_list(
                    parse_kind_filter(&kind),
                    &cwd,
                    json,
                    all,
                    project,
                    archived,
                    include_dives,
                )
            }
        }
        Command::Create {
            kind,
            topic,
            project,
            slug,
            source,
            tags,
            dive,
            json,
        } => {
            let kind = parse_kind_filter(&kind).expect("clap rejects 'all' for create");
            run_vault_create(ArtifactCreateArgs {
                kind,
                topic,
                project,
                slug,
                source,
                tags,
                dive,
                json,
            })
        }
        Command::Read {
            kind,
            file,
            frontmatter,
            json,
            depth,
        } => run_vault_read(parse_kind_filter(&kind), file, frontmatter, json, depth),
        Command::Index { json } => graph::cmd_index(json),
        Command::Archive {
            kind,
            file,
            batch,
            dry_run,
            json,
        } => run_vault_archive(parse_kind_filter(&kind), file, batch, dry_run, json),
        Command::Prune {
            kind,
            days,
            dry_run,
            project,
            json,
        } => run_vault_prune(parse_kind_filter(&kind), days, dry_run, project, json),
        Command::Rename {
            kind,
            old,
            new_slug,
            json,
        } => run_vault_rename(parse_kind_filter(&kind), old, new_slug, json),
        Command::Retag { kind, file, json } => {
            run_vault_retag(parse_kind_filter(&kind), file, json)
        }
        Command::Related {
            project,
            topic,
            archive,
            json,
        } => {
            let project = project.unwrap_or_else(artifact::current_project);
            crate::vault::cmd_related(&project, &topic, archive, json);
            Ok(())
        }
        Command::Check { archive, json } => {
            crate::vault::cmd_check(archive, json);
            Ok(())
        }
        Command::Context { command } => run_context_command(command),
        Command::Search {
            query,
            json,
            kind,
            project,
            archive,
        } => {
            let kind = kind.as_deref().and_then(parse_kind_filter);
            graph::cmd_search(&query, kind, project.as_deref(), archive, json);
            Ok(())
        }
        Command::Similar {
            file,
            kind,
            project,
            archive,
            limit,
            json,
        } => {
            graph::cmd_similar(
                &file,
                parse_kind_filter(&kind),
                project.as_deref(),
                archive,
                limit,
                json,
            );
            Ok(())
        }
        Command::Link {
            from,
            to,
            link_type,
            annotation,
            json,
        } => {
            graph::cmd_link(&from, &to, &link_type, &annotation, json);
            Ok(())
        }
        Command::Links { file, kind, json } => {
            graph::cmd_links(&file, parse_kind_filter(&kind), json);
            Ok(())
        }
        Command::Backlinks { file, kind, json } => {
            graph::cmd_backlinks(&file, parse_kind_filter(&kind), json);
            Ok(())
        }
        Command::Graph { json } => {
            graph::cmd_graph(json);
            Ok(())
        }
        Command::Review {
            long_threshold,
            json,
        } => {
            graph::cmd_review(long_threshold, json);
            Ok(())
        }
        Command::Update {
            file,
            kind,
            content,
            stdin,
            append,
            replace_section,
            message,
            json,
        } => {
            graph::cmd_update(graph::UpdateCommand {
                file: &file,
                kind: parse_kind_filter(&kind),
                content,
                stdin,
                append,
                replace_section_heading: replace_section,
                message,
                json,
            });
            Ok(())
        }
        Command::Status { json } => {
            crate::vault::cmd_status(json);
            Ok(())
        }
        Command::Commit {
            path,
            message,
            json,
        } => {
            crate::vault::cmd_commit(&path, message, json);
            Ok(())
        }
        Command::Mcp => crate::mcp::run_vault_server(),
    }
}

fn run_context_command(command: ContextCommand) -> Result<(), Box<dyn std::error::Error>> {
    match command {
        ContextCommand::List { project, json } => {
            let docs = crate::context::list(project.as_deref());
            if json {
                println!("{}", serde_json::to_string(&docs)?);
            } else if docs.is_empty() {
                eprintln!("{}", ansi::dim("No context docs found."));
            } else {
                println!(
                    "{}",
                    ansi::bold(&format!("{:<12} {:<18} PATH", "KIND", "NAME"))
                );
                println!("{}", ansi::dim(&"-".repeat(80)));
                for doc in docs {
                    println!(
                        "{} {:<18} {}",
                        ansi::dim(&format!("{:<12}", format!("{:?}", doc.kind).to_lowercase())),
                        doc.name,
                        doc.path.display()
                    );
                }
            }
            Ok(())
        }
        ContextCommand::Show {
            name,
            project,
            json,
        } => {
            let path = crate::context::resolve(project.as_deref(), name.as_deref())?;
            let content = std::fs::read_to_string(&path)?;
            if json {
                println!(
                    "{}",
                    serde_json::to_string(&serde_json::json!({
                        "path": path,
                        "content": content,
                    }))?
                );
            } else {
                print!("{content}");
            }
            Ok(())
        }
        ContextCommand::Set {
            term,
            definition,
            avoid,
            context,
            project,
            json,
        } => {
            let path = crate::context::set_term(
                project.as_deref(),
                context.as_deref(),
                &term,
                &definition,
                &avoid,
            )?;
            if json {
                println!(
                    "{}",
                    serde_json::to_string(&serde_json::json!({
                        "updated": true,
                        "path": path,
                    }))?
                );
            } else {
                println!("updated {}", path.display());
            }
            Ok(())
        }
        ContextCommand::Check { project, json } => {
            let result = crate::context::check(project.as_deref());
            if json {
                println!("{}", serde_json::to_string(&result)?);
            } else if result.ok {
                println!("context ok");
            } else {
                for problem in &result.problems {
                    eprintln!("problem: {problem}");
                }
            }
            Ok(())
        }
    }
}

pub(crate) fn handle_sync_error(e: artifact::SyncError) -> ! {
    eprintln!("{e}");
    match e {
        artifact::SyncError::Push(_) => std::process::exit(2),
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

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

pub fn run_vault_list(
    kind: Option<ArtifactKind>,
    cwd: &str,
    json: bool,
    all: bool,
    project: Option<String>,
    archived: bool,
    include_dives: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut items: Vec<Artifact> = match &kind {
        Some(k) => {
            if archived {
                artifact::list_archived_artifacts(k.clone())
            } else {
                artifact::list_artifacts(k.clone(), include_dives)
            }
        }
        None => {
            if archived {
                artifact::list_all_archived_artifacts()
            } else {
                artifact::list_all_artifacts(include_dives)
            }
        }
    };

    items.retain(|a| !a.project.is_empty());

    if let Some(ref proj) = project {
        let resolved = artifact::resolve_repo_root(proj);
        items.retain(|a| a.project.contains(resolved.as_str()));
    } else if !all {
        let resolved_cwd = artifact::resolve_repo_root(cwd);
        items.retain(|a| resolved_cwd.contains(&a.project));
    }

    let label = match &kind {
        Some(k) => k.dir_name(),
        None => "artifact",
    };

    if items.is_empty() {
        if all {
            eprintln!(
                "{}",
                ansi::dim(&format!("No {label}s found in ~/blueprints/"))
            );
        } else {
            eprintln!(
                "{}",
                ansi::dim(&format!(
                    "No {label}s found for current project. Use --all to show all {label}s."
                ))
            );
        }
        return Ok(());
    }

    if json {
        let json_items: Vec<_> = items
            .iter()
            .map(|a| {
                serde_json::json!({
                    "name": a.name,
                    "title": a.title,
                    "type": artifact_type(a),
                    "project": artifact::project_name(&a.project),
                    "modified": artifact::format_date(a.mod_time),
                    "size": artifact::format_size(a.size),
                    "created": a.created,
                    "source": a.source,
                    "tags": a.tags,
                    "author": a.author,
                })
            })
            .collect();
        println!("{}", serde_json::to_string(&json_items)?);
    } else {
        println!(
            "{}",
            ansi::bold(&format!(
                "{:<12} {:<10} {:<30} {:<40} {:<12} SIZE",
                "PROJECT", "TYPE", "NAME", "TITLE", "MODIFIED"
            ))
        );
        println!("{}", ansi::dim(&"-".repeat(112)));

        for a in &items {
            let proj = artifact::project_name(&a.project);
            let artifact_type = artifact_type(a);
            let type_col = if artifact_type.len() > 10 {
                format!("{}...", truncate_at_char_boundary(&artifact_type, 7))
            } else {
                artifact_type
            };

            let name = if a.name.len() > 28 {
                format!("{}...", truncate_at_char_boundary(&a.name, 25))
            } else {
                a.name.clone()
            };

            let title = if a.title.len() > 38 {
                format!("{}...", truncate_at_char_boundary(&a.title, 35))
            } else {
                a.title.clone()
            };

            let title_col = format!("{title:<40}");
            println!(
                "{} {type_col:<10} {} {} {} {}",
                ansi::id(&format!("{proj:<12}")),
                ansi::dim(&format!("{name:<30}")),
                title_col,
                ansi::dim(&format!("{:<12}", artifact::format_date(a.mod_time))),
                ansi::dim(&artifact::format_size(a.size))
            );
        }
    }

    Ok(())
}

fn artifact_type(a: &Artifact) -> String {
    a.path
        .parent()
        .and_then(|parent| parent.file_name())
        .and_then(|name| name.to_str())
        .unwrap_or("")
        .to_string()
}

pub fn run_vault_types(json: bool) -> Result<(), Box<dyn std::error::Error>> {
    let mut types: Vec<String> = discover_kinds()
        .into_iter()
        .map(|kind| kind.dir_name().to_string())
        .collect();
    types.sort();
    types.dedup();
    if json {
        println!("{}", serde_json::to_string(&types)?);
    } else {
        for kind in &types {
            println!("{kind}");
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

pub struct ArtifactCreateArgs {
    pub kind: ArtifactKind,
    pub topic: String,
    pub project: Option<String>,
    pub slug: Option<String>,
    pub source: Option<String>,
    pub tags: Option<String>,
    pub dive: bool,
    pub json: bool,
}

pub fn run_vault_create(args: ArtifactCreateArgs) -> Result<(), Box<dyn std::error::Error>> {
    let ArtifactCreateArgs {
        kind,
        topic,
        project,
        slug,
        source,
        tags,
        dive,
        json,
    } = args;
    let tag_list: Vec<String> = tags
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let project = project.unwrap_or_else(artifact::current_project);
    match artifact::create(artifact::CreateOpts {
        kind,
        topic: &topic,
        project: &project,
        slug_override: slug.as_deref(),
        source: source.as_deref(),
        user_tags: &tag_list,
        dive,
    }) {
        Ok(outcome) => {
            if json {
                println!(
                    "{}",
                    serde_json::to_string(&serde_json::json!({"path": outcome.path}))?
                );
            } else {
                println!("{}", outcome.path.display());
            }
        }
        Err(CtError::Sync(e)) => handle_sync_error(e),
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

pub fn run_vault_read(
    kind: Option<ArtifactKind>,
    file: String,
    frontmatter: bool,
    json: bool,
    depth: Option<usize>,
) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(depth) = depth {
        graph::cmd_read_depth(&file, kind, depth, json);
        return Ok(());
    }
    let resolved = match kind {
        Some(k) => match artifact::resolve_artifact_path(&file, k) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("{e}");
                std::process::exit(1);
            }
        },
        None => match artifact::resolve_stem_universal(&file) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("{e}");
                std::process::exit(1);
            }
        },
    };
    if json {
        let content = std::fs::read_to_string(&resolved)?;
        let artifact = artifact::read(&resolved)?;
        let (title, project, created, source, tags, author) =
            artifact::extract_frontmatter_full_from_str(&content);
        println!(
            "{}",
            serde_json::to_string(&serde_json::json!({
                "path": resolved,
                "body": artifact.body,
                "frontmatter": {
                    "title": title,
                    "project": project,
                    "created": created,
                    "source": source,
                    "tags": tags,
                    "author": author,
                },
            }))?
        );
    } else {
        artifact::cmd_read_resolved(&resolved, frontmatter);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Archive
// ---------------------------------------------------------------------------

pub fn run_vault_archive(
    kind: Option<ArtifactKind>,
    file: Option<String>,
    batch: Vec<String>,
    dry_run: bool,
    json: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut json_paths: Vec<String> = Vec::new();
    let mut json_destinations: Vec<String> = Vec::new();
    if !batch.is_empty() {
        // Resolve each entry, infer kind from first entry when kind is None,
        // and require all entries to share the same kind.
        let mut resolved: Vec<(std::path::PathBuf, ArtifactKind)> = Vec::with_capacity(batch.len());
        for entry in &batch {
            let pair = match artifact::resolve_optional_kind(entry, kind.clone()) {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("{e}");
                    std::process::exit(1);
                }
            };
            resolved.push(pair);
        }
        let first_kind = resolved[0].1.clone();
        for (path, k) in &resolved[1..] {
            if *k != first_kind {
                eprintln!(
                    "mixed kinds in batch: expected {}, got {} for {}",
                    first_kind.dir_name(),
                    k.dir_name(),
                    path.display()
                );
                std::process::exit(1);
            }
        }
        let paths: Vec<std::path::PathBuf> = resolved.into_iter().map(|(p, _)| p).collect();
        json_paths = paths
            .iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect();
        if json && !dry_run {
            for path in &paths {
                match artifact::archive(first_kind.clone(), path) {
                    Ok(outcome) => {
                        json_destinations.push(outcome.path.to_string_lossy().to_string())
                    }
                    Err(artifact::CtError::Sync(e)) => handle_sync_error(e),
                    Err(e) => {
                        eprintln!("{e}");
                        std::process::exit(1);
                    }
                }
            }
        } else if json && dry_run {
        } else if let Err(e) = artifact::cmd_archive_batch(first_kind, &json_paths, dry_run) {
            handle_sync_error(e);
        }
    } else if let Some(f) = file {
        let (path, resolved_kind) = match artifact::resolve_optional_kind(&f, kind) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("{e}");
                std::process::exit(1);
            }
        };
        json_paths.push(path.to_string_lossy().to_string());
        if json && !dry_run {
            match artifact::archive(resolved_kind, &path) {
                Ok(outcome) => json_destinations.push(outcome.path.to_string_lossy().to_string()),
                Err(artifact::CtError::Sync(e)) => handle_sync_error(e),
                Err(e) => {
                    eprintln!("{e}");
                    std::process::exit(1);
                }
            }
        } else if json && dry_run {
        } else if let Err(e) =
            artifact::cmd_archive(resolved_kind, &path.to_string_lossy(), dry_run)
        {
            handle_sync_error(e);
        }
    } else {
        eprintln!("Usage: vlt archive <file> or vlt archive --batch <file1> <file2> ...");
        std::process::exit(1);
    }
    if json {
        println!(
            "{}",
            serde_json::to_string(&serde_json::json!({
                "archived": !dry_run,
                "dry_run": dry_run,
                "paths": json_paths,
                "destinations": json_destinations,
            }))?
        );
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Prune
// ---------------------------------------------------------------------------

pub fn run_vault_prune(
    kind: Option<ArtifactKind>,
    days: u64,
    dry_run: bool,
    project: Option<String>,
    json: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let kinds: Vec<ArtifactKind> = match kind {
        Some(k) => vec![k],
        None => discover_kinds(),
    };
    let mut total_archived = 0u32;
    let mut sync_errors = 0u32;
    for k in kinds {
        let (archived, errors) = prune_kind(k, days, dry_run, project.as_deref(), !json);
        total_archived += archived;
        sync_errors += errors;
    }
    if json {
        println!(
            "{}",
            serde_json::to_string(
                &serde_json::json!({"archived": total_archived, "sync_errors": sync_errors, "dry_run": dry_run})
            )?
        );
    } else if !dry_run && total_archived > 0 {
        println!("Archived {total_archived} file(s)");
    }
    if sync_errors > 0 {
        eprintln!("{sync_errors} file(s) failed to sync");
        std::process::exit(2);
    }
    Ok(())
}

fn prune_kind(
    kind: ArtifactKind,
    days: u64,
    dry_run: bool,
    project: Option<&str>,
    print_dry_run: bool,
) -> (u32, u32) {
    let bp = artifact::blueprints_dir();
    let kind_dir = kind.dir_name();
    let threshold = std::time::Duration::from_secs(days * 86400);
    let now = std::time::SystemTime::now();
    let mut archived_count = 0u32;
    let mut sync_errors = 0u32;

    let Ok(project_dirs) = std::fs::read_dir(&bp) else {
        return (0, 0);
    };

    for dir_entry in project_dirs.flatten() {
        if !dir_entry.path().is_dir() {
            continue;
        }
        let dir_name = dir_entry.file_name().to_string_lossy().to_string();
        if dir_name == "archive" {
            continue;
        }
        if let Some(proj) = project {
            let resolved = artifact::project_name(&artifact::resolve_repo_root(proj));
            if !dir_name.contains(resolved.as_str()) {
                continue;
            }
        }

        let mut scan_dirs = vec![dir_entry.path().join(kind_dir)];
        if kind == ArtifactKind::Research {
            scan_dirs.push(dir_entry.path().join("dive"));
        }
        for artifact_dir in scan_dirs {
            let Ok(files) = std::fs::read_dir(&artifact_dir) else {
                continue;
            };
            for file_entry in files.flatten() {
                let path = file_entry.path();
                if path.is_dir() || path.extension().is_none_or(|ext| ext != "md") {
                    continue;
                }
                let Ok(meta) = file_entry.metadata() else {
                    continue;
                };
                let Ok(modified) = meta.modified() else {
                    continue;
                };
                let Ok(age) = now.duration_since(modified) else {
                    continue;
                };
                if age < threshold {
                    continue;
                }

                let path_str = path.to_string_lossy().to_string();
                if dry_run && print_dry_run {
                    println!("would archive: {path_str}");
                } else if dry_run {
                } else {
                    match artifact::cmd_archive(kind.clone(), &path_str, false) {
                        Ok(()) => archived_count += 1,
                        Err(e) => {
                            eprintln!("{e}");
                            sync_errors += 1;
                        }
                    }
                }
            }
        }
    }

    (archived_count, sync_errors)
}

fn discover_kinds() -> Vec<ArtifactKind> {
    let bp = artifact::blueprints_dir();
    let mut seen = std::collections::HashSet::new();
    let mut kinds = Vec::new();
    for kind in ALL_KINDS {
        seen.insert(kind.dir_name().to_string());
        kinds.push(kind);
    }
    let Ok(projects) = std::fs::read_dir(&bp) else {
        return kinds;
    };
    for project in projects.flatten() {
        let path = project.path();
        if !path.is_dir() {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&path) else {
            continue;
        };
        for entry in entries.flatten() {
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            let name = dir.file_name().unwrap_or_default().to_string_lossy();
            if name.starts_with('.')
                || name == "archive"
                || name == "dive"
                || !dir_contains_md(&dir)
            {
                continue;
            }
            if seen.insert(name.to_string())
                && let Some(kind) = ArtifactKind::from_dir_name(&name)
            {
                kinds.push(kind);
            }
        }
    }
    kinds
}

fn dir_contains_md(dir: &std::path::Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    entries.flatten().any(|entry| {
        let path = entry.path();
        path.is_file() && path.extension().is_some_and(|ext| ext == "md")
    })
}

// ---------------------------------------------------------------------------
// Rename / Retag
// ---------------------------------------------------------------------------

pub fn run_vault_rename(
    kind: Option<ArtifactKind>,
    old: String,
    new_slug: String,
    json: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let (path, resolved_kind) = match artifact::resolve_optional_kind(&old, kind) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    };
    if let Err(e) = artifact::cmd_rename(resolved_kind, &path.to_string_lossy(), &new_slug) {
        handle_sync_error(e);
    } else if json {
        println!(
            "{}",
            serde_json::to_string(
                &serde_json::json!({"renamed": true, "old": path, "new_slug": new_slug})
            )?
        );
    }
    Ok(())
}

pub fn run_vault_retag(
    kind: Option<ArtifactKind>,
    file: String,
    json: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let (path, resolved_kind) = match artifact::resolve_optional_kind(&file, kind) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    };
    if let Err(e) = artifact::cmd_retag(resolved_kind, &path.to_string_lossy()) {
        handle_sync_error(e);
    } else if json {
        println!(
            "{}",
            serde_json::to_string(&serde_json::json!({"retagged": true, "path": path}))?
        );
    }
    Ok(())
}
