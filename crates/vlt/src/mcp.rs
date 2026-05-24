use std::path::PathBuf;

use rmcp::ServiceExt;
use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ErrorData};
use rmcp::schemars::{self, JsonSchema};
use rmcp::transport::stdio;
use rmcp::{ServerHandler, tool, tool_handler, tool_router};
use serde::Deserialize;
use serde_json::json;

use crate::artifact::{self, Artifact, ArtifactKind};
use crate::graph;
use crate::vault::{self as vault_core};

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
struct SimilarIn {
    stem_or_path: String,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    project: Option<String>,
    #[serde(default)]
    archived: Option<bool>,
    #[serde(default)]
    limit: Option<usize>,
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

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct LinkIn {
    from: String,
    to: String,
    link_type: String,
    annotation: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct UpdateIn {
    stem_or_path: String,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    append: Option<String>,
    #[serde(default)]
    replace_section: Option<String>,
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
        other => ArtifactKind::from_dir_name(other).map(Some).ok_or_else(|| {
            ErrorData::invalid_params(format!("invalid artifact type {other:?}"), None)
        }),
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
        description = "Search blueprints vault artifacts using the local BM25 index."
    )]
    async fn search(
        &self,
        Parameters(input): Parameters<SearchIn>,
    ) -> Result<CallToolResult, ErrorData> {
        let kind = parse_kind(input.kind.as_deref())?;
        let hits = graph::search(
            &input.query,
            kind,
            input.project.as_deref(),
            input.archived.unwrap_or(false),
            50,
        )
        .map_err(ct_error_to_tool)?;
        json_success(&json!({ "hits": hits }))
    }

    #[tool(
        name = "index",
        description = "Rebuild the local blueprints vault search index."
    )]
    async fn index(&self) -> Result<CallToolResult, ErrorData> {
        let outcome = graph::rebuild_index().map_err(ct_error_to_tool)?;
        json_success(&outcome)
    }

    #[tool(
        name = "similar",
        description = "Find blueprints vault artifacts similar to an artifact."
    )]
    async fn similar(
        &self,
        Parameters(input): Parameters<SimilarIn>,
    ) -> Result<CallToolResult, ErrorData> {
        let kind = parse_kind(input.kind.as_deref())?;
        let hits = graph::similar(
            &input.stem_or_path,
            kind,
            input.project.as_deref(),
            input.archived.unwrap_or(false),
            input.limit.unwrap_or(10),
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
        name = "links",
        description = "Show outgoing blueprints vault wiki-links for an artifact."
    )]
    async fn links(
        &self,
        Parameters(input): Parameters<ReadIn>,
    ) -> Result<CallToolResult, ErrorData> {
        let kind = parse_kind(input.kind.as_deref())?;
        let edges = graph::links(&input.stem_or_path, kind).map_err(ct_error_to_tool)?;
        json_success(&json!({ "links": edges }))
    }

    #[tool(
        name = "backlinks",
        description = "Show blueprints vault artifacts linking to an artifact."
    )]
    async fn backlinks(
        &self,
        Parameters(input): Parameters<ReadIn>,
    ) -> Result<CallToolResult, ErrorData> {
        let kind = parse_kind(input.kind.as_deref())?;
        let edges = graph::backlinks(&input.stem_or_path, kind).map_err(ct_error_to_tool)?;
        json_success(&json!({ "backlinks": edges }))
    }

    #[tool(
        name = "graph",
        description = "Export the blueprints vault wiki-link graph."
    )]
    async fn graph(&self) -> Result<CallToolResult, ErrorData> {
        let edges = graph::graph().map_err(ct_error_to_tool)?;
        json_success(&json!({ "edges": edges }))
    }

    #[tool(
        name = "review",
        description = "Review blueprints vault health and structural gaps."
    )]
    async fn review(&self) -> Result<CallToolResult, ErrorData> {
        let report = graph::review(12000).map_err(ct_error_to_tool)?;
        json_success(&report)
    }

    #[tool(
        name = "link",
        description = "Add a typed, annotated wiki-link between blueprints vault artifacts."
    )]
    async fn link(
        &self,
        Parameters(input): Parameters<LinkIn>,
    ) -> Result<CallToolResult, ErrorData> {
        let path = graph::add_link(&input.from, &input.to, &input.link_type, &input.annotation)
            .map_err(ct_error_to_tool)?;
        json_success(&json!({ "path": path }))
    }

    #[tool(
        name = "update",
        description = "Update a blueprints vault artifact body."
    )]
    async fn update(
        &self,
        Parameters(input): Parameters<UpdateIn>,
    ) -> Result<CallToolResult, ErrorData> {
        let kind = parse_kind(input.kind.as_deref())?;
        let edit = match (input.replace_section, input.append, input.content) {
            (Some(heading), None, Some(content)) => {
                graph::BodyEdit::ReplaceSection { heading, content }
            }
            (None, Some(content), None) => graph::BodyEdit::Append(content),
            (None, None, Some(content)) => graph::BodyEdit::Replace(content),
            _ => {
                return Err(ErrorData::invalid_params(
                    "choose exactly one of content, append, or replaceSection+content",
                    None,
                ));
            }
        };
        let path = graph::update_body(&input.stem_or_path, kind, edit, input.message.as_deref())
            .map_err(ct_error_to_tool)?;
        json_success(&json!({ "path": path }))
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

pub fn run_vault_server() -> Result<(), Box<dyn std::error::Error>> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    runtime.block_on(async {
        let service = VaultMcpServer::new().serve(stdio()).await?;
        service.waiting().await?;
        Ok::<(), Box<dyn std::error::Error>>(())
    })
}
