use super::{handle_sync_error, truncate_at_char_boundary};
use crate::ansi;
use crate::artifact::{self, ALL_KINDS, Artifact, ArtifactKind, CtError};

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
    let mut items: Vec<Artifact> = match kind {
        Some(k) => {
            if archived {
                artifact::list_archived_artifacts(k)
            } else {
                artifact::list_artifacts(k, include_dives)
            }
        }
        None => {
            let mut combined = Vec::new();
            for k in ALL_KINDS {
                let chunk = if archived {
                    artifact::list_archived_artifacts(k)
                } else {
                    artifact::list_artifacts(k, include_dives)
                };
                combined.extend(chunk);
            }
            combined.sort_by_key(|a| std::cmp::Reverse(a.mod_time));
            combined
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

    let label = match kind {
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
                "{:<12} {:<30} {:<42} {:<12} SIZE",
                "PROJECT", "NAME", "TITLE", "MODIFIED"
            ))
        );
        println!("{}", ansi::dim(&"-".repeat(100)));

        for a in &items {
            let proj = artifact::project_name(&a.project);

            let name = if a.name.len() > 28 {
                format!("{}...", truncate_at_char_boundary(&a.name, 25))
            } else {
                a.name.clone()
            };

            let title = if a.title.len() > 40 {
                format!("{}...", truncate_at_char_boundary(&a.title, 37))
            } else {
                a.title.clone()
            };

            let title_col = format!("{title:<42}");
            println!(
                "{} {} {} {} {}",
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
) -> Result<(), Box<dyn std::error::Error>> {
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
// Comments
// ---------------------------------------------------------------------------

pub fn run_vault_comments(
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
    artifact::cmd_comments(&path.to_string_lossy(), resolved_kind, json);
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
            let pair = match artifact::resolve_optional_kind(entry, kind) {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("{e}");
                    std::process::exit(1);
                }
            };
            resolved.push(pair);
        }
        let first_kind = resolved[0].1;
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
                match artifact::archive(first_kind, path) {
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
        eprintln!("Usage: ct vault archive <file> or ct vault archive --batch <file1> <file2> ...");
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
        None => ALL_KINDS.to_vec(),
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
        if kind == ArtifactKind::Spec {
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
                    match artifact::cmd_archive(kind, &path_str, false) {
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
