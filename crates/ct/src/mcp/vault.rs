use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ErrorData};
use rmcp::schemars::{self, JsonSchema};
use rmcp::{ServerHandler, tool, tool_handler, tool_router};
use serde::Deserialize;
use serde_json::json;

use super::{ct_error_to_tool, json_success, project_input_to_name, require_vault, resolve};
use crate::artifact::{self, ArtifactKind, CreateOpts, CtError};
use crate::vault::{self, SearchFilters};

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, JsonSchema)]
struct CreateIn {
    #[schemars(description = "Artifact kind: spec, plan, review, report, or doc")]
    kind: ArtifactKind,
    #[schemars(description = "Short human-readable topic; drives the slug when slug is omitted")]
    topic: String,
    #[schemars(description = "Project path or name; defaults to the current project")]
    project: Option<String>,
    #[schemars(description = "Override the auto-derived slug")]
    slug: Option<String>,
    #[schemars(description = "Stem of a parent artifact to wiki-link from frontmatter")]
    source: Option<String>,
    #[schemars(description = "Additional tags appended to auto-derived type/ and project/ tags")]
    tags: Option<Vec<String>>,
    #[schemars(
        description = "If true, route the artifact to the project's dive/ subfolder (spec only, requires source)"
    )]
    dive: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct ReadIn {
    #[schemars(description = "Filename stem, vault-relative path, or absolute path")]
    stem: String,
    #[schemars(
        description = "If provided, restricts resolution to this kind; otherwise universal"
    )]
    kind: Option<ArtifactKind>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct ListIn {
    #[schemars(
        description = "Artifact kind to list; omit or set to null to list across all kinds"
    )]
    kind: Option<ArtifactKind>,
    #[schemars(description = "Project path or name; defaults to the current project")]
    project: Option<String>,
    #[schemars(description = "If true, list artifacts across all projects (default false)")]
    all: Option<bool>,
    #[schemars(description = "If true, list archived artifacts instead of active ones")]
    archived: Option<bool>,
    #[schemars(description = "If true, include dive/ files in spec listings")]
    include_dives: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct ArchiveIn {
    #[schemars(description = "Filename stem, vault-relative path, or absolute path")]
    stem: String,
    #[schemars(description = "If provided, restricts resolution to this kind")]
    kind: Option<ArtifactKind>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct PruneIn {
    #[schemars(description = "Artifact kind to prune; omit to prune across all kinds")]
    kind: Option<ArtifactKind>,
    #[schemars(description = "Age threshold in days (default 30)")]
    days: Option<u64>,
    #[schemars(description = "If true, only report what would be archived")]
    dry_run: Option<bool>,
    #[schemars(description = "Project path or name; defaults to the current project")]
    project: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct CommentsIn {
    #[schemars(description = "Filename stem, vault-relative path, or absolute path")]
    stem: String,
    #[schemars(description = "If provided, restricts resolution to this kind")]
    kind: Option<ArtifactKind>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct RenameIn {
    #[schemars(description = "Filename stem, vault-relative path, or absolute path")]
    stem: String,
    #[schemars(description = "New slug for the artifact")]
    new_slug: String,
    #[schemars(description = "If provided, restricts resolution to this kind")]
    kind: Option<ArtifactKind>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct RetagIn {
    #[schemars(description = "Filename stem, vault-relative path, or absolute path")]
    stem: String,
    #[schemars(description = "If provided, restricts resolution to this kind")]
    kind: Option<ArtifactKind>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct CommitIn {
    #[schemars(description = "Absolute or vault-relative path to the edited file")]
    path: String,
    #[schemars(
        description = "Custom commit message; defaults to '<kind>(<project>): edit <slug>'"
    )]
    message: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct SearchIn {
    #[schemars(description = "Free-text query passed to the Obsidian search CLI")]
    query: String,
    #[schemars(description = "Optional kind filter")]
    kind: Option<ArtifactKind>,
    #[schemars(description = "Optional project filter (path or name)")]
    project: Option<String>,
    #[schemars(description = "If true, include archived artifacts in results")]
    archived: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct RelatedIn {
    #[schemars(description = "Topic string whose keywords are matched against artifact slugs")]
    topic: String,
    #[schemars(description = "Project path or name; defaults to the current project")]
    project: Option<String>,
    #[schemars(description = "If true, also scan archived artifacts")]
    include_archive: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct CheckIn {
    #[schemars(description = "If true, include wiki-links found under archive/ in the report")]
    include_archive: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct StatusIn {}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub(super) struct VaultMcpServer {
    tool_router: ToolRouter<Self>,
}

impl VaultMcpServer {
    pub(super) fn new() -> Self {
        Self {
            tool_router: Self::tool_router(),
        }
    }
}

#[tool_router(router = tool_router)]
impl VaultMcpServer {
    #[tool(
        name = "create",
        description = "Create a new vault artifact (spec/plan/review/report/doc). Scaffolds frontmatter only; \
                       the caller fills in the body via file edits and then calls `commit`."
    )]
    async fn create(
        &self,
        Parameters(input): Parameters<CreateIn>,
    ) -> Result<CallToolResult, ErrorData> {
        require_vault()?;
        let project = match input.project {
            Some(p) if !p.contains('/') && !p.contains('\\') => {
                artifact::validate_project_name(&p).map_err(ct_error_to_tool)?;
                p
            }
            Some(p) => p,
            None => artifact::current_project(),
        };
        let tags: Vec<String> = input.tags.unwrap_or_default();
        let outcome = artifact::create(CreateOpts {
            kind: input.kind,
            topic: &input.topic,
            project: &project,
            slug_override: input.slug.as_deref(),
            source: input.source.as_deref(),
            user_tags: &tags,
            dive: input.dive.unwrap_or(false),
        })
        .map_err(ct_error_to_tool)?;
        json_success(&outcome)
    }

    #[tool(
        name = "read",
        description = "Read a vault artifact by stem (or path) and return parsed frontmatter, body, and \
                       inline HTML comments."
    )]
    async fn read(
        &self,
        Parameters(input): Parameters<ReadIn>,
    ) -> Result<CallToolResult, ErrorData> {
        require_vault()?;
        let path = resolve(&input.stem, input.kind)?;
        let outcome = artifact::read(&path).map_err(ct_error_to_tool)?;
        json_success(&outcome)
    }

    #[tool(
        name = "list",
        description = "List vault artifacts. Defaults to the current project; set all=true for all projects, \
                       archived=true for the archive, or omit kind to list across all kinds."
    )]
    async fn list(
        &self,
        Parameters(input): Parameters<ListIn>,
    ) -> Result<CallToolResult, ErrorData> {
        require_vault()?;
        let archived = input.archived.unwrap_or(false);
        let all = input.all.unwrap_or(false);
        let include_dives = input.include_dives.unwrap_or(false);

        let kinds: Vec<ArtifactKind> = match input.kind {
            Some(k) => vec![k],
            None => artifact::ALL_KINDS.to_vec(),
        };

        let proj_name = if all {
            None
        } else {
            Some(project_input_to_name(input.project)?)
        };

        let mut items = Vec::new();
        for kind in kinds {
            let chunk = match (&proj_name, archived) {
                (None, true) => artifact::list_archived_artifacts(kind),
                (None, false) => artifact::list_artifacts(kind, include_dives),
                (Some(p), true) => artifact::list_archived_artifacts_for_project(kind, p),
                (Some(p), false) => artifact::list_artifacts_for_project(kind, include_dives, p),
            };
            items.extend(chunk);
        }
        items.sort_by_key(|a| std::cmp::Reverse(a.mod_time));

        json_success(&json!({ "artifacts": items }))
    }

    #[tool(
        name = "archive",
        description = "Archive a vault artifact: store its content in a git note and move the file under \
                       the project's archive/ directory. Commits and pushes the change."
    )]
    async fn archive(
        &self,
        Parameters(input): Parameters<ArchiveIn>,
    ) -> Result<CallToolResult, ErrorData> {
        require_vault()?;
        let path = resolve(&input.stem, input.kind)?;
        let kind: ArtifactKind = match input.kind {
            Some(k) => k,
            None => artifact::infer_kind_from_path(&path).ok_or_else(|| {
                ErrorData::invalid_params(
                    format!("cannot infer kind from path: {}", path.display()),
                    None,
                )
            })?,
        };
        let outcome = artifact::archive(kind, &path).map_err(ct_error_to_tool)?;
        json_success(&outcome)
    }

    #[tool(
        name = "prune",
        description = "Archive vault artifacts older than `days` (default 30). Set kind to restrict to one \
                       artifact type, or omit to prune across all kinds."
    )]
    async fn prune(
        &self,
        Parameters(input): Parameters<PruneIn>,
    ) -> Result<CallToolResult, ErrorData> {
        require_vault()?;
        let days = input.days.unwrap_or(30);
        let dry_run = input.dry_run.unwrap_or(false);
        let kinds: Vec<ArtifactKind> = match input.kind {
            Some(k) => vec![k],
            None => artifact::ALL_KINDS.to_vec(),
        };
        let result = prune_kinds(&kinds, days, dry_run, input.project.as_deref());
        json_success(&result)
    }

    #[tool(
        name = "comments",
        description = "Extract inline HTML comments from a vault artifact, with line numbers offset for \
                       the file's frontmatter."
    )]
    async fn comments(
        &self,
        Parameters(input): Parameters<CommentsIn>,
    ) -> Result<CallToolResult, ErrorData> {
        require_vault()?;
        let (path, _kind) =
            artifact::resolve_optional_kind(&input.stem, input.kind).map_err(ct_error_to_tool)?;
        let outcome = artifact::read(&path).map_err(ct_error_to_tool)?;
        json_success(&json!({
            "path": path,
            "comments": outcome.comments,
        }))
    }

    #[tool(
        name = "rename",
        description = "Rename a vault artifact and update its frontmatter slug + tags. Emits a warning when \
                       incoming wiki-links to the old stem still exist elsewhere in the vault."
    )]
    async fn rename(
        &self,
        Parameters(input): Parameters<RenameIn>,
    ) -> Result<CallToolResult, ErrorData> {
        require_vault()?;
        let (path, kind) =
            artifact::resolve_optional_kind(&input.stem, input.kind).map_err(ct_error_to_tool)?;
        artifact::cmd_rename(kind, &path.to_string_lossy(), &input.new_slug)
            .map_err(|e| ct_error_to_tool(CtError::from(e)))?;
        json_success(&json!({ "renamed": input.new_slug }))
    }

    #[tool(
        name = "retag",
        description = "Fix the auto-derived `type/*` and `project/*` tags in an artifact's frontmatter."
    )]
    async fn retag(
        &self,
        Parameters(input): Parameters<RetagIn>,
    ) -> Result<CallToolResult, ErrorData> {
        require_vault()?;
        let (path, kind) =
            artifact::resolve_optional_kind(&input.stem, input.kind).map_err(ct_error_to_tool)?;
        artifact::cmd_retag(kind, &path.to_string_lossy())
            .map_err(|e| ct_error_to_tool(CtError::from(e)))?;
        json_success(&json!({ "retagged": path }))
    }

    #[tool(
        name = "commit",
        description = "Commit and push edits made to an existing vault file. Use after writing to a path \
                       returned from `create` or `read`."
    )]
    async fn commit(
        &self,
        Parameters(input): Parameters<CommitIn>,
    ) -> Result<CallToolResult, ErrorData> {
        let outcome = artifact::commit_edits(&input.path, input.message.as_deref())
            .map_err(ct_error_to_tool)?;
        json_success(&outcome)
    }

    #[tool(
        name = "search",
        description = "Search the vault via the Obsidian CLI with optional kind/project filters."
    )]
    async fn search(
        &self,
        Parameters(input): Parameters<SearchIn>,
    ) -> Result<CallToolResult, ErrorData> {
        require_vault()?;
        let filters = SearchFilters {
            kind: input.kind,
            project: input.project,
            archived: input.archived.unwrap_or(false),
        };
        let hits = vault::search(&input.query, filters).map_err(ct_error_to_tool)?;
        json_success(&json!({ "hits": hits }))
    }

    #[tool(
        name = "related",
        description = "Find vault artifacts whose slugs overlap with the given topic keywords (2+ word \
                       overlap, or 1+ for short topics)."
    )]
    async fn related(
        &self,
        Parameters(input): Parameters<RelatedIn>,
    ) -> Result<CallToolResult, ErrorData> {
        require_vault()?;
        let hits = vault::related(
            &input.topic,
            input.project.as_deref(),
            input.include_archive.unwrap_or(false),
        )
        .map_err(ct_error_to_tool)?;
        json_success(&json!({ "hits": hits }))
    }

    #[tool(
        name = "check",
        description = "Report unresolved Obsidian wiki-links in the vault."
    )]
    async fn check(
        &self,
        Parameters(input): Parameters<CheckIn>,
    ) -> Result<CallToolResult, ErrorData> {
        require_vault()?;
        let result =
            vault::check(input.include_archive.unwrap_or(false)).map_err(ct_error_to_tool)?;
        let lines: Vec<&str> = result
            .unresolved_links
            .iter()
            .map(|l| l.line.as_str())
            .collect();
        json_success(&json!({ "unresolved_links": lines }))
    }

    #[tool(
        name = "status",
        description = "Report vault state: working tree dirtiness, unpushed commits, and total artifact count."
    )]
    async fn status(
        &self,
        Parameters(_): Parameters<StatusIn>,
    ) -> Result<CallToolResult, ErrorData> {
        require_vault()?;
        let snapshot = vault::status_snapshot();
        json_success(&snapshot)
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for VaultMcpServer {
    fn get_info(&self) -> rmcp::model::ServerInfo {
        rmcp::model::ServerInfo::new(
            rmcp::model::ServerCapabilities::builder()
                .enable_tools()
                .build(),
        )
        .with_server_info(rmcp::model::Implementation::new(
            "vault",
            env!("CARGO_PKG_VERSION"),
        ))
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize)]
struct PruneOutcome {
    archived: u32,
    sync_errors: u32,
    dry_run: bool,
    candidates: Vec<String>,
}

fn prune_kinds(
    kinds: &[ArtifactKind],
    days: u64,
    dry_run: bool,
    project: Option<&str>,
) -> PruneOutcome {
    let bp = artifact::blueprints_dir();
    let threshold = std::time::Duration::from_secs(days * 86400);
    let now = std::time::SystemTime::now();
    let mut archived_count = 0u32;
    let mut sync_errors = 0u32;
    let mut candidates: Vec<String> = Vec::new();

    for kind in kinds {
        let kind_dir = kind.dir_name();
        let Ok(project_dirs) = std::fs::read_dir(&bp) else {
            continue;
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
            if *kind == ArtifactKind::Spec {
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
                    if dry_run {
                        candidates.push(path_str);
                    } else {
                        match artifact::cmd_archive(*kind, &path_str, false) {
                            Ok(()) => archived_count += 1,
                            Err(_) => sync_errors += 1,
                        }
                    }
                }
            }
        }
    }

    PruneOutcome {
        archived: archived_count,
        sync_errors,
        dry_run,
        candidates,
    }
}
