use std::path::PathBuf;

use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ErrorData};
use rmcp::schemars::{self, JsonSchema};
use rmcp::{ServerHandler, tool, tool_handler, tool_router};
use serde::Deserialize;
use serde_json::json;

use crate::artifact::{self, ALL_KINDS, Artifact, ArtifactKind};
use crate::vault::{self as vault_core, SearchFilters};

use super::{ct_error_to_tool, json_success};

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct ListIn {
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    all_projects: Option<bool>,
    #[serde(default)]
    project: Option<String>,
    #[serde(default)]
    archived: Option<bool>,
    #[serde(default)]
    include_dives: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct SearchIn {
    query: String,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    project: Option<String>,
    #[serde(default)]
    archived: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct ReadIn {
    stem_or_path: String,
    #[serde(default)]
    kind: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct RelatedIn {
    topic_or_stem: String,
    #[serde(default)]
    project: Option<String>,
    #[serde(default)]
    archived: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct CreateIn {
    kind: String,
    topic: String,
    #[serde(default)]
    project: Option<String>,
    #[serde(default)]
    slug: Option<String>,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    tags: Option<Vec<String>>,
    #[serde(default)]
    dive: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct CommitIn {
    path: String,
    #[serde(default)]
    message: Option<String>,
}

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

fn parse_kind(value: Option<&str>) -> Result<Option<ArtifactKind>, ErrorData> {
    match value.unwrap_or("all") {
        "all" => Ok(None),
        "design" => Ok(Some(ArtifactKind::Design)),
        "plan" => Ok(Some(ArtifactKind::Plan)),
        "research" => Ok(Some(ArtifactKind::Research)),
        "structure" => Ok(Some(ArtifactKind::Structure)),
        "doc" | "docs" => Ok(Some(ArtifactKind::Doc)),
        other => Err(ErrorData::invalid_params(
            format!(
                "invalid artifact type {other:?}; expected all, research, design, structure, plan, or doc"
            ),
            None,
        )),
    }
}

fn resolve_optional_kind(
    stem_or_path: &str,
    kind: Option<ArtifactKind>,
) -> Result<PathBuf, ErrorData> {
    match kind {
        Some(k) => {
            artifact::resolve_artifact_path(stem_or_path, k).map_err(|e| ct_error_to_tool(e.into()))
        }
        None => {
            artifact::resolve_stem_universal(stem_or_path).map_err(|e| ct_error_to_tool(e.into()))
        }
    }
}

fn filtered_artifacts(
    kind: Option<ArtifactKind>,
    all_projects: bool,
    project: Option<String>,
    archived: bool,
    include_dives: bool,
) -> Vec<Artifact> {
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
    } else if !all_projects {
        let resolved_cwd = artifact::resolve_repo_root(&artifact::current_project());
        items.retain(|a| resolved_cwd.contains(&a.project));
    }
    items
}

#[tool_router(router = tool_router)]
impl VaultMcpServer {
    #[tool(name = "list", description = "List blueprints vault artifacts.")]
    async fn list(
        &self,
        Parameters(input): Parameters<ListIn>,
    ) -> Result<CallToolResult, ErrorData> {
        let kind = parse_kind(input.kind.as_deref())?;
        let items = filtered_artifacts(
            kind,
            input.all_projects.unwrap_or(false),
            input.project,
            input.archived.unwrap_or(false),
            input.include_dives.unwrap_or(false),
        );
        json_success(&json!({ "artifacts": items }))
    }

    #[tool(
        name = "search",
        description = "Search blueprints vault artifacts via Obsidian CLI."
    )]
    async fn search(
        &self,
        Parameters(input): Parameters<SearchIn>,
    ) -> Result<CallToolResult, ErrorData> {
        let kind = parse_kind(input.kind.as_deref())?;
        let hits = vault_core::search(
            &input.query,
            SearchFilters {
                kind,
                project: input.project,
                archived: input.archived.unwrap_or(false),
            },
        )
        .map_err(ct_error_to_tool)?;
        json_success(&json!({ "hits": hits }))
    }

    #[tool(
        name = "read",
        description = "Read a blueprints vault artifact by stem or path."
    )]
    async fn read(
        &self,
        Parameters(input): Parameters<ReadIn>,
    ) -> Result<CallToolResult, ErrorData> {
        let path = resolve_optional_kind(&input.stem_or_path, parse_kind(input.kind.as_deref())?)?;
        let artifact = artifact::read(&path).map_err(ct_error_to_tool)?;
        json_success(&artifact)
    }

    #[tool(
        name = "related",
        description = "Find related blueprints vault artifacts by topic keyword overlap."
    )]
    async fn related(
        &self,
        Parameters(input): Parameters<RelatedIn>,
    ) -> Result<CallToolResult, ErrorData> {
        let hits = vault_core::related(
            &input.topic_or_stem,
            input.project.as_deref(),
            input.archived.unwrap_or(false),
        )
        .map_err(ct_error_to_tool)?;
        json_success(&json!({ "hits": hits }))
    }

    #[tool(
        name = "status",
        description = "Show blueprints vault git and artifact status."
    )]
    async fn status(&self) -> Result<CallToolResult, ErrorData> {
        json_success(&vault_core::status_snapshot())
    }

    #[tool(
        name = "create",
        description = "Create a new blueprints vault artifact shell and return its path."
    )]
    async fn create(
        &self,
        Parameters(input): Parameters<CreateIn>,
    ) -> Result<CallToolResult, ErrorData> {
        let kind = parse_kind(Some(&input.kind))?.ok_or_else(|| {
            ErrorData::invalid_params("create requires a concrete artifact type, not all", None)
        })?;
        let project = input.project.unwrap_or_else(artifact::current_project);
        let tags = input.tags.unwrap_or_default();
        let outcome = artifact::create(artifact::CreateOpts {
            kind,
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
        name = "commit",
        description = "Commit and push edits to an existing blueprints vault artifact."
    )]
    async fn commit(
        &self,
        Parameters(input): Parameters<CommitIn>,
    ) -> Result<CallToolResult, ErrorData> {
        let outcome = artifact::commit_edits(&input.path, input.message.as_deref())
            .map_err(ct_error_to_tool)?;
        json_success(&outcome)
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
