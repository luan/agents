use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ErrorData};
use rmcp::schemars::{self, JsonSchema};
use rmcp::{ServerHandler, tool, tool_handler, tool_router};
use serde::Deserialize;

#[cfg(test)]
use crate::apply_patch::Fingerprint;
use crate::apply_patch::{
    self, ApplyFailure, ApplyPatchError, ChangeType, FileChange, HunkFuzzy, HunkRegion, LineChange,
    MAX_PATCH_SIZE_BYTES, Telemetry, enrich, sha1_hex,
};

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/// Stable failure-kind label shared by MCP telemetry and repair diagnostics.
fn classify_error(err: &ApplyPatchError) -> &'static str {
    apply_patch::failure_kind(err)
}

fn enrich_failure_message(tel: &Telemetry, failure: &ApplyFailure, cwd: &Path) -> Option<String> {
    enrichable_context(&failure.error).map(|(path, chunk, anchor)| {
        let current_fp = failure
            .fingerprints
            .iter()
            .find(|(p, _)| p == path)
            .map(|(_, fp)| fp);
        // Re-read the file so the synthesizer can suggest structural
        // anchors. Cheap: enrichment only runs on failure, and the file
        // was just successfully read by `apply_patch::plan` moments ago.
        // Errors here are silent — synthesis is best-effort and never
        // worth blocking the error report.
        let abs = if std::path::Path::new(path).is_absolute() {
            std::path::PathBuf::from(path)
        } else {
            cwd.join(path)
        };
        let file_content = std::fs::read_to_string(&abs).ok();
        let ctx = enrich::EnrichContext {
            file_path: path,
            chunk_index: chunk,
            anchor_text: anchor,
            error_kind: classify_error(&failure.error),
            current_fingerprint: current_fp,
            file_content: file_content.as_deref(),
        };
        enrich::enrich(tel, failure.error.to_string(), &ctx).into_message()
    })
}

/// Map an `ApplyPatchError` to an `ErrorData` using a pre-built message and
/// optional repair block.
fn enriched_error_to_tool(
    err: &ApplyPatchError,
    message: String,
    repair_block: Option<&apply_patch::RepairBlock>,
) -> ErrorData {
    match err {
        ApplyPatchError::Parse(_)
        | ApplyPatchError::DeleteIsDirectory(_)
        | ApplyPatchError::TargetIsDirectory(_)
        | ApplyPatchError::ReadOnlyTarget(_)
        | ApplyPatchError::AddTargetExists(_)
        | ApplyPatchError::DuplicateUpdate(_)
        | ApplyPatchError::MoveTargetExists(_)
        | ApplyPatchError::LineRangeMismatch { .. }
        | ApplyPatchError::ReplacementCountMismatch { .. }
        | ApplyPatchError::OverlappingReplacements { .. }
        | ApplyPatchError::ContextNotFound { .. }
        | ApplyPatchError::AmbiguousContext { .. } => {
            ErrorData::invalid_params(message, repair_data(repair_block))
        }
        ApplyPatchError::RollbackFailed { .. } => {
            ErrorData::internal_error(message, repair_data(repair_block))
        }
        ApplyPatchError::Io { .. } => ErrorData::internal_error(message, repair_data(repair_block)),
    }
}

fn repair_data(repair_block: Option<&apply_patch::RepairBlock>) -> Option<serde_json::Value> {
    repair_block.map(|block| serde_json::json!({ "repair": block }))
}

/// Pull the (file_path, chunk_index, anchor) enrichment context out of the
/// subset of errors that reference a specific file/chunk. Returns `None` for
/// errors that don't carry that context (parse errors, duplicate updates, io).
fn enrichable_context(err: &ApplyPatchError) -> Option<(&str, usize, Option<&str>)> {
    match err {
        ApplyPatchError::ContextNotFound {
            path,
            chunk,
            change_contexts,
            ..
        } => Some((
            path.as_str(),
            *chunk,
            change_contexts.last().map(String::as_str),
        )),
        ApplyPatchError::AmbiguousContext {
            path,
            chunk,
            change_contexts,
            ..
        } => Some((
            path.as_str(),
            *chunk,
            change_contexts.last().map(String::as_str),
        )),
        ApplyPatchError::LineRangeMismatch { path, chunk, .. } => {
            Some((path.as_str(), *chunk, None))
        }
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
struct FileChangeOut<'a> {
    path: &'a str,
    #[serde(rename = "type")]
    kind: &'static str,
    additions: usize,
    deletions: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    move_path: Option<&'a str>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    fuzzy_hunks: Vec<HunkFuzzy>,
    /// Post-apply snapshot of ~10 lines around each hunk. Empty for Add/Delete
    /// and for any hunk whose change was purely additive at end-of-file.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    post_apply_regions: Vec<HunkRegion>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    line_changes: Vec<LineChange>,
    /// Only present on dry_run or when a chunk needed fuzzy matching — skip
    /// the echo on routine exact-match applies to keep responses small.
    #[serde(skip_serializing_if = "Option::is_none")]
    unified_diff: Option<&'a str>,
}

fn kind_str(k: ChangeType) -> &'static str {
    match k {
        ChangeType::Add => "add",
        ChangeType::Update => "update",
        ChangeType::Delete => "delete",
        ChangeType::Move => "move",
    }
}

fn to_out(c: &FileChange, dry_run: bool) -> FileChangeOut<'_> {
    FileChangeOut {
        path: &c.path,
        kind: kind_str(c.kind),
        additions: c.additions,
        deletions: c.deletions,
        move_path: c.move_path.as_deref(),
        fuzzy_hunks: c.fuzzy_hunks.clone(),
        post_apply_regions: c.post_apply_regions.clone(),
        line_changes: c.line_changes.clone(),
        unified_diff: if dry_run || !c.fuzzy_hunks.is_empty() {
            Some(c.unified_diff.as_str())
        } else {
            None
        },
    }
}

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, JsonSchema)]
struct ApplyPatchIn {
    #[schemars(description = "Patch body in the apply_patch envelope format")]
    patch: String,
    #[schemars(
        description = "Working directory (absolute path). Defaults to the server's process cwd"
    )]
    cwd: Option<String>,
    #[schemars(description = "If true, parse + plan but do not write to disk")]
    dry_run: Option<bool>,
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub(super) struct ApplyPatchMcpServer {
    tool_router: ToolRouter<Self>,
    telemetry: Arc<Mutex<HashMap<String, Arc<Telemetry>>>>,
}

impl ApplyPatchMcpServer {
    pub(super) fn new() -> Self {
        Self {
            tool_router: Self::tool_router(),
            telemetry: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Return the cached `Telemetry` handle for `cwd`'s project, opening one
    /// on demand. Errors are swallowed — telemetry is best-effort observability
    /// and must never break a patch apply.
    fn telemetry_for(&self, cwd: &Path) -> Option<Arc<Telemetry>> {
        let project_name = match crate::mcp::project_input_to_name(Some(cwd.display().to_string()))
        {
            Ok(name) => name,
            Err(e) => {
                eprintln!("apply-patch telemetry: project resolve: {}", e.message);
                return None;
            }
        };
        let mut guard = match self.telemetry.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(existing) = guard.get(&project_name) {
            return Some(Arc::clone(existing));
        }
        match Telemetry::open(&project_name) {
            Ok(t) => {
                let handle = Arc::new(t);
                guard.insert(project_name, Arc::clone(&handle));
                Some(handle)
            }
            Err(e) => {
                eprintln!("apply-patch telemetry: open: {e}");
                None
            }
        }
    }
}

#[tool_router(router = tool_router)]
impl ApplyPatchMcpServer {
    #[tool(
        name = "apply_patch",
        description = r#"Apply a patch (envelope format) to files. The primary file-edit tool — prefer it over Edit/Write for every change, single-file or multi-file. A single envelope can add, update, delete, or move many files at once. Prefer context over line numbers: bare `@@` is a section marker, while `@@ lines A-B` pins a hunk to an explicit original-file line range.

Envelope shape:

*** Begin Patch
[optional *** Intent: ... and/or *** Environment ID: ... preamble]
[ one or more file sections ]
*** End Patch

Each file section starts with one of these headers:

*** Add File: <path>      — create a new file. Every following line is a + line (the initial contents).
*** Delete File: <path>   — remove an existing file. Nothing follows.
*** Update File: <path>   — patch an existing file in place (optionally with a rename).
*** Move File: <old> -> <new> — rename without an update body.
*** Replace All In File: <path> — guarded whole-file replacement, followed by `*** Expect Replacements: N`.
*** Update Scope: <path> — semantic update targeted by a single `@@ <scope locator>` marker.

`*** Update File:` may be immediately followed by `*** Move to: <new path>` to rename. Then one or more hunks, each introduced by `@@` (bare, followed by an anchor line, or `@@ lines A-B`). Within a hunk each line is prefixed with ` ` (context), `-` (removed), or `+` (added).

Anchors — the anchor line is *consumed* and the pattern search resumes on the line *after* it. So:
- Don't repeat the anchor text as your first ` ` context line. That's the most common shape error and the tool rejects it explicitly.
- Pick something structurally unique *near* the change (an import line above the function, a `struct` or `impl` header, a doc comment), not the function signature you're editing. Signatures collide when several functions share a similar shape.
- Bare `@@` is fine — use it whenever the surrounding context already pins the hunk uniquely.
- Stack multiple `@@ <line>` markers to narrow into a nested location. Each anchor advances the cursor past its own match before the next one (or the body) is searched. Useful when no single line near the change is unique:

      @@ impl Bar for Baz
      @@     fn run(&self) {
      -        return;
      +        return 42;
- Author ordinary context hunks top-to-bottom within a single `Update File`. Matching is cursor-forward: after one hunk lands, later context searches start below it. If an edit must target an earlier location, reorder the hunks or use `@@ lines A-B`.
- Use `@@ lines A-B` sparingly for exact original-file ranges. The body must match those inclusive lines, and line-ranged hunks must not overlap any other hunk in the same `Update File`.

Context: include *as little as makes the hunk unique* — often 1-2 lines, and zero when the `-` line alone is distinctive (a unique string, a fully qualified name, a rare function signature). Generic lines (`    return;`, `}`, bare `None`) almost always need at least one neighbor for disambiguation. If the hunk matches multiple locations the patch is rejected with every candidate line number; add one line above or below until only one remains, or pin with a `@@ <unique line>` anchor. Wider context isn't safer — it just gives concurrent edits more surface to drift against.

Example combining all operations:

*** Begin Patch
*** Add File: hello.txt
+Hello world
*** Update File: src/app.py
*** Move to: src/main.py
@@ def greet():
-    print("Hi")
+    print("Hello, world!")
*** Delete File: obsolete.txt
*** End Patch

Rules:
- Paths can be relative (joined with cwd) or absolute.
- Include a header (Add/Delete/Update) for each file section. New-file lines are prefixed with `+`.
- Multiple plain `*** Update File:` sections for the same path are normalized into one update, then the normal ordering and overlap checks apply.
- To atomically replace a file, put a `*** Delete File:` before the `*** Add File:` (or `*** Move to:`) for the same path in the same envelope.

On context mismatch the error returns a numbered window of the current file state, so you can regenerate the patch without having to re-read the file.

On success each updated file echoes `post_apply_regions` — a small numbered window of the file as it will exist after the patch lands, around each hunk — so you can plan follow-up edits without re-reading.

Set `dry_run` to true to preview the unified diff without writing."#
    )]
    async fn apply_patch(
        &self,
        Parameters(input): Parameters<ApplyPatchIn>,
    ) -> Result<CallToolResult, ErrorData> {
        if input.patch.len() > MAX_PATCH_SIZE_BYTES {
            return Err(ErrorData::invalid_params(
                format!("patch exceeds {MAX_PATCH_SIZE_BYTES} byte limit"),
                None,
            ));
        }
        let cwd = match input.cwd {
            Some(s) => std::path::PathBuf::from(s),
            None => std::env::current_dir()
                .map_err(|e| ErrorData::internal_error(format!("cwd: {e}"), None))?,
        };
        if !cwd.is_dir() {
            return Err(ErrorData::invalid_params(
                format!("cwd is not a directory: {}", cwd.display()),
                None,
            ));
        }
        let dry_run = input.dry_run.unwrap_or(false);
        let tel = self.telemetry_for(&cwd);
        let start = Instant::now();
        let patch_sha = sha1_hex(input.patch.as_bytes());

        match apply_patch::apply(&input.patch, &cwd, dry_run) {
            Ok(outcome) => {
                if let Some(tel) = tel.as_ref()
                    && let Err(e) = apply_patch::repair::record_success(
                        tel,
                        &outcome,
                        start.elapsed().as_micros() as u64,
                        &patch_sha,
                        &input.patch,
                    )
                {
                    eprintln!("apply-patch telemetry: {e}");
                }
                let files: Vec<FileChangeOut> =
                    outcome.changes.iter().map(|c| to_out(c, dry_run)).collect();
                super::json_success(&serde_json::json!({
                    "dry_run": dry_run,
                    "files": files,
                }))
            }
            Err(failure) => {
                let duration_us = start.elapsed().as_micros() as u64;
                let enriched_message = tel
                    .as_ref()
                    .and_then(|tel| enrich_failure_message(tel, &failure, &cwd));
                let artifacts = apply_patch::repair::handle_failure(
                    tel.as_deref(),
                    &cwd,
                    &failure,
                    duration_us,
                    &patch_sha,
                    &input.patch,
                );
                let repair_text = artifacts.repair_block.render_compact();
                let ApplyFailure { error, .. } = *failure;
                let message = enriched_message.unwrap_or_else(|| error.to_string());
                Err(enriched_error_to_tool(
                    &error,
                    format!("{message}\n\n{repair_text}"),
                    Some(&artifacts.repair_block),
                ))
            }
        }
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for ApplyPatchMcpServer {
    fn get_info(&self) -> rmcp::model::ServerInfo {
        rmcp::model::ServerInfo::new(
            rmcp::model::ServerCapabilities::builder()
                .enable_tools()
                .build(),
        )
        .with_server_info(rmcp::model::Implementation::new(
            "apply-patch",
            env!("CARGO_PKG_VERSION"),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression: enrichment must read `last_fingerprint` BEFORE the current
    /// call upserts it. Previously `record_failure` upserted first, which
    /// overwrote the previous generation's fingerprint, so the stale-read
    /// comparison always saw equal mtimes and the hint never fired.
    #[test]
    fn mcp_error_data_carries_repair_block() {
        let block = apply_patch::RepairBlock {
            patch_id: "patch".into(),
            telemetry_id: Some("apt-call-1".into()),
            diagnostic_id: Some("apd-1".into()),
            failure_kind: "context_not_found".into(),
            anchors: vec!["bare @@".into()],
            report_command: "ct apply-patch report apd-1".into(),
            next_action: "inspect draft".into(),
            draft_created: true,
        };
        let err = enriched_error_to_tool(
            &ApplyPatchError::ContextNotFound {
                path: "main.rs".into(),
                chunk: 0,
                change_contexts: Vec::new(),
                first_old_line: None,
                near_miss: None,
            },
            format!("failed\n\n{}", block.render_compact()),
            Some(&block),
        );
        assert!(err.message.contains("repair:"));
        assert_eq!(
            err.data.unwrap()["repair"]["diagnostic_id"],
            serde_json::Value::String("apd-1".into())
        );
    }

    #[test]
    fn stale_read_hint_fires_through_failure_recording_path() {
        let tel = Telemetry::open_in_memory().unwrap();
        // Seed the previous generation: file was last seen at mtime=100.
        tel.upsert_fingerprint(
            "foo.rs",
            &Fingerprint {
                mtime_ns: 100,
                sha1: "aaaaaaaa11".into(),
                ts: 1,
            },
        )
        .unwrap();

        // Current call sees mtime=200 (file changed on disk) and fails with a
        // context-not-found error.
        let failure = ApplyFailure {
            error: ApplyPatchError::ContextNotFound {
                path: "foo.rs".into(),
                chunk: 0,
                change_contexts: Vec::new(),
                first_old_line: None,
                near_miss: None,
            },
            attempts: Vec::new(),
            fingerprints: vec![(
                "foo.rs".into(),
                Fingerprint {
                    mtime_ns: 200,
                    sha1: "bbbbbbbb22".into(),
                    ts: 2,
                },
            )],
        };

        let message = enrich_failure_message(&tel, &failure, std::path::Path::new("/tmp"))
            .expect("enrichable context produces a message");
        apply_patch::repair::handle_failure(
            Some(&tel),
            std::path::Path::new("/tmp"),
            &failure,
            0,
            "patchsha",
            "body",
        );
        assert!(message.contains("mtime changed"), "message was: {message}");
        assert!(message.contains("aaaaaaaa"), "message was: {message}");
        assert!(message.contains("bbbbbbbb"), "message was: {message}");

        // Post-condition: the upsert still lands, so the NEXT call sees the
        // current fingerprint as the "previous" one.
        let stored = tel.last_fingerprint("foo.rs").unwrap().unwrap();
        assert_eq!(stored.mtime_ns, 200);
        assert_eq!(stored.sha1, "bbbbbbbb22");
    }
}
