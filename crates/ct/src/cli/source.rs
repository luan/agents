use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use serde_json::{Value, json};

use crate::cli::args::{SourceAction, SourceSearchMode};

static SYM_DB_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone)]
pub(crate) struct SourceSearchRequest {
    pub cwd: PathBuf,
    pub mode: SourceSearchMode,
    pub query: String,
    pub limit: usize,
    pub kind: Option<String>,
    pub lang: Option<String>,
    pub exact: bool,
    pub ignore_case: bool,
    pub paths: Vec<String>,
    pub excludes: Vec<String>,
    pub pattern: Option<String>,
    pub selector: Option<String>,
    pub context: Option<usize>,
    pub include_ignored: bool,
    pub db: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct SourceShowRequest {
    pub cwd: PathBuf,
    pub targets: Vec<String>,
    pub context: usize,
    pub all: bool,
    pub db: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct SourceOutlineRequest {
    pub cwd: PathBuf,
    pub file: PathBuf,
    pub signatures: bool,
    pub names: bool,
    pub db: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct SourceRefsRequest {
    pub cwd: PathBuf,
    pub targets: Vec<String>,
    pub importers: bool,
    pub impact: bool,
    pub depth: usize,
    pub limit: usize,
    pub context: usize,
    pub paths: Vec<String>,
    pub excludes: Vec<String>,
    pub file: Option<String>,
    pub db: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct SourceImpactRequest {
    pub cwd: PathBuf,
    pub targets: Vec<String>,
    pub depth: usize,
    pub limit: usize,
    pub context: usize,
    pub db: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct SourceTraceRequest {
    pub cwd: PathBuf,
    pub targets: Vec<String>,
    pub depth: usize,
    pub limit: usize,
    pub kinds: String,
    pub db: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct SourceImplsRequest {
    pub cwd: PathBuf,
    pub targets: Vec<String>,
    pub lang: Option<String>,
    pub limit: usize,
    pub paths: Vec<String>,
    pub excludes: Vec<String>,
    pub of: Option<String>,
    pub resolved: bool,
    pub unresolved: bool,
    pub db: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct SourceInvestigateRequest {
    pub cwd: PathBuf,
    pub targets: Vec<String>,
    pub db: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct SourceDiffRequest {
    pub cwd: PathBuf,
    pub target: String,
    pub base: String,
    pub stat: bool,
    pub db: Option<String>,
}

#[derive(Debug, Serialize)]
struct PathSearchResult {
    path: String,
    language: String,
    size: u64,
}

pub fn run_source(action: SourceAction) -> Result<(), Box<dyn std::error::Error>> {
    match action {
        SourceAction::Search {
            query,
            mode,
            limit,
            kind,
            lang,
            exact,
            ignore_case,
            paths,
            excludes,
            pattern,
            selector,
            context,
            include_ignored,
            json: _json,
            db,
        } => {
            let output = source_search_value(SourceSearchRequest {
                cwd: std::env::current_dir()?,
                mode,
                query: query.join(" "),
                limit,
                kind,
                lang,
                exact,
                ignore_case,
                paths,
                excludes,
                pattern,
                selector,
                context,
                include_ignored,
                db,
            })?;
            println!("{}", serde_json::to_string_pretty(&output)?);
        }
        SourceAction::Show {
            targets,
            context,
            all,
            json: _json,
            db,
        } => {
            let output = source_show_value(SourceShowRequest {
                cwd: std::env::current_dir()?,
                targets,
                context,
                all,
                db,
            })?;
            println!("{}", serde_json::to_string_pretty(&output)?);
        }
        SourceAction::Outline {
            file,
            signatures,
            names,
            json: _json,
            db,
        } => {
            let output = source_outline_value(SourceOutlineRequest {
                cwd: std::env::current_dir()?,
                file,
                signatures,
                names,
                db,
            })?;
            println!("{}", serde_json::to_string_pretty(&output)?);
        }
        SourceAction::Refs {
            targets,
            importers,
            impact,
            depth,
            limit,
            context,
            paths,
            excludes,
            file,
            json: _json,
            db,
        } => {
            let output = source_refs_value(SourceRefsRequest {
                cwd: std::env::current_dir()?,
                targets,
                importers,
                impact,
                depth,
                limit,
                context,
                paths,
                excludes,
                file,
                db,
            })?;
            println!("{}", serde_json::to_string_pretty(&output)?);
        }
        SourceAction::Impact {
            targets,
            depth,
            limit,
            context,
            json: _json,
            db,
        } => {
            let output = source_impact_value(SourceImpactRequest {
                cwd: std::env::current_dir()?,
                targets,
                depth,
                limit,
                context,
                db,
            })?;
            println!("{}", serde_json::to_string_pretty(&output)?);
        }
        SourceAction::Trace {
            targets,
            depth,
            limit,
            kinds,
            json: _json,
            db,
        } => {
            let output = source_trace_value(SourceTraceRequest {
                cwd: std::env::current_dir()?,
                targets,
                depth,
                limit,
                kinds,
                db,
            })?;
            println!("{}", serde_json::to_string_pretty(&output)?);
        }
        SourceAction::Impls {
            targets,
            lang,
            limit,
            paths,
            excludes,
            of,
            resolved,
            unresolved,
            json: _json,
            db,
        } => {
            let output = source_impls_value(SourceImplsRequest {
                cwd: std::env::current_dir()?,
                targets,
                lang,
                limit,
                paths,
                excludes,
                of,
                resolved,
                unresolved,
                db,
            })?;
            println!("{}", serde_json::to_string_pretty(&output)?);
        }
        SourceAction::Investigate {
            targets,
            json: _json,
            db,
        } => {
            let output = source_investigate_value(SourceInvestigateRequest {
                cwd: std::env::current_dir()?,
                targets,
                db,
            })?;
            println!("{}", serde_json::to_string_pretty(&output)?);
        }
        SourceAction::Diff {
            target,
            base,
            stat,
            json: _json,
            db,
        } => {
            let output = source_diff_value(SourceDiffRequest {
                cwd: std::env::current_dir()?,
                target,
                base,
                stat,
                db,
            })?;
            println!("{}", serde_json::to_string_pretty(&output)?);
        }
    }
    Ok(())
}

pub(crate) fn source_search_value(
    request: SourceSearchRequest,
) -> Result<Value, Box<dyn std::error::Error>> {
    match request.mode {
        SourceSearchMode::Symbol => symbol_search_value(&request),
        SourceSearchMode::Text => text_search_value(&request),
        SourceSearchMode::Path => path_search_value(&request),
        SourceSearchMode::Structural => structural_search_value(&request),
    }
}

pub(crate) fn source_show_value(
    request: SourceShowRequest,
) -> Result<Value, Box<dyn std::error::Error>> {
    if request.targets.is_empty() {
        return Err("source show requires at least one target".into());
    }

    let mut rendered = Vec::new();
    for target in &request.targets {
        if looks_like_file_target(target) {
            let (path, range) = parse_file_target(target);
            let Some(range) = range else {
                return Err(format!(
                    "source show does not accept bare file paths: {target}. Use file:line-line, source outline, or read instead"
                )
                .into());
            };
            let lines = sym::show::show_file(
                &resolve_target_path(&request.cwd, Path::new(&path)),
                Some(range),
                request.context,
            )?;
            rendered.push(json!({
                "target": target,
                "kind": "file",
                "results": lines,
            }));
        } else {
            let shown = with_sym_db(request.db.as_deref(), || {
                sym::show::show_symbol(&request.cwd, target, request.context, request.all)
            })?;
            rendered.push(json!({
                "target": target,
                "kind": "symbol",
                "results": shown,
            }));
        }
    }

    Ok(json!({
        "operation": "show",
        "targets": request.targets,
        "context": request.context,
        "all": request.all,
        "result_count": rendered.len(),
        "results": rendered,
        "available": true,
        "read_only": true,
    }))
}

pub(crate) fn source_outline_value(
    request: SourceOutlineRequest,
) -> Result<Value, Box<dyn std::error::Error>> {
    let file = resolve_target_path(&request.cwd, &request.file);
    let symbols = with_sym_db(request.db.as_deref(), || {
        sym::outline::file_outline(&request.cwd, &file)
    })?;

    if request.names {
        let mut seen = BTreeSet::new();
        let names = symbols
            .into_iter()
            .filter_map(|symbol| seen.insert(symbol.name.clone()).then_some(symbol.name))
            .collect::<Vec<_>>();
        return Ok(json!({
            "operation": "outline",
            "file": request.file,
            "signatures": request.signatures,
            "names_only": true,
            "symbol_count": names.len(),
            "results": names,
            "available": true,
            "read_only": true,
        }));
    }

    let symbol_count = symbols.len();
    Ok(json!({
        "operation": "outline",
        "file": request.file,
        "signatures": request.signatures,
        "names_only": false,
        "symbol_count": symbol_count,
        "symbols": symbols,
        "results": symbols,
        "available": true,
        "read_only": true,
    }))
}

fn symbol_search_value(request: &SourceSearchRequest) -> Result<Value, Box<dyn std::error::Error>> {
    let query = non_empty_query(&request.query, "symbol search query cannot be empty")?;
    let exact = sym::search::normalize_search_mode(request.exact, request.ignore_case, false)?;
    let results = with_sym_db(request.db.as_deref(), || {
        sym::search::search_symbols(
            &request.cwd,
            query,
            &sym::search::SymbolSearchOptions {
                kind: request.kind.as_deref(),
                lang: request.lang.as_deref(),
                limit: request.limit,
                exact,
                ignore_case: request.ignore_case,
                includes: &request.paths,
                excludes: &request.excludes,
            },
        )
    })?;
    search_output(
        request,
        query.to_string(),
        None,
        serde_json::to_value(&results)?,
        results.len(),
    )
}

fn text_search_value(request: &SourceSearchRequest) -> Result<Value, Box<dyn std::error::Error>> {
    let query = non_empty_query(&request.query, "text search query cannot be empty")?;
    let exact = sym::search::normalize_search_mode(request.exact, request.ignore_case, true)?;
    let results = sym::search::search_text(
        &request.cwd,
        query,
        request.lang.as_deref(),
        request.limit,
        &request.paths,
        &request.excludes,
        exact,
    )?;
    search_output(
        request,
        query.to_string(),
        None,
        serde_json::to_value(&results)?,
        results.len(),
    )
}

fn path_search_value(request: &SourceSearchRequest) -> Result<Value, Box<dyn std::error::Error>> {
    let query = non_empty_query(&request.query, "path search query cannot be empty")?;
    let files = sym::walker::walk(
        &request.cwd,
        &sym::walker::WalkOptions {
            parseable_only: false,
            ignore: Vec::new(),
        },
    )?;
    let mut results = Vec::new();
    for file in files {
        if let Some(lang) = request.lang.as_deref()
            && file.language != lang
        {
            continue;
        }
        if !sym::pathfilters::include_path(&file.rel_path, &request.paths, &request.excludes) {
            continue;
        }
        let rel = file.rel_path.to_string_lossy();
        if !matches_path_query(&rel, query, request.ignore_case) {
            continue;
        }
        results.push(PathSearchResult {
            path: rel.to_string(),
            language: file.language,
            size: file.size,
        });
        if request.limit > 0 && results.len() >= request.limit {
            break;
        }
    }
    search_output(
        request,
        query.to_string(),
        None,
        serde_json::to_value(&results)?,
        results.len(),
    )
}

fn structural_search_value(
    request: &SourceSearchRequest,
) -> Result<Value, Box<dyn std::error::Error>> {
    let pattern = request
        .pattern
        .as_deref()
        .unwrap_or(request.query.as_str())
        .trim();
    crate::cli::ast::reject_plain_text_pattern(pattern)?;
    let lang = request
        .lang
        .as_deref()
        .ok_or("structural search requires --lang")?;
    let paths = crate::cli::ast::default_paths(request.paths.clone());
    let matches = crate::cli::ast::sg_search_in(
        &request.cwd,
        pattern,
        lang,
        &paths,
        request.selector.as_deref(),
        request.context,
    )?;
    let match_count = matches.as_array().map(Vec::len).unwrap_or(0);
    let mut output = search_output(
        request,
        pattern.to_string(),
        Some(matches.clone()),
        matches,
        match_count,
    )?;
    output["paths"] = json!(paths);
    Ok(output)
}

fn search_output(
    request: &SourceSearchRequest,
    query: String,
    structural_matches: Option<Value>,
    results: Value,
    result_count: usize,
) -> Result<Value, Box<dyn std::error::Error>> {
    let mut output = json!({
        "mode": mode_name(request.mode),
        "query": query,
        "lang": request.lang,
        "paths": request.paths,
        "excludes": request.excludes,
        "limit": request.limit,
        "result_count": result_count,
        "results": results,
        "available": true,
        "read_only": true
    });
    if request.mode == SourceSearchMode::Structural {
        output["pattern"] = json!(request.pattern.as_deref().unwrap_or(&request.query));
        output["selector"] = json!(request.selector);
        output["context"] = json!(request.context);
        output["include_ignored"] = json!(request.include_ignored);
        if let Some(matches) = structural_matches {
            output["matches"] = matches;
            output["match_count"] = json!(result_count);
        }
    }
    Ok(output)
}

pub(crate) fn source_refs_value(
    request: SourceRefsRequest,
) -> Result<Value, Box<dyn std::error::Error>> {
    require_targets(&request.targets, "source refs requires at least one target")?;

    if request.impact {
        let mut output = source_impact_value(SourceImpactRequest {
            cwd: request.cwd,
            targets: request.targets,
            depth: request.depth.max(2),
            limit: request.limit,
            context: request.context,
            db: request.db,
        })?;
        output["routed_from"] = json!("refs");
        return Ok(output);
    }

    let mut includes = request.paths.clone();
    if let Some(fragment) = request.file.as_ref() {
        includes.push(fragment.clone());
    }

    let grouped = with_sym_db(request.db.as_deref(), || {
        let mut grouped = Vec::new();
        for target in &request.targets {
            if request.importers {
                let results = sym::graph::find_importers(
                    &request.cwd,
                    target,
                    request.depth,
                    request.limit,
                    &includes,
                    &request.excludes,
                )?;
                grouped.push(json!({ "target": target, "results": results }));
            } else {
                let results = sym::graph::find_references(
                    &request.cwd,
                    target,
                    request.limit,
                    &includes,
                    &request.excludes,
                )?;
                let enriched = results
                    .into_iter()
                    .map(|row| {
                        let (ctx_lines, _) = sym::source_context::read_source_context(
                            Path::new(&row.file),
                            row.line,
                            request.context,
                        );
                        json!({
                            "name": row.name,
                            "rel_path": row.rel_path,
                            "file": row.file,
                            "line": row.line,
                            "context": ctx_lines,
                        })
                    })
                    .collect::<Vec<_>>();
                grouped.push(json!({ "target": target, "results": enriched }));
            }
        }
        anyhow::Ok(grouped)
    })?;

    Ok(json!({
        "operation": "refs",
        "targets": request.targets,
        "importers": request.importers,
        "depth": request.depth,
        "limit": request.limit,
        "context": request.context,
        "paths": request.paths,
        "excludes": request.excludes,
        "file": request.file,
        "result_count": nested_result_count(&grouped),
        "results": grouped,
        "available": true,
        "read_only": true,
    }))
}

pub(crate) fn source_impact_value(
    request: SourceImpactRequest,
) -> Result<Value, Box<dyn std::error::Error>> {
    require_targets(
        &request.targets,
        "source impact requires at least one target",
    )?;

    let results = with_sym_db(request.db.as_deref(), || {
        let mut merged: Vec<sym::store::ImpactResult> = Vec::new();
        let mut source_map = std::collections::BTreeMap::<String, Vec<String>>::new();
        let mut seen = std::collections::BTreeMap::<String, usize>::new();

        for target in &request.targets {
            for row in sym::graph::find_impact(&request.cwd, target, request.depth, request.limit)?
            {
                let key = format!("{}:{}|{}", row.file, row.line, row.caller);
                if let Some(index) = seen.get(&key).copied() {
                    if row.depth < merged[index].depth {
                        merged[index] = row.clone();
                    }
                } else {
                    seen.insert(key.clone(), merged.len());
                    merged.push(row.clone());
                }
                let hits = source_map.entry(key).or_default();
                if !hits.contains(target) {
                    hits.push(target.clone());
                }
            }
        }

        let results = merged
            .into_iter()
            .map(|row| {
                let key = format!("{}:{}|{}", row.file, row.line, row.caller);
                let hits = source_map.get(&key).cloned().unwrap_or_default();
                let (ctx_lines, _) = sym::source_context::read_source_context(
                    Path::new(&row.file),
                    row.line,
                    request.context,
                );
                json!({
                    "depth": row.depth,
                    "caller": row.caller,
                    "symbol": row.symbol,
                    "file": row.file,
                    "rel_path": row.rel_path,
                    "line": row.line,
                    "hit_symbols": hits,
                    "context": ctx_lines,
                })
            })
            .collect::<Vec<_>>();
        anyhow::Ok(results)
    })?;

    Ok(json!({
        "operation": "impact",
        "targets": request.targets,
        "depth": request.depth,
        "limit": request.limit,
        "context": request.context,
        "result_count": results.len(),
        "results": results,
        "available": true,
        "read_only": true,
    }))
}

pub(crate) fn source_trace_value(
    request: SourceTraceRequest,
) -> Result<Value, Box<dyn std::error::Error>> {
    require_targets(
        &request.targets,
        "source trace requires at least one target",
    )?;

    let kinds = parse_kinds(&request.kinds);
    let results = with_sym_db(request.db.as_deref(), || {
        let mut merged: Vec<sym::store::TraceResult> = Vec::new();
        let mut source_map = std::collections::BTreeMap::<String, Vec<String>>::new();
        let mut seen = std::collections::BTreeMap::<String, usize>::new();

        for target in &request.targets {
            for row in sym::graph::find_trace(
                &request.cwd,
                strip_symbol_hint(target),
                request.depth,
                request.limit,
                &kinds,
            )? {
                let key = format!("{}:{}|{}", row.file, row.line, row.callee);
                if let Some(index) = seen.get(&key).copied() {
                    if row.depth < merged[index].depth {
                        merged[index] = row.clone();
                    }
                } else {
                    seen.insert(key.clone(), merged.len());
                    merged.push(row.clone());
                }
                let hits = source_map.entry(key).or_default();
                if !hits.contains(target) {
                    hits.push(target.clone());
                }
            }
        }

        let results = merged
            .into_iter()
            .map(|row| {
                let key = format!("{}:{}|{}", row.file, row.line, row.callee);
                let hits = source_map.get(&key).cloned().unwrap_or_default();
                json!({
                    "depth": row.depth,
                    "caller": row.caller,
                    "callee": row.callee,
                    "file": row.file,
                    "rel_path": row.rel_path,
                    "line": row.line,
                    "hit_symbols": hits,
                })
            })
            .collect::<Vec<_>>();
        anyhow::Ok(results)
    })?;

    Ok(json!({
        "operation": "trace",
        "targets": request.targets,
        "depth": request.depth,
        "limit": request.limit,
        "kinds": request.kinds,
        "result_count": results.len(),
        "results": results,
        "available": true,
        "read_only": true,
    }))
}

pub(crate) fn source_impls_value(
    request: SourceImplsRequest,
) -> Result<Value, Box<dyn std::error::Error>> {
    if request.of.is_none() {
        require_targets(
            &request.targets,
            "source impls requires at least one target or --of",
        )?;
    } else if !request.targets.is_empty() {
        return Err("pass either positional symbols or --of <type>, not both".into());
    }

    let results = with_sym_db(request.db.as_deref(), || {
        let opts = sym::impls::FindImplOptions {
            lang: request.lang.as_deref(),
            limit: request.limit,
            includes: &request.paths,
            excludes: &request.excludes,
            resolved_only: request.resolved,
            unresolved_only: request.unresolved,
        };

        if let Some(of) = request.of.as_deref() {
            let results = sym::impls::find_implements(&request.cwd, of, &opts)?;
            return anyhow::Ok(json!({
                "direction": "implements",
                "target": of,
                "results": results,
            }));
        }

        let mut grouped = Vec::new();
        for target in &request.targets {
            let results = sym::impls::find_implementors(&request.cwd, target, &opts)?;
            grouped.push(json!({ "target": target, "results": results }));
        }
        anyhow::Ok(json!({
            "direction": "implementors",
            "results": grouped,
        }))
    })?;

    Ok(json!({
        "operation": "impls",
        "targets": request.targets,
        "of": request.of,
        "lang": request.lang,
        "limit": request.limit,
        "paths": request.paths,
        "excludes": request.excludes,
        "resolved": request.resolved,
        "unresolved": request.unresolved,
        "result_count": impls_result_count(&results),
        "results": results,
        "available": true,
        "read_only": true,
    }))
}

pub(crate) fn source_investigate_value(
    request: SourceInvestigateRequest,
) -> Result<Value, Box<dyn std::error::Error>> {
    require_targets(
        &request.targets,
        "source investigate requires at least one target",
    )?;

    let grouped = with_sym_db(request.db.as_deref(), || {
        let mut grouped = Vec::new();
        for target in &request.targets {
            let results = sym::investigate::investigate(&request.cwd, target)?;
            grouped.push(json!({ "target": target, "results": results }));
        }
        anyhow::Ok(grouped)
    })?;

    Ok(json!({
        "operation": "investigate",
        "targets": request.targets,
        "result_count": grouped.len(),
        "results": grouped,
        "available": true,
        "read_only": true,
    }))
}

pub(crate) fn source_diff_value(
    request: SourceDiffRequest,
) -> Result<Value, Box<dyn std::error::Error>> {
    let result = with_sym_db(request.db.as_deref(), || {
        sym::diff::symbol_diff(&request.cwd, &request.target, &request.base, request.stat)
    })?;

    Ok(json!({
        "operation": "diff",
        "target": request.target,
        "base": request.base,
        "stat": request.stat,
        "result": result,
        "available": true,
        "read_only": true,
    }))
}

fn require_targets(targets: &[String], message: &str) -> Result<(), Box<dyn std::error::Error>> {
    if targets.is_empty() {
        return Err(message.to_string().into());
    }
    Ok(())
}

fn nested_result_count(grouped: &[Value]) -> usize {
    grouped
        .iter()
        .filter_map(|group| group.get("results").and_then(Value::as_array))
        .map(Vec::len)
        .sum()
}

fn impls_result_count(value: &Value) -> usize {
    if let Some(results) = value.get("results").and_then(Value::as_array) {
        if results.iter().all(|item| item.get("results").is_some()) {
            return nested_result_count(results);
        }
        return results.len();
    }
    0
}

fn parse_kinds(raw: &str) -> Vec<&str> {
    raw.split(',')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect()
}

fn strip_symbol_hint(target: &str) -> &str {
    target
        .rsplit_once(':')
        .map(|(_, symbol)| symbol)
        .unwrap_or(target)
}

fn with_sym_db<T>(
    db: Option<&str>,
    f: impl FnOnce() -> anyhow::Result<T>,
) -> Result<T, Box<dyn std::error::Error>> {
    if let Some(db) = db {
        let _guard = SYM_DB_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .map_err(|error| error.to_string())?;
        let previous = std::env::var_os("SYM_DB");
        unsafe {
            std::env::set_var("SYM_DB", db);
        }
        let result = f();
        unsafe {
            if let Some(previous) = previous {
                std::env::set_var("SYM_DB", previous);
            } else {
                std::env::remove_var("SYM_DB");
            }
        }
        return result.map_err(Into::into);
    }
    f().map_err(Into::into)
}

fn non_empty_query<'a>(
    query: &'a str,
    message: &str,
) -> Result<&'a str, Box<dyn std::error::Error>> {
    let query = query.trim();
    if query.is_empty() {
        return Err(message.to_string().into());
    }
    Ok(query)
}

fn matches_path_query(path: &str, query: &str, ignore_case: bool) -> bool {
    let (path, query) = if ignore_case {
        (path.to_ascii_lowercase(), query.to_ascii_lowercase())
    } else {
        (path.to_string(), query.to_string())
    };
    if query.contains('*') {
        wildcard_match(&path, &query)
    } else {
        path.contains(&query)
    }
}

fn resolve_target_path(cwd: &Path, path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd.join(path)
    }
}

fn looks_like_file_target(target: &str) -> bool {
    if let Some((path, suffix)) = target.rsplit_once(':') {
        if is_line_range(suffix) {
            return true;
        }
        if looks_like_plain_file(path) {
            return false;
        }
    }

    looks_like_plain_file(target)
}

fn parse_file_target(target: &str) -> (String, Option<(usize, usize)>) {
    let Some((path, range)) = target.rsplit_once(':') else {
        return (target.to_string(), None);
    };
    let Some((start, end)) = range.split_once('-') else {
        return (target.to_string(), None);
    };
    let Ok(start) = start.trim_start_matches('L').parse::<usize>() else {
        return (target.to_string(), None);
    };
    let Ok(end) = end.trim_start_matches('L').parse::<usize>() else {
        return (target.to_string(), None);
    };
    (path.to_string(), Some((start, end)))
}

fn looks_like_plain_file(target: &str) -> bool {
    target.contains('/') || sym::lang::language_for_file(Path::new(target)).is_some()
}

fn is_line_range(value: &str) -> bool {
    let Some((start, end)) = value.split_once('-') else {
        return false;
    };
    start.trim_start_matches('L').parse::<usize>().is_ok()
        && end.trim_start_matches('L').parse::<usize>().is_ok()
}

fn wildcard_match(value: &str, pattern: &str) -> bool {
    let parts = pattern.split('*').collect::<Vec<_>>();
    if parts.len() == 1 {
        return value == pattern;
    }
    let mut remainder = value;
    if let Some(first) = parts.first()
        && !first.is_empty()
    {
        let Some(stripped) = remainder.strip_prefix(first) else {
            return false;
        };
        remainder = stripped;
    }
    for part in parts.iter().skip(1).take(parts.len().saturating_sub(2)) {
        if part.is_empty() {
            continue;
        }
        let Some(index) = remainder.find(part) else {
            return false;
        };
        remainder = &remainder[index + part.len()..];
    }
    if let Some(last) = parts.last()
        && !last.is_empty()
    {
        return remainder.ends_with(last) || remainder.contains(last);
    }
    true
}

fn mode_name(mode: SourceSearchMode) -> &'static str {
    match mode {
        SourceSearchMode::Symbol => "symbol",
        SourceSearchMode::Text => "text",
        SourceSearchMode::Path => "path",
        SourceSearchMode::Structural => "structural",
    }
}
