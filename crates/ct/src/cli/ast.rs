use std::path::{Path, PathBuf};

use crate::cli::args::AstAction;

pub fn run_ast(action: AstAction) -> Result<(), Box<dyn std::error::Error>> {
    match action {
        AstAction::Search {
            pattern,
            lang,
            paths,
            json,
            selector,
            context,
            include_ignored,
        } => {
            reject_plain_text_pattern(&pattern)?;
            let paths = default_paths(paths);
            let matches = sg_search(&pattern, &lang, &paths, selector.as_deref(), context)?;
            let out = serde_json::json!({
                "pattern": pattern,
                "lang": lang,
                "paths": paths,
                "include_ignored": include_ignored,
                "matches": matches,
                "match_count": matches.as_array().map(Vec::len).unwrap_or(0),
                "available": true
            });
            print_output(json, &out)?;
        }
        AstAction::Replace {
            pattern,
            rewrite,
            lang,
            paths,
            json,
            apply,
            include_ignored,
        } => {
            reject_plain_text_pattern(&pattern)?;
            let paths = default_paths(paths);
            let matches = if apply {
                sg_replace_apply(&pattern, &rewrite, &lang, &paths)?;
                sg_search(&rewrite, &lang, &paths, None, None)?
            } else {
                sg_replace_dry_run(&pattern, &rewrite, &lang, &paths)?
            };
            let out = serde_json::json!({
                "pattern": pattern,
                "rewrite": rewrite,
                "lang": lang,
                "paths": paths,
                "apply": apply,
                "include_ignored": include_ignored,
                "matches": matches,
                "match_count": matches.as_array().map(Vec::len).unwrap_or(0),
                "available": true
            });
            print_output(json, &out)?;
        }
    }
    Ok(())
}

pub(crate) fn default_paths(paths: Vec<String>) -> Vec<String> {
    if paths.is_empty() {
        vec![".".to_string()]
    } else {
        paths
    }
}

pub(crate) fn reject_plain_text_pattern(pattern: &str) -> Result<(), Box<dyn std::error::Error>> {
    let text = pattern.trim();
    if text.is_empty() {
        return Err("ast pattern cannot be empty".into());
    }
    let looks_like_yaml = text.lines().any(|line| {
        let line = line.trim_start().to_ascii_lowercase();
        ["id:", "language:", "rule:", "rules:", "kind:", "pattern:"]
            .iter()
            .any(|prefix| line.starts_with(prefix))
    });
    let has_ast_signal = text.chars().any(|ch| "$(){}[].;:'\"`".contains(ch));
    if looks_like_yaml || (text.contains(char::is_whitespace) && !has_ast_signal) {
        return Err(
            "ast commands require a structured AST code pattern, not plain text or rule YAML"
                .into(),
        );
    }
    Ok(())
}

pub(crate) fn sg_search(
    pattern: &str,
    lang: &str,
    paths: &[String],
    selector: Option<&str>,
    context: Option<usize>,
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    let cwd = std::env::current_dir()?;
    sg_search_in(&cwd, pattern, lang, paths, selector, context)
}

pub(crate) fn sg_search_in(
    cwd: &Path,
    pattern: &str,
    lang: &str,
    paths: &[String],
    selector: Option<&str>,
    context: Option<usize>,
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    let mut args = vec![
        "run".to_string(),
        "-p".to_string(),
        pattern.to_string(),
        "--lang".to_string(),
        lang.to_string(),
        "--json=compact".to_string(),
    ];
    if let Some(selector) = selector {
        args.push("--selector".to_string());
        args.push(selector.to_string());
    }
    if let Some(context) = context {
        args.push("--context".to_string());
        args.push(context.to_string());
    }
    args.extend(paths.iter().cloned());
    run_sg_json_in(args, Some(cwd))
}

pub(crate) fn sg_replace_dry_run(
    pattern: &str,
    rewrite: &str,
    lang: &str,
    paths: &[String],
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    let mut args = vec![
        "run".to_string(),
        "-p".to_string(),
        pattern.to_string(),
        "-r".to_string(),
        rewrite.to_string(),
        "--lang".to_string(),
        lang.to_string(),
        "--json=compact".to_string(),
    ];
    args.extend(paths.iter().cloned());
    run_sg_json(args)
}

pub(crate) fn sg_replace_apply(
    pattern: &str,
    rewrite: &str,
    lang: &str,
    paths: &[String],
) -> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::current_dir()?.canonicalize()?;
    let temp = TempWorkspace::create()?;
    let files = copy_workspace(&root, temp.path())?;
    let temp_paths = paths
        .iter()
        .map(|path| path_for_temp(&root, path))
        .collect::<Result<Vec<_>, _>>()?;
    let mut args = vec![
        "run".to_string(),
        "-p".to_string(),
        pattern.to_string(),
        "-r".to_string(),
        rewrite.to_string(),
        "--lang".to_string(),
        lang.to_string(),
        "--update-all".to_string(),
    ];
    args.extend(temp_paths);
    let output = std::process::Command::new("sg")
        .args(args)
        .current_dir(temp.path())
        .output()?;
    if !output.status.success() {
        return Err(format!("sg failed: {}", String::from_utf8_lossy(&output.stderr)).into());
    }
    let patch = patch_from_workspace_diff(&root, temp.path(), &files)?;
    if patch.is_none() {
        return Ok(());
    }
    let patch = patch.unwrap();
    crate::apply_patch::apply(&patch, &root, true).map_err(|failure| failure.error.to_string())?;
    crate::apply_patch::apply(&patch, &root, false).map_err(|failure| failure.error.to_string())?;
    Ok(())
}

fn run_sg_json(args: Vec<String>) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    run_sg_json_in(args, None)
}

fn run_sg_json_in(
    args: Vec<String>,
    cwd: Option<&Path>,
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    let mut command = std::process::Command::new("sg");
    command.args(args);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let output = command.output()?;
    if !output.status.success() {
        return Err(format!("sg failed: {}", String::from_utf8_lossy(&output.stderr)).into());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(serde_json::from_str(stdout.trim()).unwrap_or_else(|_| serde_json::json!([])))
}

fn print_output(_json: bool, value: &serde_json::Value) -> Result<(), Box<dyn std::error::Error>> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

struct TempWorkspace {
    path: PathBuf,
}

impl TempWorkspace {
    fn create() -> Result<Self, Box<dyn std::error::Error>> {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "ct-ast-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_nanos()
        ));
        std::fs::create_dir_all(&path)?;
        Ok(Self { path })
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempWorkspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

fn copy_workspace(root: &Path, temp: &Path) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    let files = workspace_files(root)?;
    let mut copied = Vec::new();
    for rel in &files {
        let source = root.join(rel);
        if !source.is_file() {
            continue;
        }
        let target = temp.join(rel);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(source, target)?;
        copied.push(rel.clone());
    }
    Ok(copied)
}

fn workspace_files(root: &Path) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    let output = std::process::Command::new("git")
        .args(["ls-files", "-co", "--exclude-standard"])
        .current_dir(root)
        .output()?;
    if !output.status.success() {
        return Err("ct dev debug ast replace --apply currently requires a git worktree".into());
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect())
}

fn path_for_temp(root: &Path, path: &str) -> Result<String, Box<dyn std::error::Error>> {
    let path = PathBuf::from(path);
    if path.is_absolute() {
        Ok(path.strip_prefix(root)?.to_string_lossy().to_string())
    } else {
        Ok(path.to_string_lossy().to_string())
    }
}

fn patch_from_workspace_diff(
    root: &Path,
    temp: &Path,
    files: &[String],
) -> Result<Option<String>, Box<dyn std::error::Error>> {
    let mut body = String::from("*** Begin Patch\n");
    let mut changed = false;
    for rel in files {
        let old = std::fs::read_to_string(root.join(rel));
        let new = std::fs::read_to_string(temp.join(rel));
        let (Ok(old), Ok(new)) = (old, new) else {
            continue;
        };
        if old == new {
            continue;
        }
        changed = true;
        body.push_str(&update_patch_for_file(rel, &old, &new));
    }
    if !changed {
        return Ok(None);
    }
    body.push_str("*** End Patch\n");
    if body.len() > crate::apply_patch::MAX_PATCH_SIZE_BYTES {
        return Err(format!(
            "generated patch exceeds {} byte limit",
            crate::apply_patch::MAX_PATCH_SIZE_BYTES
        )
        .into());
    }
    Ok(Some(body))
}

fn update_patch_for_file(path: &str, old: &str, new: &str) -> String {
    let diff = similar::TextDiff::from_lines(old, new);
    let mut out = format!("*** Update File: {path}\n");
    for group in diff.grouped_ops(3) {
        out.push_str("@@\n");
        for op in group {
            for change in diff.iter_changes(&op) {
                let prefix = match change.tag() {
                    similar::ChangeTag::Delete => '-',
                    similar::ChangeTag::Insert => '+',
                    similar::ChangeTag::Equal => ' ',
                };
                out.push(prefix);
                out.push_str(change.value().trim_end_matches('\n').trim_end_matches('\r'));
                out.push('\n');
            }
        }
    }
    out
}
