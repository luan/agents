use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use rusqlite::{Connection, params};
use serde::Serialize;

use crate::artifact::{self, ArtifactKind, CtError};

#[derive(Debug, Clone, Serialize)]
pub struct IndexedArtifact {
    pub path: PathBuf,
    pub name: String,
    pub stem: String,
    pub title: String,
    pub kind: ArtifactKind,
    pub project: String,
    pub body: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RankedArtifact {
    pub path: PathBuf,
    pub name: String,
    pub stem: String,
    pub title: String,
    pub kind: ArtifactKind,
    pub project: String,
    pub score: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct LinkEdge {
    pub from: String,
    pub to: String,
    pub path: PathBuf,
    pub target_path: Option<PathBuf>,
    pub link_type: Option<String>,
    pub annotation: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReviewReport {
    pub artifacts: usize,
    pub edges: usize,
    pub broken_links: Vec<LinkEdge>,
    pub orphans: Vec<RankedArtifact>,
    pub long_artifacts: Vec<LongArtifact>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LongArtifact {
    pub stem: String,
    pub path: PathBuf,
    pub title: String,
    pub body_len: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct IndexOutcome {
    pub indexed: usize,
    pub path: PathBuf,
}

pub fn index_path() -> PathBuf {
    artifact::blueprints_dir().join(".vlt").join("index.sqlite")
}

pub fn rebuild_index() -> Result<IndexOutcome, CtError> {
    let path = index_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let conn = Connection::open(&path).map_err(sqlite_err)?;
    conn.execute_batch(
        "DROP TABLE IF EXISTS artifacts;
         DROP TABLE IF EXISTS artifact_fts;
         CREATE TABLE artifacts (
             path TEXT PRIMARY KEY,
             name TEXT NOT NULL,
             stem TEXT NOT NULL,
             title TEXT NOT NULL,
             kind TEXT NOT NULL,
             project TEXT NOT NULL,
             body TEXT NOT NULL
         );
         CREATE VIRTUAL TABLE artifact_fts USING fts5(
             title, body, stem, content='artifacts', content_rowid='rowid'
         );",
    )
    .map_err(sqlite_err)?;

    let artifacts = collect_artifacts(false)?;
    for artifact in &artifacts {
        conn.execute(
            "INSERT INTO artifacts(path, name, stem, title, kind, project, body)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                artifact.path.to_string_lossy(),
                artifact.name,
                artifact.stem,
                artifact.title,
                artifact.kind.dir_name(),
                artifact.project,
                artifact.body
            ],
        )
        .map_err(sqlite_err)?;
    }
    conn.execute(
        "INSERT INTO artifact_fts(rowid, title, body, stem)
         SELECT rowid, title, body, stem FROM artifacts",
        [],
    )
    .map_err(sqlite_err)?;

    Ok(IndexOutcome {
        indexed: artifacts.len(),
        path,
    })
}

pub fn search(
    query: &str,
    kind: Option<ArtifactKind>,
    project: Option<&str>,
    include_archive: bool,
    limit: usize,
) -> Result<Vec<RankedArtifact>, CtError> {
    ensure_index_fresh()?;
    let conn = Connection::open(index_path()).map_err(sqlite_err)?;
    let fts_query = fts_or_query(query);
    let mut sql = String::from(
        "SELECT artifacts.path, artifacts.name, artifacts.stem, artifacts.title, artifacts.kind,
                artifacts.project, bm25(artifact_fts, 5.0, 1.0, 2.0) AS rank
         FROM artifact_fts
         JOIN artifacts ON artifacts.rowid = artifact_fts.rowid
         WHERE artifact_fts MATCH ?1",
    );
    let mut params_vec: Vec<String> = vec![fts_query];
    if let Some(k) = kind {
        sql.push_str(" AND artifacts.kind = ?");
        params_vec.push(k.dir_name().to_string());
    }
    if let Some(project) = project {
        sql.push_str(" AND artifacts.project = ?");
        params_vec.push(artifact::project_name(&artifact::resolve_repo_root(
            project,
        )));
    }
    if !include_archive {
        sql.push_str(" AND artifacts.path NOT LIKE '%/archive/%'");
    }
    sql.push_str(" ORDER BY rank ASC LIMIT ?");
    params_vec.push(limit.to_string());

    let refs: Vec<&dyn rusqlite::ToSql> = params_vec
        .iter()
        .map(|value| value as &dyn rusqlite::ToSql)
        .collect();
    let mut stmt = conn.prepare(&sql).map_err(sqlite_err)?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(refs), row_ranked)
        .map_err(sqlite_err)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_err)
}

pub fn similar(
    stem_or_path: &str,
    kind: Option<ArtifactKind>,
    project: Option<&str>,
    include_archive: bool,
    limit: usize,
) -> Result<Vec<RankedArtifact>, CtError> {
    let source_path = resolve_path(stem_or_path, kind)?;
    let source = read_indexed(&source_path)?;
    let query = source
        .body
        .split_whitespace()
        .chain(source.title.split_whitespace())
        .filter_map(normalize_term)
        .take(40)
        .collect::<Vec<_>>()
        .join(" ");
    let mut hits = search(&query, None, project, include_archive, limit + 1)?;
    hits.retain(|hit| hit.path != source_path);
    hits.truncate(limit);
    Ok(hits)
}

pub fn links(stem_or_path: &str, kind: Option<ArtifactKind>) -> Result<Vec<LinkEdge>, CtError> {
    let path = resolve_path(stem_or_path, kind)?;
    let source = read_indexed(&path)?;
    Ok(parse_links(
        &source.body,
        &source.stem,
        &path,
        &artifact_by_stem()?,
    ))
}

pub fn backlinks(stem_or_path: &str, kind: Option<ArtifactKind>) -> Result<Vec<LinkEdge>, CtError> {
    let path = resolve_path(stem_or_path, kind)?;
    let target_stem = path.file_stem().unwrap_or_default().to_string_lossy();
    let by_stem = artifact_by_stem()?;
    let mut hits = Vec::new();
    for artifact in collect_artifacts(false)? {
        for edge in parse_links(&artifact.body, &artifact.stem, &artifact.path, &by_stem) {
            if edge.to == target_stem {
                hits.push(edge);
            }
        }
    }
    Ok(hits)
}

pub fn graph() -> Result<Vec<LinkEdge>, CtError> {
    let by_stem = artifact_by_stem()?;
    let mut edges = Vec::new();
    for artifact in collect_artifacts(false)? {
        edges.extend(parse_links(
            &artifact.body,
            &artifact.stem,
            &artifact.path,
            &by_stem,
        ));
    }
    Ok(edges)
}

pub fn review(long_threshold: usize) -> Result<ReviewReport, CtError> {
    let artifacts = collect_artifacts(false)?;
    let edges = graph()?;
    let mut linked = HashSet::new();
    for edge in &edges {
        linked.insert(edge.from.clone());
        linked.insert(edge.to.clone());
    }
    let broken_links = edges
        .iter()
        .filter(|edge| edge.target_path.is_none())
        .cloned()
        .collect();
    let orphans = artifacts
        .iter()
        .filter(|artifact| !linked.contains(&artifact.stem))
        .map(|artifact| artifact.as_ranked(0.0))
        .collect();
    let long_artifacts = artifacts
        .iter()
        .filter(|artifact| artifact.body.len() > long_threshold)
        .map(|artifact| LongArtifact {
            stem: artifact.stem.clone(),
            path: artifact.path.clone(),
            title: artifact.title.clone(),
            body_len: artifact.body.len(),
        })
        .collect();
    Ok(ReviewReport {
        artifacts: artifacts.len(),
        edges: edges.len(),
        broken_links,
        orphans,
        long_artifacts,
    })
}

pub fn read_depth(
    stem_or_path: &str,
    kind: Option<ArtifactKind>,
    depth: usize,
) -> Result<Vec<IndexedArtifact>, CtError> {
    let origin_path = resolve_path(stem_or_path, kind)?;
    let by_stem = artifact_by_stem()?;
    let origin = read_indexed(&origin_path)?;
    let mut queue = VecDeque::from([(origin.stem.clone(), 0usize)]);
    let mut seen = HashSet::new();
    let mut ordered = Vec::new();

    while let Some((stem, current_depth)) = queue.pop_front() {
        if !seen.insert(stem.clone()) {
            continue;
        }
        let Some(path) = by_stem.get(&stem) else {
            continue;
        };
        let artifact = read_indexed(path)?;
        if current_depth < depth {
            for edge in parse_links(&artifact.body, &artifact.stem, &artifact.path, &by_stem) {
                queue.push_back((edge.to, current_depth + 1));
            }
        }
        ordered.push(artifact);
    }
    Ok(ordered)
}

pub fn add_link(
    from: &str,
    to: &str,
    link_type: &str,
    annotation: &str,
) -> Result<PathBuf, CtError> {
    if link_type.trim().is_empty() {
        return Err(CtError::Validation("link type is required".to_string()));
    }
    if annotation.trim().is_empty() {
        return Err(CtError::Validation("annotation is required".to_string()));
    }
    let from_path = resolve_path(from, None)?;
    let to_path = resolve_path(to, None)?;
    let to_stem = to_path.file_stem().unwrap_or_default().to_string_lossy();
    let mut content = fs::read_to_string(&from_path)?;
    let line = format!(
        "- [[{}]] — {}: {}",
        to_stem,
        link_type.trim(),
        annotation.trim()
    );
    if content.contains(&line) {
        return Ok(from_path);
    }
    if content.contains("\n## Links\n") {
        if !content.ends_with('\n') {
            content.push('\n');
        }
        content.push_str(&line);
        content.push('\n');
    } else {
        if !content.ends_with('\n') {
            content.push('\n');
        }
        content.push_str("\n## Links\n\n");
        content.push_str(&line);
        content.push('\n');
    }
    fs::write(&from_path, content)?;
    let _ = artifact::commit_edits(
        &from_path.to_string_lossy(),
        Some(&format!("link: {} -> {}", from, to_stem)),
    )?;
    Ok(from_path)
}

pub fn update_body(
    stem_or_path: &str,
    kind: Option<ArtifactKind>,
    edit: BodyEdit,
    message: Option<&str>,
) -> Result<PathBuf, CtError> {
    let path = resolve_path(stem_or_path, kind)?;
    let content = fs::read_to_string(&path)?;
    let (yaml, body) = artifact::parse_frontmatter(&content);
    let new_body = edit.apply(body)?;
    let output = match yaml {
        Some(yaml) => format!("---\n{yaml}\n---\n{new_body}"),
        None => new_body,
    };
    fs::write(&path, output)?;
    let _ = artifact::commit_edits(&path.to_string_lossy(), message)?;
    Ok(path)
}

#[derive(Debug, Clone)]
pub enum BodyEdit {
    Replace(String),
    Append(String),
    ReplaceSection { heading: String, content: String },
}

impl BodyEdit {
    fn apply(self, body: &str) -> Result<String, CtError> {
        match self {
            BodyEdit::Replace(content) => Ok(ensure_trailing_newline(content)),
            BodyEdit::Append(content) => {
                let mut out = body.to_string();
                if !out.ends_with('\n') {
                    out.push('\n');
                }
                out.push_str(&content);
                if !out.ends_with('\n') {
                    out.push('\n');
                }
                Ok(out)
            }
            BodyEdit::ReplaceSection { heading, content } => {
                replace_section(body, &heading, &content)
            }
        }
    }
}

pub fn cmd_index(json: bool) -> Result<(), Box<dyn std::error::Error>> {
    match rebuild_index() {
        Ok(outcome) if json => println!("{}", serde_json::to_string(&outcome)?),
        Ok(outcome) => println!(
            "indexed {} artifact(s) into {}",
            outcome.indexed,
            outcome.path.display()
        ),
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    }
    Ok(())
}

pub fn cmd_search(
    query: &str,
    kind: Option<ArtifactKind>,
    project: Option<&str>,
    include_archive: bool,
    json: bool,
) {
    match search(query, kind, project, include_archive, 50) {
        Ok(hits) if json => print_json(&hits),
        Ok(hits) => print_ranked(&hits),
        Err(e) => eprintln!("{e}"),
    }
}

pub fn cmd_similar(
    stem_or_path: &str,
    kind: Option<ArtifactKind>,
    project: Option<&str>,
    include_archive: bool,
    limit: usize,
    json: bool,
) {
    match similar(stem_or_path, kind, project, include_archive, limit) {
        Ok(hits) if json => print_json(&hits),
        Ok(hits) => print_ranked(&hits),
        Err(e) => eprintln!("{e}"),
    }
}

pub fn cmd_links(stem_or_path: &str, kind: Option<ArtifactKind>, json: bool) {
    match links(stem_or_path, kind) {
        Ok(edges) if json => print_json(&edges),
        Ok(edges) => print_edges(&edges),
        Err(e) => eprintln!("{e}"),
    }
}

pub fn cmd_backlinks(stem_or_path: &str, kind: Option<ArtifactKind>, json: bool) {
    match backlinks(stem_or_path, kind) {
        Ok(edges) if json => print_json(&edges),
        Ok(edges) => print_edges(&edges),
        Err(e) => eprintln!("{e}"),
    }
}

pub fn cmd_graph(json: bool) {
    match graph() {
        Ok(edges) if json => print_json(&edges),
        Ok(edges) => print_edges(&edges),
        Err(e) => eprintln!("{e}"),
    }
}

pub fn cmd_review(long_threshold: usize, json: bool) {
    match review(long_threshold) {
        Ok(report) if json => print_json(&report),
        Ok(report) => {
            println!("artifacts: {}", report.artifacts);
            println!("links: {}", report.edges);
            println!("broken links: {}", report.broken_links.len());
            println!("orphans: {}", report.orphans.len());
            println!("long artifacts: {}", report.long_artifacts.len());
            if !report.broken_links.is_empty() {
                println!("\nbroken links:");
                print_edges(&report.broken_links);
            }
            if !report.long_artifacts.is_empty() {
                println!("\nlong artifacts:");
                for artifact in &report.long_artifacts {
                    println!(
                        "{}\t{}\t{} chars",
                        artifact.stem, artifact.title, artifact.body_len
                    );
                }
            }
        }
        Err(e) => eprintln!("{e}"),
    }
}

pub fn cmd_read_depth(stem_or_path: &str, kind: Option<ArtifactKind>, depth: usize, json: bool) {
    match read_depth(stem_or_path, kind, depth) {
        Ok(artifacts) if json => print_json(&artifacts),
        Ok(artifacts) => {
            for (idx, artifact) in artifacts.iter().enumerate() {
                if idx > 0 {
                    println!("\n---\n");
                }
                println!("# {} ({})\n", artifact.title, artifact.stem);
                print!("{}", artifact.body);
            }
        }
        Err(e) => eprintln!("{e}"),
    }
}

pub fn cmd_link(from: &str, to: &str, link_type: &str, annotation: &str, json: bool) {
    match add_link(from, to, link_type, annotation) {
        Ok(path) if json => print_json(&serde_json::json!({ "path": path })),
        Ok(path) => println!("{}", path.display()),
        Err(e) => eprintln!("{e}"),
    }
}

pub struct UpdateCommand<'a> {
    pub file: &'a str,
    pub kind: Option<ArtifactKind>,
    pub content: Option<String>,
    pub stdin: bool,
    pub append: Option<String>,
    pub replace_section_heading: Option<String>,
    pub message: Option<String>,
    pub json: bool,
}

pub fn cmd_update(args: UpdateCommand<'_>) {
    let stdin_content = if args.stdin {
        let mut buf = String::new();
        if let Err(e) = io::stdin().read_to_string(&mut buf) {
            eprintln!("stdin: {e}");
            std::process::exit(1);
        }
        Some(buf)
    } else {
        None
    };
    let body_input = stdin_content.or(args.content);
    let edit = match (args.replace_section_heading, args.append, body_input) {
        (Some(heading), None, Some(content)) => BodyEdit::ReplaceSection { heading, content },
        (None, Some(content), None) => BodyEdit::Append(content),
        (None, None, Some(content)) => BodyEdit::Replace(content),
        _ => {
            eprintln!(
                "choose exactly one of --content/--stdin, --append, or --replace-section with content"
            );
            std::process::exit(1);
        }
    };
    match update_body(args.file, args.kind, edit, args.message.as_deref()) {
        Ok(path) if args.json => print_json(&serde_json::json!({ "path": path })),
        Ok(path) => println!("{}", path.display()),
        Err(e) => eprintln!("{e}"),
    }
}

fn collect_artifacts(include_archive: bool) -> Result<Vec<IndexedArtifact>, CtError> {
    let mut out = Vec::new();
    for item in artifact::list_all_artifacts(true) {
        out.push(read_listed(item)?);
    }
    if include_archive {
        for item in artifact::list_all_archived_artifacts() {
            out.push(read_listed(item)?);
        }
    }
    Ok(out)
}

fn read_listed(item: crate::artifact::Artifact) -> Result<IndexedArtifact, CtError> {
    let read = artifact::read(&item.path)?;
    let kind = artifact::infer_kind_from_path(&item.path).ok_or_else(|| {
        CtError::Validation(format!("cannot infer kind from {}", item.path.display()))
    })?;
    let stem = item
        .path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    Ok(IndexedArtifact {
        path: item.path,
        name: item.name,
        stem,
        title: item.title,
        kind,
        project: item.project,
        body: read.body,
    })
}

fn read_indexed(path: &Path) -> Result<IndexedArtifact, CtError> {
    let read = artifact::read(path)?;
    let content = fs::read_to_string(path)?;
    let (title, _, _, _, _, _) = artifact::extract_frontmatter_full_from_str(&content);
    let kind = artifact::infer_kind_from_path(path)
        .ok_or_else(|| CtError::Validation(format!("cannot infer kind from {}", path.display())))?;
    let bp = artifact::blueprints_dir();
    let name = path
        .strip_prefix(&bp)
        .unwrap_or(path)
        .with_extension("")
        .to_string_lossy()
        .to_string();
    let project = path
        .strip_prefix(&bp)
        .ok()
        .and_then(|p| p.components().next())
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .unwrap_or_default();
    let stem = path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    Ok(IndexedArtifact {
        path: path.to_path_buf(),
        name,
        stem,
        title,
        kind,
        project,
        body: read.body,
    })
}

fn resolve_path(stem_or_path: &str, kind: Option<ArtifactKind>) -> Result<PathBuf, CtError> {
    match kind {
        Some(kind) => artifact::resolve_artifact_path(stem_or_path, kind).map_err(Into::into),
        None => artifact::resolve_stem_universal(stem_or_path).map_err(Into::into),
    }
}

fn artifact_by_stem() -> Result<HashMap<String, PathBuf>, CtError> {
    let mut map = HashMap::new();
    for artifact in collect_artifacts(false)? {
        map.insert(artifact.stem, artifact.path);
    }
    Ok(map)
}

fn parse_links(
    body: &str,
    from: &str,
    source_path: &Path,
    by_stem: &HashMap<String, PathBuf>,
) -> Vec<LinkEdge> {
    let mut edges = Vec::new();
    for line in body.lines() {
        let mut rest = line;
        while let Some(start) = rest.find("[[") {
            let after_start = &rest[start + 2..];
            let Some(end) = after_start.find("]]") else {
                break;
            };
            let raw_target = &after_start[..end];
            let target = raw_target.split('|').next().unwrap_or(raw_target).trim();
            let tail = after_start[end + 2..].trim();
            let (link_type, annotation) = parse_link_tail(tail);
            edges.push(LinkEdge {
                from: from.to_string(),
                to: target.to_string(),
                path: source_path.to_path_buf(),
                target_path: by_stem.get(target).cloned(),
                link_type,
                annotation,
            });
            rest = &after_start[end + 2..];
        }
    }
    edges
}

fn parse_link_tail(tail: &str) -> (Option<String>, Option<String>) {
    let tail = tail.trim_start_matches(['—', '-', ':', ' ']).trim();
    if tail.is_empty() {
        return (None, None);
    }
    if let Some((kind, annotation)) = tail.split_once(':') {
        let kind = kind.trim();
        if !kind.is_empty()
            && kind
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
        {
            return (
                Some(kind.to_string()),
                Some(annotation.trim().to_string()).filter(|s| !s.is_empty()),
            );
        }
    }
    (None, Some(tail.to_string()))
}

fn ensure_index_fresh() -> Result<(), CtError> {
    let path = index_path();
    if !path.exists() {
        let _ = rebuild_index()?;
        return Ok(());
    }
    let index_mtime = fs::metadata(&path)?.modified()?;
    for artifact in collect_artifacts(false)? {
        let artifact_mtime = fs::metadata(&artifact.path)?.modified()?;
        if artifact_mtime > index_mtime {
            let _ = rebuild_index()?;
            break;
        }
    }
    Ok(())
}

fn fts_or_query(query: &str) -> String {
    let terms: Vec<String> = query
        .split_whitespace()
        .filter_map(normalize_term)
        .collect();
    if terms.is_empty() {
        "\"\"".to_string()
    } else {
        terms.join(" OR ")
    }
}

fn normalize_term(term: &str) -> Option<String> {
    let normalized: String = term
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '_' || *ch == '-')
        .collect::<String>()
        .to_lowercase();
    if normalized.len() >= 3 {
        Some(format!("\"{normalized}\""))
    } else {
        None
    }
}

fn row_ranked(row: &rusqlite::Row<'_>) -> rusqlite::Result<RankedArtifact> {
    let kind: String = row.get(4)?;
    Ok(RankedArtifact {
        path: PathBuf::from(row.get::<_, String>(0)?),
        name: row.get(1)?,
        stem: row.get(2)?,
        title: row.get(3)?,
        kind: ArtifactKind::from_dir_name(&kind).unwrap_or(ArtifactKind::Doc),
        project: row.get(5)?,
        score: row.get::<_, f64>(6)?,
    })
}

fn replace_section(body: &str, heading: &str, replacement: &str) -> Result<String, CtError> {
    let target = format!("## {}", heading.trim()).to_lowercase();
    let mut lines: Vec<&str> = body.lines().collect();
    let Some(start) = lines
        .iter()
        .position(|line| line.trim().to_lowercase() == target)
    else {
        return Err(CtError::Validation(format!(
            "section not found: {}",
            heading.trim()
        )));
    };
    let end = lines[start + 1..]
        .iter()
        .position(|line| line.starts_with("## "))
        .map(|idx| start + 1 + idx)
        .unwrap_or(lines.len());
    let mut replacement_lines = Vec::new();
    replacement_lines.push(lines[start]);
    replacement_lines.push("");
    for line in replacement.lines() {
        replacement_lines.push(line);
    }
    if !replacement.ends_with('\n') {
        replacement_lines.push("");
    }
    lines.splice(start..end, replacement_lines);
    Ok(ensure_trailing_newline(lines.join("\n")))
}

fn ensure_trailing_newline(mut content: String) -> String {
    if !content.ends_with('\n') {
        content.push('\n');
    }
    content
}

impl IndexedArtifact {
    fn as_ranked(&self, score: f64) -> RankedArtifact {
        RankedArtifact {
            path: self.path.clone(),
            name: self.name.clone(),
            stem: self.stem.clone(),
            title: self.title.clone(),
            kind: self.kind.clone(),
            project: self.project.clone(),
            score,
        }
    }
}

fn print_ranked(hits: &[RankedArtifact]) {
    for hit in hits {
        println!("{}\t{}\t{}", hit.stem, hit.kind.dir_name(), hit.title);
    }
}

fn print_edges(edges: &[LinkEdge]) {
    for edge in edges {
        let label = match (&edge.link_type, &edge.annotation) {
            (Some(kind), Some(annotation)) => format!(" — {kind}: {annotation}"),
            (Some(kind), None) => format!(" — {kind}"),
            (None, Some(annotation)) => format!(" — {annotation}"),
            (None, None) => String::new(),
        };
        println!("{} -> {}{}", edge.from, edge.to, label);
    }
}

fn print_json<T: Serialize>(value: &T) {
    match serde_json::to_string(value) {
        Ok(body) => println!("{body}"),
        Err(e) => eprintln!("serialize: {e}"),
    }
}

fn sqlite_err(error: rusqlite::Error) -> CtError {
    CtError::Validation(format!("sqlite: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

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

    fn seed(base: &Path, kind: ArtifactKind, stem: &str, body: &str) -> PathBuf {
        let dir = base.join("proj").join(kind.dir_name());
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("{stem}.md"));
        fs::write(&path, format!("---\ntopic: {stem}\n---\n{body}\n")).unwrap();
        path
    }

    #[test]
    fn index_search_returns_body_hits_without_obsidian() {
        let tmp = env::temp_dir().join(format!("vlt-index-search-{}", std::process::id()));
        fs::remove_dir_all(&tmp).ok();
        seed(
            &tmp,
            ArtifactKind::Plan,
            "20260524-auth-flow",
            "oauth callback token refresh",
        );
        seed(
            &tmp,
            ArtifactKind::Research,
            "20260524-rendering",
            "canvas shader pipeline",
        );

        with_blueprints_dir(&tmp, || {
            rebuild_index().unwrap();
            let hits = search("oauth token", None, None, false, 10).unwrap();
            assert_eq!(hits[0].stem, "20260524-auth-flow");
        });
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn backlinks_parse_typed_annotated_links() {
        let tmp = env::temp_dir().join(format!("vlt-backlinks-{}", std::process::id()));
        fs::remove_dir_all(&tmp).ok();
        seed(
            &tmp,
            ArtifactKind::Plan,
            "20260524-source",
            "## Links\n\n- [[20260524-target]] — implements: carries out the plan",
        );
        seed(&tmp, ArtifactKind::Doc, "20260524-target", "target body");

        with_blueprints_dir(&tmp, || {
            let hits = backlinks("20260524-target", None).unwrap();
            assert_eq!(hits.len(), 1);
            assert_eq!(hits[0].link_type.as_deref(), Some("implements"));
            assert_eq!(hits[0].annotation.as_deref(), Some("carries out the plan"));
        });
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn replace_section_preserves_other_sections() {
        let body = "Intro\n\n## Why\n\nold\n\n## How\n\nsame\n";
        let updated = replace_section(body, "why", "new").unwrap();
        assert!(updated.contains("## Why\n\nnew\n"));
        assert!(updated.contains("## How\n\nsame"));
        assert!(!updated.contains("old"));
    }
}
