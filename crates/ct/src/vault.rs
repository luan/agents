use std::collections::HashSet;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::process;

use serde::Serialize;

use crate::artifact::{ALL_KINDS, ArtifactKind, CtError, blueprints_dir, fatal, project_name};

pub fn cmd_project() {
    let toplevel = process::Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|| {
            env::current_dir()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|_| fatal("cannot determine working directory"))
        });
    let project = crate::artifact::resolve_repo_root(&toplevel);
    println!("{}", project_name(&project));
}

/// A related artifact found by topic keyword overlap.
#[derive(Debug, Clone, Serialize)]
pub struct RelatedHit {
    pub stem: String,
    pub path: PathBuf,
    pub title: String,
}

/// Core: find artifacts in `project` whose slug shares enough keywords with `topic`.
/// `project` — if None, uses the current repo root. Wiki-link stems only, deduped.
pub fn related(
    topic: &str,
    project: Option<&str>,
    include_archive: bool,
) -> Result<Vec<RelatedHit>, CtError> {
    let topic_words: HashSet<&str> = topic
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.len() >= 3)
        .collect();

    if topic_words.is_empty() {
        return Ok(Vec::new());
    }

    let bp = blueprints_dir();
    let project_str = project
        .map(|p| p.to_string())
        .unwrap_or_else(crate::artifact::current_project);
    let resolved = crate::artifact::resolve_repo_root(&project_str);
    let proj_name = project_name(&resolved);
    let proj_dir = bp.join(&proj_name);

    if !proj_dir.is_dir() {
        return Ok(Vec::new());
    }

    let mut seen = HashSet::new();
    let mut hits = Vec::new();

    for kind in ALL_KINDS {
        let mut dirs_to_scan = vec![proj_dir.join(kind.dir_name())];
        if include_archive {
            dirs_to_scan.push(proj_dir.join("archive").join(kind.dir_name()));
        }
        for scan_dir in dirs_to_scan {
            let Ok(entries) = fs::read_dir(&scan_dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().is_none_or(|ext| ext != "md") {
                    continue;
                }
                let stem = path
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                let slug_part = crate::artifact::strip_date_prefix(&stem);
                let slug_words: HashSet<&str> = slug_part
                    .split(|c: char| !c.is_alphanumeric())
                    .filter(|w| w.len() >= 3)
                    .collect();
                let overlap = topic_words.intersection(&slug_words).count();
                if (overlap >= 2 || (topic_words.len() <= 2 && overlap >= 1))
                    && seen.insert(stem.clone())
                {
                    hits.push(RelatedHit {
                        stem,
                        path,
                        title: String::new(),
                    });
                }
            }
        }
    }
    Ok(hits)
}

pub fn cmd_related(project: &str, topic: &str, include_archive: bool, json: bool) {
    let hits = match related(topic, Some(project), include_archive) {
        Ok(h) => h,
        Err(e) => {
            eprintln!("{e}");
            return;
        }
    };
    if json {
        match serde_json::to_string(&hits) {
            Ok(body) => println!("{body}"),
            Err(e) => eprintln!("serialize: {e}"),
        }
    } else {
        for hit in &hits {
            println!("[[{}]]", hit.stem);
        }
    }
}

/// An unresolved wiki-link, as reported by the Obsidian CLI.
#[derive(Debug, Clone, Serialize)]
pub struct UnresolvedLink {
    pub line: String,
}

/// Result of a vault-wide link check.
#[derive(Debug, Clone, Serialize)]
pub struct VaultCheckResult {
    pub unresolved_links: Vec<UnresolvedLink>,
}

/// Core: run `obsidian unresolved` in the vault and collect its output lines.
/// Always returns the lines actually emitted; stderr/exit status are surfaced
/// via `CtError::Validation` when the tool fails to run at all.
pub fn check(include_archive: bool) -> Result<VaultCheckResult, CtError> {
    let bp = blueprints_dir();
    let output = process::Command::new("obsidian")
        .args(["unresolved"])
        .current_dir(&bp)
        .output()
        .map_err(|e| CtError::Validation(format!("failed to run obsidian cli: {e}")))?;
    let text = String::from_utf8_lossy(&output.stdout);
    let mut unresolved = Vec::new();
    for line in text.lines() {
        if !include_archive && line.contains("archive/") {
            continue;
        }
        unresolved.push(UnresolvedLink {
            line: line.to_string(),
        });
    }
    Ok(VaultCheckResult {
        unresolved_links: unresolved,
    })
}

pub fn cmd_check(include_archive: bool, json: bool) {
    match check(include_archive) {
        Ok(result) => {
            if json {
                match serde_json::to_string(&result) {
                    Ok(body) => println!("{body}"),
                    Err(e) => eprintln!("serialize: {e}"),
                }
            } else {
                for link in &result.unresolved_links {
                    println!("{}", link.line);
                }
            }
        }
        Err(e) => eprintln!("{e}"),
    }
}

/// Filters for `search`.
#[derive(Debug, Clone, Default)]
pub struct SearchFilters {
    pub kind: Option<ArtifactKind>,
    pub project: Option<String>,
    pub archived: bool,
}

/// A single search hit. Only fields the Obsidian CLI actually gives us are
/// exposed — title/kind/project aren't cheaply recoverable from plain output
/// and were previously returned as empty strings.
#[derive(Debug, Clone, Serialize)]
pub struct SearchHit {
    pub path: PathBuf,
    pub raw_line: String,
}

/// Core: shell out to `obsidian search` with the given query, filter lines by
/// kind/project/archive, and return structured hits. CLI wrapper prints lines
/// verbatim (JSON or plain) so existing skills don't break.
pub fn search(query: &str, filters: SearchFilters) -> Result<Vec<SearchHit>, CtError> {
    let bp = blueprints_dir();
    let args = vec!["search".to_string(), format!("query={query}")];
    let output = process::Command::new("obsidian")
        .args(&args)
        .current_dir(&bp)
        .output()
        .map_err(|e| CtError::Validation(format!("failed to run obsidian cli: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(CtError::Validation(stderr.trim().to_string()));
    }

    let text = String::from_utf8_lossy(&output.stdout);
    let proj_prefix = filters.project.as_deref().map(|p| {
        let resolved = crate::artifact::resolve_repo_root(p);
        let name = project_name(&resolved);
        format!("{name}/")
    });
    let kind_dir = filters.kind.map(|k| format!("{}/", k.dir_name()));

    let mut hits = Vec::new();
    for line in text.lines() {
        if !filters.archived && line.contains("archive/") {
            continue;
        }
        let matches_kind = kind_dir.as_deref().is_none_or(|d| line.contains(d));
        let matches_proj = proj_prefix.as_deref().is_none_or(|p| line.contains(p));
        if matches_kind && matches_proj {
            hits.push(SearchHit {
                path: PathBuf::from(line),
                raw_line: line.to_string(),
            });
        }
    }
    Ok(hits)
}

pub fn cmd_search(
    query: &str,
    json: bool,
    kind_filter: Option<ArtifactKind>,
    project: Option<&str>,
    include_archive: bool,
) {
    let filters = SearchFilters {
        kind: kind_filter,
        project: project.map(|s| s.to_string()),
        archived: include_archive,
    };
    match search(query, filters) {
        Ok(hits) if json => match serde_json::to_string(&hits) {
            Ok(body) => println!("{body}"),
            Err(e) => eprintln!("serialize: {e}"),
        },
        Ok(hits) => {
            for hit in &hits {
                println!("{}", hit.raw_line);
            }
        }
        Err(e) => eprintln!("{e}"),
    }
}

pub fn cmd_commit(path: &str, message: Option<String>, json: bool) {
    match crate::artifact::commit_edits(path, message.as_deref()) {
        Ok(outcome) => {
            if json {
                match serde_json::to_string(
                    &serde_json::json!({"committed": outcome.committed, "message": outcome.message}),
                ) {
                    Ok(body) => println!("{body}"),
                    Err(e) => eprintln!("serialize: {e}"),
                }
            } else if outcome.committed {
                println!("{}", outcome.message);
            } else {
                eprintln!("nothing to commit: {path}");
            }
        }
        Err(CtError::Sync(crate::artifact::SyncError::Push(msg))) => {
            eprintln!("git push failed: {msg}");
            std::process::exit(2);
        }
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    }
}

/// Structured snapshot of the vault's git + artifact state. Reused by both the
/// CLI `status` printer and the MCP `status` tool.
#[derive(Debug, Clone, Serialize)]
pub struct VaultStatus {
    pub working_tree_dirty: Option<usize>,
    pub unpushed_commits: usize,
    pub has_upstream: bool,
    pub artifacts: usize,
}

pub fn status_snapshot() -> VaultStatus {
    let bp = blueprints_dir();
    let bp_str = bp.to_string_lossy();

    let working_tree_dirty = process::Command::new("git")
        .args(["-C", &bp_str, "status", "--porcelain"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| {
            let text = String::from_utf8_lossy(&o.stdout);
            if text.trim().is_empty() {
                0
            } else {
                text.lines().count()
            }
        });

    let log_output = process::Command::new("git")
        .args(["-C", &bp_str, "log", "--oneline", "@{u}..HEAD"])
        .output();
    let (unpushed_commits, has_upstream) = match log_output {
        Ok(o) if o.status.success() => {
            let text = String::from_utf8_lossy(&o.stdout);
            (text.lines().filter(|l| !l.is_empty()).count(), true)
        }
        _ => (0, false),
    };

    let mut artifacts = 0usize;
    if let Ok(projects) = fs::read_dir(&bp) {
        for proj_entry in projects.flatten() {
            let proj_dir = proj_entry.path();
            if !proj_dir.is_dir() {
                continue;
            }
            if proj_dir
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .starts_with('.')
            {
                continue;
            }
            for kind in ALL_KINDS {
                let kind_dir = proj_dir.join(kind.dir_name());
                let Ok(entries) = fs::read_dir(&kind_dir) else {
                    continue;
                };
                for entry in entries.flatten() {
                    if entry.path().extension().is_some_and(|ext| ext == "md") {
                        artifacts += 1;
                    }
                }
            }
        }
    }

    VaultStatus {
        working_tree_dirty,
        unpushed_commits,
        has_upstream,
        artifacts,
    }
}

pub fn cmd_status(json: bool) {
    let snap = status_snapshot();
    if json {
        match serde_json::to_string(&snap) {
            Ok(body) => println!("{body}"),
            Err(e) => eprintln!("serialize: {e}"),
        }
        return;
    }
    match snap.working_tree_dirty {
        Some(0) => println!("working tree: clean"),
        Some(n) => println!("working tree: {n} dirty file(s)"),
        None => println!("working tree: unknown (git status failed)"),
    }
    if snap.has_upstream {
        println!("unpushed commits: {}", snap.unpushed_commits);
    } else {
        println!("unpushed commits: 0 (no upstream)");
    }
    println!("artifacts: {}", snap.artifacts);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn with_blueprints_dir<F: FnOnce()>(tmp: &Path, f: F) {
        let _guard = crate::artifact::CT_BLUEPRINTS_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let prev = env::var("CT_BLUEPRINTS_DIR").ok();
        unsafe { env::set_var("CT_BLUEPRINTS_DIR", tmp) };
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
        match prev {
            Some(v) => unsafe { env::set_var("CT_BLUEPRINTS_DIR", v) },
            None => unsafe { env::remove_var("CT_BLUEPRINTS_DIR") },
        }
        if let Err(payload) = result {
            std::panic::resume_unwind(payload);
        }
    }

    fn seed(base: &Path, project: &str, kind: ArtifactKind, stem: &str) -> PathBuf {
        let dir = base.join(project).join(kind.dir_name());
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join(format!("{stem}.md"));
        fs::write(&file, format!("---\ntopic: {stem}\n---\n")).unwrap();
        file
    }

    #[test]
    fn related_core_returns_hits_with_stem_and_path() {
        let tmp = std::env::temp_dir().join(format!("ct-related-core-{}", std::process::id()));
        fs::create_dir_all(&tmp).unwrap();

        let plan = seed(&tmp, "myproj", ArtifactKind::Plan, "20260411-auth-flow");
        let _ = seed(&tmp, "myproj", ArtifactKind::Research, "20260411-ui-theme");

        with_blueprints_dir(&tmp, || {
            // Pass project path that project_name() resolves to "myproj".
            let proj_path = tmp.join("myproj");
            let hits = related(
                "auth flow improvements",
                Some(proj_path.to_str().unwrap()),
                false,
            )
            .expect("related ok");
            assert_eq!(hits.len(), 1, "only auth-flow should overlap");
            assert_eq!(hits[0].stem, "20260411-auth-flow");
            assert_eq!(hits[0].path, plan);
        });
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn related_core_empty_topic_returns_empty() {
        let tmp = std::env::temp_dir().join(format!("ct-related-empty-{}", std::process::id()));
        fs::create_dir_all(&tmp).unwrap();

        with_blueprints_dir(&tmp, || {
            let hits = related("", None, false).expect("empty topic ok");
            assert!(hits.is_empty());
        });
        fs::remove_dir_all(&tmp).ok();
    }
}
