use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::artifact::{self, CtError, blueprints_dir, project_name, resolve_repo_root};

#[derive(Debug, Clone, Serialize)]
pub struct ContextDoc {
    pub name: String,
    pub path: PathBuf,
    pub kind: ContextDocKind,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ContextDocKind {
    Root,
    Named,
    Map,
}

#[derive(Debug, Clone, Serialize)]
pub struct ContextCheck {
    pub ok: bool,
    pub contexts: Vec<ContextDoc>,
    pub problems: Vec<String>,
}

pub fn project_dir(project: Option<&str>) -> PathBuf {
    let project = project
        .map(resolve_repo_root)
        .unwrap_or_else(artifact::current_project);
    blueprints_dir().join(project_name(&project))
}

pub fn list(project: Option<&str>) -> Vec<ContextDoc> {
    let root = project_dir(project);
    let mut docs = Vec::new();
    let root_context = root.join("CONTEXT.md");
    if root_context.exists() {
        docs.push(ContextDoc {
            name: "root".to_string(),
            path: root_context,
            kind: ContextDocKind::Root,
        });
    }
    let map = root.join("CONTEXT-MAP.md");
    if map.exists() {
        docs.push(ContextDoc {
            name: "map".to_string(),
            path: map,
            kind: ContextDocKind::Map,
        });
    }
    let contexts_dir = root.join("contexts");
    if let Ok(entries) = fs::read_dir(contexts_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let context_path = path.join("CONTEXT.md");
            if context_path.exists() {
                docs.push(ContextDoc {
                    name: entry.file_name().to_string_lossy().to_string(),
                    path: context_path,
                    kind: ContextDocKind::Named,
                });
            }
        }
    }
    docs.sort_by(|a, b| a.name.cmp(&b.name));
    docs
}

pub fn resolve(project: Option<&str>, name: Option<&str>) -> Result<PathBuf, CtError> {
    let root = project_dir(project);
    let path = match name {
        None | Some("root") => root.join("CONTEXT.md"),
        Some("map") => root.join("CONTEXT-MAP.md"),
        Some(name) => root.join("contexts").join(name).join("CONTEXT.md"),
    };
    if path.exists() {
        Ok(path)
    } else {
        Err(CtError::Validation(format!(
            "context not found: {}",
            path.display()
        )))
    }
}

pub fn check(project: Option<&str>) -> ContextCheck {
    let root = project_dir(project);
    let contexts = list(project);
    let mut problems = Vec::new();
    let has_root = root.join("CONTEXT.md").exists();
    let map = root.join("CONTEXT-MAP.md");
    let has_map = map.exists();

    if has_root && has_map {
        problems.push("both CONTEXT.md and CONTEXT-MAP.md exist at the project root".to_string());
    }

    if has_map {
        let content = fs::read_to_string(&map).unwrap_or_default();
        for linked in markdown_links(&content) {
            if linked.ends_with("CONTEXT.md") {
                let target = map.parent().unwrap_or(Path::new("")).join(&linked);
                if !target.exists() {
                    problems.push(format!("context map link is missing: {linked}"));
                }
            }
        }
        for doc in contexts
            .iter()
            .filter(|doc| matches!(doc.kind, ContextDocKind::Named))
        {
            let Ok(rel) = doc.path.strip_prefix(&root) else {
                continue;
            };
            let rel = rel.to_string_lossy();
            if !content.contains(rel.as_ref()) {
                problems.push(format!(
                    "named context is not listed in CONTEXT-MAP.md: {rel}"
                ));
            }
        }
    }

    ContextCheck {
        ok: problems.is_empty(),
        contexts,
        problems,
    }
}

pub fn set_term(
    project: Option<&str>,
    context: Option<&str>,
    term: &str,
    definition: &str,
    avoid: &[String],
) -> Result<PathBuf, CtError> {
    let root = project_dir(project);
    let path = match context {
        None | Some("root") => root.join("CONTEXT.md"),
        Some(name) => root.join("contexts").join(name).join("CONTEXT.md"),
    };
    let _lock = crate::lock::VaultLock::acquire(&format!("context:{}", path.display()))?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut content = if path.exists() {
        fs::read_to_string(&path)?
    } else {
        initial_context(context)
    };

    let block = term_block(term, definition, avoid);
    if let Some((start, end)) = find_term_block(&content, term) {
        content.replace_range(start..end, &block);
    } else {
        if !content.contains("## Language") {
            content.push_str("\n## Language\n");
        }
        if !content.ends_with('\n') {
            content.push('\n');
        }
        content.push('\n');
        content.push_str(&block);
    }
    fs::write(&path, content)?;
    Ok(path)
}

fn initial_context(context: Option<&str>) -> String {
    let title = match context {
        None | Some("root") => "Context".to_string(),
        Some(name) => titleize(name),
    };
    format!("# {title}\n\n## Language\n")
}

fn term_block(term: &str, definition: &str, avoid: &[String]) -> String {
    let mut block = format!("**{term}**:\n{definition}\n");
    if !avoid.is_empty() {
        block.push_str(&format!("_Avoid_: {}\n", avoid.join(", ")));
    }
    block
}

fn find_term_block(content: &str, term: &str) -> Option<(usize, usize)> {
    let marker = format!("**{term}**:");
    let start = content.find(&marker)?;
    let rest = &content[start + marker.len()..];
    let next = rest.find("\n**").map(|idx| start + marker.len() + idx + 1);
    Some((start, next.unwrap_or(content.len())))
}

fn markdown_links(content: &str) -> Vec<String> {
    let mut links = Vec::new();
    let mut rest = content;
    while let Some(start) = rest.find("](") {
        rest = &rest[start + 2..];
        let Some(end) = rest.find(')') else {
            break;
        };
        links.push(rest[..end].to_string());
        rest = &rest[end + 1..];
    }
    links
}

fn titleize(name: &str) -> String {
    name.split(['-', '_'])
        .filter(|s| !s.is_empty())
        .map(|s| {
            let mut chars = s.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::artifact::CT_BLUEPRINTS_ENV_LOCK;

    #[test]
    fn set_term_creates_root_context_lazily() {
        let _guard = CT_BLUEPRINTS_ENV_LOCK.lock().unwrap();
        let tmp = std::env::temp_dir().join(format!("vlt-context-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        unsafe {
            std::env::set_var("CT_BLUEPRINTS_DIR", &tmp);
        }

        let path = set_term(
            Some("/tmp/myproj"),
            None,
            "Customer",
            "A person or organization that places orders.",
            &["Client".to_string()],
        )
        .unwrap();

        let content = fs::read_to_string(&path).unwrap();
        assert!(path.ends_with("myproj/CONTEXT.md"));
        assert!(content.contains("**Customer**:"));
        assert!(content.contains("_Avoid_: Client"));

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn set_term_preserves_concurrent_updates() {
        let _guard = CT_BLUEPRINTS_ENV_LOCK.lock().unwrap();
        let tmp = std::env::temp_dir().join(format!("vlt-context-race-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        unsafe {
            std::env::set_var("CT_BLUEPRINTS_DIR", &tmp);
        }

        let handles: Vec<_> = ["Alpha", "Beta", "Gamma", "Delta"]
            .into_iter()
            .map(|term| {
                std::thread::spawn(move || {
                    set_term(
                        Some("/tmp/myproj"),
                        None,
                        term,
                        &format!("{term} definition."),
                        &[],
                    )
                    .unwrap();
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }

        let content = fs::read_to_string(tmp.join("myproj/CONTEXT.md")).unwrap();
        for term in ["Alpha", "Beta", "Gamma", "Delta"] {
            assert!(content.contains(&format!("**{term}**:")));
        }

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn check_flags_unmapped_named_contexts() {
        let _guard = CT_BLUEPRINTS_ENV_LOCK.lock().unwrap();
        let tmp = std::env::temp_dir().join(format!("vlt-context-map-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let project = tmp.join("myproj");
        fs::create_dir_all(project.join("contexts/ordering")).unwrap();
        fs::write(project.join("CONTEXT-MAP.md"), "# Context Map\n").unwrap();
        fs::write(project.join("contexts/ordering/CONTEXT.md"), "# Ordering\n").unwrap();
        unsafe {
            std::env::set_var("CT_BLUEPRINTS_DIR", &tmp);
        }

        let result = check(Some("/tmp/myproj"));
        assert!(!result.ok);
        assert!(
            result
                .problems
                .iter()
                .any(|problem| problem.contains("not listed"))
        );

        let _ = fs::remove_dir_all(&tmp);
    }
}
