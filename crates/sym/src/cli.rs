use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::bail;
use clap::{Args, Subcommand, ValueEnum};
use serde::Serialize;
use serde_json::{Value, json};

use crate::context;
use crate::diff;
use crate::graph;
use crate::impls;
use crate::indexer;
use crate::investigate;
use crate::ls;
use crate::multisym;
use crate::outline;
use crate::output;
use crate::search;
use crate::show;
use crate::source_context;
use crate::structure;
use crate::version;

#[derive(Args, Debug)]
pub struct SymArgs {
    #[arg(short = 'd', long)]
    pub db: Option<PathBuf>,

    #[arg(long, value_enum)]
    pub format: Option<OutputFormatArg>,

    #[command(subcommand)]
    pub command: Command,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, ValueEnum)]
pub enum OutputFormatArg {
    Text,
    Ai,
}

impl From<OutputFormatArg> for output::OutputFormat {
    fn from(value: OutputFormatArg) -> Self {
        match value {
            OutputFormatArg::Text => output::OutputFormat::Text,
            OutputFormatArg::Ai => output::OutputFormat::Ai,
        }
    }
}

#[derive(Serialize)]
struct TargetResult<T> {
    target: String,
    results: T,
}

#[derive(Subcommand, Debug)]
pub enum Command {
    #[command(about = "Index a directory for symbol discovery")]
    Index {
        #[arg(default_value = ".")]
        path: PathBuf,

        #[arg(short, long, default_value_t = 0)]
        workers: usize,

        #[arg(short, long, default_value_t = false)]
        force: bool,

        #[arg(long, default_value_t = false)]
        reset: bool,

        #[arg(long = "ignore")]
        ignore: Vec<String>,
    },

    #[command(about = "Search symbols or text across files")]
    Search {
        query: Vec<String>,

        #[arg(short = 't', long, default_value_t = false)]
        text: bool,

        #[arg(short = 'n', long, default_value_t = 20)]
        limit: usize,

        #[arg(short = 'k', long)]
        kind: Option<String>,

        #[arg(short = 'l', long)]
        lang: Option<String>,

        #[arg(short = 'e', long, default_value_t = false)]
        exact: bool,

        #[arg(short = 'i', long = "ignore-case", default_value_t = false)]
        ignore_case: bool,

        #[arg(long = "path")]
        path_filters: Vec<String>,

        #[arg(long = "exclude")]
        excludes: Vec<String>,
    },

    #[command(about = "Show indexed source statistics")]
    Stats,

    #[command(about = "Map indexed files and symbols at increasing detail levels")]
    Map {
        #[arg(
            long,
            default_value_t = 2,
            value_parser = clap::value_parser!(u8).range(1..=3)
        )]
        level: u8,

        #[arg(short = 'n', long, default_value_t = 100)]
        limit: usize,
    },

    #[command(about = "Friendly symbol query with fuzzy prefix matching")]
    Query {
        query: Vec<String>,

        #[arg(short = 'n', long, default_value_t = 20)]
        limit: usize,

        #[arg(short = 'k', long)]
        kind: Option<String>,

        #[arg(short = 'l', long)]
        lang: Option<String>,

        #[arg(short = 'e', long, default_value_t = false)]
        exact: bool,

        #[arg(long = "path")]
        path_filters: Vec<String>,

        #[arg(long = "exclude")]
        excludes: Vec<String>,
    },

    #[command(about = "Inspect symbols defined in a file")]
    Inspect {
        file: PathBuf,

        #[arg(short = 's', long, default_value_t = false)]
        signatures: bool,

        #[arg(long, default_value_t = false)]
        names: bool,
    },

    #[command(about = "Show symbols defined in a file")]
    Outline {
        file: PathBuf,

        #[arg(short = 's', long, default_value_t = false)]
        signatures: bool,

        #[arg(long, default_value_t = false)]
        names: bool,
    },

    #[command(about = "Read source by symbol name or file path")]
    Show {
        targets: Vec<String>,

        #[arg(short = 'C', long, default_value_t = 0)]
        context: usize,

        #[arg(long, default_value_t = false)]
        all: bool,

        #[arg(long, default_value_t = false)]
        stdin: bool,
    },

    #[command(about = "Show file tree, repo list, or repo stats")]
    Ls {
        path: Option<PathBuf>,

        #[arg(long, default_value_t = false)]
        repos: bool,

        #[arg(long, default_value_t = false)]
        stats: bool,

        #[arg(short = 'D', long = "depth", default_value_t = 0)]
        depth: usize,
    },

    #[command(about = "Find references to a symbol")]
    Refs {
        targets: Vec<String>,

        #[arg(long, default_value_t = false)]
        importers: bool,

        #[arg(long, default_value_t = false)]
        impact: bool,

        #[arg(short = 'D', long = "depth", default_value_t = 1)]
        depth: usize,

        #[arg(short = 'n', long, default_value_t = 20)]
        limit: usize,

        #[arg(short = 'C', long = "context", default_value_t = 1)]
        context: usize,

        #[arg(long = "path")]
        path_filters: Vec<String>,

        #[arg(long = "exclude")]
        excludes: Vec<String>,

        #[arg(long)]
        file: Option<String>,

        #[arg(long, default_value_t = false)]
        stdin: bool,
    },

    #[command(about = "Find files that import a given file or package")]
    Importers {
        target: String,

        #[arg(short = 'D', long = "depth", default_value_t = 1)]
        depth: usize,

        #[arg(short = 'n', long, default_value_t = 50)]
        limit: usize,
    },

    #[command(about = "Find direct callers of symbols")]
    Callers {
        targets: Vec<String>,

        #[arg(short = 'n', long, default_value_t = 20)]
        limit: usize,

        #[arg(short = 'C', long = "context", default_value_t = 1)]
        context: usize,

        #[arg(long = "path")]
        path_filters: Vec<String>,

        #[arg(long = "exclude")]
        excludes: Vec<String>,
    },

    #[command(about = "Find direct callees from symbols")]
    Callees {
        targets: Vec<String>,

        #[arg(short = 'n', long, default_value_t = 20)]
        limit: usize,

        #[arg(long = "path")]
        path_filters: Vec<String>,

        #[arg(long = "exclude")]
        excludes: Vec<String>,
    },

    #[command(about = "Find transitive callers of a symbol")]
    Impact {
        targets: Vec<String>,

        #[arg(short = 'D', long = "depth", default_value_t = 2)]
        depth: usize,

        #[arg(short = 'n', long, default_value_t = 50)]
        limit: usize,

        #[arg(short = 'C', long = "context", default_value_t = 1)]
        context: usize,

        #[arg(long, default_value_t = false)]
        stdin: bool,
    },

    #[command(about = "Follow the call graph downward from a symbol")]
    Trace {
        targets: Vec<String>,

        #[arg(long, default_value_t = 3)]
        depth: usize,

        #[arg(short = 'n', long, default_value_t = 50)]
        limit: usize,

        #[arg(long, default_value = "call")]
        kinds: String,

        #[arg(long, default_value_t = false)]
        stdin: bool,
    },

    #[command(about = "Find types that implement a symbol or what a type implements")]
    Impls {
        targets: Vec<String>,

        #[arg(short = 'l', long)]
        lang: Option<String>,

        #[arg(short = 'n', long, default_value_t = 50)]
        limit: usize,

        #[arg(long = "path")]
        path_filters: Vec<String>,

        #[arg(long = "exclude")]
        excludes: Vec<String>,

        #[arg(long = "of")]
        of: Option<String>,

        #[arg(long, default_value_t = false)]
        resolved: bool,

        #[arg(long, default_value_t = false)]
        unresolved: bool,

        #[arg(long, default_value_t = false)]
        stdin: bool,
    },

    #[command(about = "Find types used by a symbol signature")]
    Types {
        targets: Vec<String>,

        #[arg(short = 'n', long, default_value_t = 20)]
        limit: usize,

        #[arg(long = "path")]
        path_filters: Vec<String>,

        #[arg(long = "exclude")]
        excludes: Vec<String>,
    },

    #[command(about = "Show field schema for structs/classes")]
    Schema {
        targets: Vec<String>,

        #[arg(short = 'n', long, default_value_t = 20)]
        limit: usize,
    },

    #[command(about = "Find tests that reference symbols")]
    Tests {
        targets: Vec<String>,

        #[arg(short = 'n', long, default_value_t = 50)]
        limit: usize,

        #[arg(long = "path")]
        path_filters: Vec<String>,

        #[arg(long = "exclude")]
        excludes: Vec<String>,
    },

    #[command(about = "Find production dependencies called by a test")]
    TestDeps {
        target: String,

        #[arg(short = 'n', long, default_value_t = 50)]
        limit: usize,

        #[arg(long = "path")]
        path_filters: Vec<String>,

        #[arg(long = "exclude")]
        excludes: Vec<String>,
    },

    #[command(about = "Report production symbols with no indexed test references")]
    Untested {
        #[arg(short = 'n', long, default_value_t = 50)]
        limit: usize,

        #[arg(short = 'l', long)]
        lang: Option<String>,

        #[arg(long = "path")]
        path_filters: Vec<String>,

        #[arg(long = "exclude")]
        excludes: Vec<String>,
    },

    #[command(about = "Bundled context: source, callers, conformance, and file imports")]
    Context {
        targets: Vec<String>,

        #[arg(short = 'n', long, default_value_t = 20)]
        callers: usize,

        #[arg(long, default_value_t = false)]
        stdin: bool,
    },

    #[command(about = "Kind-adaptive investigation for symbols")]
    Investigate {
        targets: Vec<String>,

        #[arg(long, default_value_t = false)]
        stdin: bool,
    },

    #[command(about = "Structural overview of the indexed codebase")]
    Structure {
        #[arg(short = 'n', long, default_value_t = 10)]
        limit: usize,
    },

    #[command(about = "Show git diff scoped to a symbol's definition")]
    Diff {
        target: String,

        #[arg(default_value = "HEAD")]
        base: String,

        #[arg(long, default_value_t = false)]
        stat: bool,
    },

    #[command(about = "Print sym version information")]
    Version,
}

pub fn run_index(path: &Path, force: bool, reset: bool, ignore: &[String]) -> anyhow::Result<()> {
    let root = path.canonicalize()?;
    let db_path = crate::repo::configured_db_path(&root, None)?;
    if reset {
        indexer::reset_db(&db_path)?;
    }
    let stats = indexer::index(
        &root,
        &indexer::IndexOptions {
            db_path: Some(db_path.clone()),
            cli_ignore_patterns: ignore.to_vec(),
            force,
        },
    )?;

    if output::structured_enabled() {
        let store = crate::store::Store::open(&db_path)?;
        let repo_stats = store.repo_stats()?;
        return output::write_structured(&json!({
            "operation": "index",
            "repo_root": repo_stats.path,
            "db_path": db_path,
            "cache_dir": crate::repo::sym_dir()?,
            "force": force,
            "reset": reset,
            "ignore_patterns": ignore,
            "files_indexed": stats.files_indexed,
            "files_skipped": stats.files_skipped,
            "symbols_found": stats.symbols_found,
            "stale_removed": stats.stale_removed,
            "file_count": repo_stats.file_count,
            "symbol_count": repo_stats.symbol_count,
            "languages": repo_stats.languages,
            "available": true,
            "read_only": true,
        }));
    }

    println!(
        "Indexed {} parseable files in {}",
        stats.files_indexed,
        root.display()
    );
    if !stats.ignore_patterns.is_empty() {
        println!("Ignore patterns: {}", stats.ignore_patterns.join(", "));
    }

    Ok(())
}

pub fn run_stats() -> anyhow::Result<()> {
    let cwd = std::env::current_dir()?;
    let stats = ls::repo_stats(&cwd)?;
    if output::structured_enabled() {
        return output::write_structured(&json!({
            "operation": "stats",
            "repo": stats.path,
            "file_count": stats.file_count,
            "symbol_count": stats.symbol_count,
            "languages": stats.languages,
            "available": true,
            "read_only": true,
        }));
    }
    println!(
        "stats: {} file(s), {} symbol(s)",
        stats.file_count, stats.symbol_count
    );
    println!("repo: {}", stats.path);
    for (language, count) in stats.languages {
        println!("{language}: {count}");
    }
    Ok(())
}

pub fn run_map(level: u8, limit: usize) -> anyhow::Result<()> {
    let cwd = std::env::current_dir()?;
    let level = level.clamp(1, 3);
    let store = crate::resolve::open_store(&cwd)?;
    let overview = store.structure(limit.max(1))?;
    let mut files = Vec::new();
    if level >= 2 {
        for file in store.all_files(None)?.into_iter().take(limit.max(1)) {
            let symbols = store.file_outline(Path::new(&file.path))?;
            let mut row = json!({
                "path": file.rel_path,
                "language": file.language,
                "symbol_count": symbols.len(),
            });
            if level >= 3 {
                row["symbols"] = serde_json::to_value(symbols)?;
            }
            files.push(row);
        }
    }
    if output::structured_enabled() {
        return output::write_structured(&json!({
            "operation": "map",
            "level": level,
            "limit": limit,
            "overview": overview,
            "files": files,
            "file_count": files.len(),
            "available": true,
            "read_only": true,
        }));
    }
    println!(
        "map level {level}: {} file(s), {} symbol(s)",
        overview.files, overview.symbols
    );
    for file in files {
        println!(
            "{} [{}] {} symbol(s)",
            file["path"].as_str().unwrap_or("?"),
            file["language"].as_str().unwrap_or(""),
            file["symbol_count"].as_u64().unwrap_or(0)
        );
    }
    Ok(())
}

pub struct SearchArgs<'a> {
    pub query: &'a [String],
    pub text: bool,
    pub limit: usize,
    pub kind: Option<&'a str>,
    pub lang: Option<&'a str>,
    pub exact: bool,
    pub ignore_case: bool,
    pub path_filters: &'a [String],
    pub excludes: &'a [String],
}

pub fn run_search(args: &SearchArgs<'_>) -> anyhow::Result<()> {
    let query = args.query.join(" ");
    if query.trim().is_empty() {
        bail!("search query cannot be empty");
    }

    let effective_exact = search::normalize_search_mode(args.exact, args.ignore_case, args.text)?;
    let root = std::env::current_dir()?;
    if args.text {
        let results = search::search_text(
            &root,
            &query,
            args.lang,
            args.limit,
            args.path_filters,
            args.excludes,
            effective_exact,
        )?;
        if results.is_empty() {
            bail!("no results found for '{query}'");
        }

        if output::structured_enabled() {
            return output::write_structured(&json!({
                "operation": "search",
                "mode": "text",
                "query": query,
                "lang": args.lang,
                "paths": args.path_filters,
                "excludes": args.excludes,
                "limit": args.limit,
                "result_count": results.len(),
                "results": results,
                "available": true,
                "read_only": true,
            }));
        }

        let mut content = String::new();
        for result in &results {
            content.push_str(&format!(
                "{}:{}: {}\n",
                result.rel_path.display(),
                result.line,
                result.snippet
            ));
        }

        return output::render(
            &results,
            &[
                ("query", query.clone()),
                ("result_count", results.len().to_string()),
            ],
            &content,
        );
    }

    let results = search::search_symbols(
        &root,
        &query,
        &search::SymbolSearchOptions {
            kind: args.kind,
            lang: args.lang,
            limit: args.limit,
            exact: effective_exact,
            ignore_case: args.ignore_case,
            includes: args.path_filters,
            excludes: args.excludes,
        },
    )?;
    if results.is_empty() {
        bail!("no results found for '{query}'");
    }

    if output::structured_enabled() {
        return output::write_structured(&json!({
            "operation": "search",
            "mode": "symbol",
            "query": query,
            "lang": args.lang,
            "paths": args.path_filters,
            "excludes": args.excludes,
            "limit": args.limit,
            "result_count": results.len(),
            "results": results,
            "available": true,
            "read_only": true,
        }));
    }

    let mut content = String::new();
    for result in &results {
        content.push_str(&format!(
            "{} {} {}:{}\n",
            result.kind, result.name, result.rel_path, result.start_line
        ));
    }

    output::render(
        &results,
        &[
            ("query", query),
            ("result_count", results.len().to_string()),
        ],
        &content,
    )
}

pub struct QueryArgs<'a> {
    pub query: &'a [String],
    pub limit: usize,
    pub kind: Option<&'a str>,
    pub lang: Option<&'a str>,
    pub exact: bool,
    pub path_filters: &'a [String],
    pub excludes: &'a [String],
}

pub fn run_query(args: &QueryArgs<'_>) -> anyhow::Result<()> {
    let query = args.query.join(" ");
    if query.trim().is_empty() {
        bail!("query cannot be empty");
    }
    let root = std::env::current_dir()?;
    let results = search::search_symbols(
        &root,
        &query,
        &search::SymbolSearchOptions {
            kind: args.kind,
            lang: args.lang,
            limit: args.limit,
            exact: args.exact,
            ignore_case: false,
            includes: args.path_filters,
            excludes: args.excludes,
        },
    )?;
    if output::structured_enabled() {
        return output::write_structured(&json!({
            "operation": "query",
            "mode": "symbol",
            "query": query,
            "fuzzy": !args.exact,
            "lang": args.lang,
            "paths": args.path_filters,
            "excludes": args.excludes,
            "limit": args.limit,
            "result_count": results.len(),
            "results": results,
            "available": true,
            "read_only": true,
        }));
    }
    for result in results {
        println!(
            "{}:{} {} {}",
            result.rel_path, result.start_line, result.kind, result.name
        );
    }
    Ok(())
}

pub fn run_outline(file: &Path, signatures: bool, names: bool) -> anyhow::Result<()> {
    run_outline_operation("outline", file, signatures, names)
}

pub fn run_inspect(file: &Path, signatures: bool, names: bool) -> anyhow::Result<()> {
    run_outline_operation("inspect", file, signatures, names)
}

fn run_outline_operation(
    operation: &str,
    file: &Path,
    signatures: bool,
    names: bool,
) -> anyhow::Result<()> {
    let cwd = std::env::current_dir()?;
    let symbols = outline::file_outline(&cwd, file)?;
    if names {
        let mut seen = std::collections::BTreeSet::new();
        let mut names_out = Vec::new();
        for symbol in symbols {
            if seen.insert(symbol.name.clone()) {
                names_out.push(symbol.name);
            }
        }
        if output::structured_enabled() {
            return output::write_structured(&json!({
                "operation": operation,
                "file": file,
                "signatures": signatures,
                "names_only": true,
                "symbol_count": names_out.len(),
                "results": names_out,
                "available": true,
                "read_only": true,
            }));
        }
        for name in names_out {
            println!("{name}");
        }
        return Ok(());
    }

    if output::structured_enabled() {
        return output::write_structured(&json!({
            "operation": operation,
            "file": file,
            "signatures": signatures,
            "names_only": false,
            "symbol_count": symbols.len(),
            "symbols": symbols.clone(),
            "results": symbols,
            "available": true,
            "read_only": true,
        }));
    }

    let rel_file = file.display().to_string();
    let mut content = String::new();
    for symbol in &symbols {
        let indent = "  ".repeat(symbol.depth);
        if signatures && !symbol.signature.is_empty() {
            content.push_str(&format!(
                "{}{} {}{} (L{}-{})",
                indent,
                symbol.kind,
                symbol.name,
                symbol.signature,
                symbol.start_line,
                symbol.end_line
            ));
        } else {
            content.push_str(&format!(
                "{}{} {} (L{}-{})",
                indent, symbol.kind, symbol.name, symbol.start_line, symbol.end_line
            ));
        }
        content.push('\n');
    }

    output::write_frontmatter(
        &[
            ("file", rel_file),
            ("symbol_count", symbols.len().to_string()),
        ],
        &content,
    )
}

pub fn run_show(targets: &[String], context: usize, all: bool, stdin: bool) -> anyhow::Result<()> {
    let cwd = std::env::current_dir()?;
    let targets = multisym::collect_symbols(targets, stdin)?;

    if output::structured_enabled() {
        let mut rendered = Vec::new();
        for target in &targets {
            if looks_like_file_target(target) {
                let (path, range) = parse_file_target(target);
                let Some(range) = range else {
                    anyhow::bail!(
                        "sym show does not accept bare file paths: {target}. Use file:line-line, outline, or a file reader instead"
                    );
                };
                let lines = show::show_file(Path::new(&path), Some(range), context)?;
                rendered.push(json!({
                    "target": target,
                    "kind": "file",
                    "results": lines,
                }));
            } else {
                let shown = show::show_symbol(&cwd, target, context, all)?;
                rendered.push(json!({
                    "target": target,
                    "kind": "symbol",
                    "results": shown,
                }));
            }
        }
        return output::write_structured(&json!({
            "operation": "show",
            "targets": targets,
            "all": all,
            "context": context,
            "result_count": rendered.len(),
            "results": rendered,
            "available": true,
            "read_only": true,
        }));
    }

    for (index, target) in targets.iter().enumerate() {
        print!("{}", multisym::multi_symbol_header(target, index == 0));
        if looks_like_file_target(target) {
            let (path, range) = parse_file_target(target);
            let Some(range) = range else {
                anyhow::bail!(
                    "sym show does not accept bare file paths: {target}. Use file:line-line, outline, or a file reader instead"
                );
            };
            let lines = show::show_file(Path::new(&path), Some(range), context)?;
            for line in lines {
                println!("{}", line.content);
            }
            continue;
        }

        for shown in show::show_symbol(&cwd, target, context, all)? {
            print!("{}", shown.content);
            if !shown.content.ends_with('\n') {
                println!();
            }
        }
    }

    Ok(())
}

pub fn run_ls(path: Option<&Path>, repos: bool, stats: bool, depth: usize) -> anyhow::Result<()> {
    if repos {
        let repos = ls::list_repos()?;
        if output::structured_enabled() {
            return output::write_structured(&repos);
        }
        if repos.is_empty() {
            return Ok(());
        }
        for repo in repos {
            println!(
                "{}  {} files  {} symbols",
                repo.path, repo.file_count, repo.symbol_count
            );
        }
        return Ok(());
    }

    let cwd = std::env::current_dir()?;
    if stats {
        let stats = ls::repo_stats(&cwd)?;
        let mut content = String::new();
        for (language, count) in &stats.languages {
            content.push_str(&format!("{language}: {count} files\n"));
        }
        return output::render(
            &stats,
            &[
                ("repo", stats.path.clone()),
                ("files", stats.file_count.to_string()),
                ("symbols", stats.symbol_count.to_string()),
            ],
            &content,
        );
    }

    let path = path.unwrap_or_else(|| Path::new("."));
    let tree = ls::tree(path, depth)?;
    if output::structured_enabled() {
        return output::write_structured(&tree);
    }
    print!("{}", crate::walker::print_tree(&tree));
    Ok(())
}

pub struct RefsArgs<'a> {
    pub targets: &'a [String],
    pub importers: bool,
    pub impact: bool,
    pub depth: usize,
    pub limit: usize,
    pub context: usize,
    pub path_filters: &'a [String],
    pub excludes: &'a [String],
    pub file: Option<&'a str>,
    pub stdin: bool,
}

pub fn run_refs(args: &RefsArgs<'_>) -> anyhow::Result<()> {
    let RefsArgs {
        targets,
        importers,
        impact,
        depth,
        limit,
        context,
        path_filters,
        excludes,
        file,
        stdin,
    } = *args;
    let cwd = std::env::current_dir()?;
    let targets = multisym::collect_symbols(targets, stdin)?;

    if impact {
        return run_impact(&targets, depth.max(2), limit, context, false);
    }

    let mut includes: Vec<String> = path_filters.to_vec();
    if let Some(fragment) = file {
        includes.push(fragment.to_string());
    }

    if output::structured_enabled() {
        let mut grouped = Vec::new();
        for target in &targets {
            if importers {
                let results =
                    graph::find_importers(&cwd, target, depth, limit, &includes, excludes)?;
                let results = results
                    .into_iter()
                    .map(|row| {
                        json!({
                            "file": row.file,
                            "rel_path": row.rel_path,
                            "import": row.import,
                            "depth": row.depth,
                            "evidence": import_path_evidence(),
                            "confidence": "medium",
                        })
                    })
                    .collect::<Vec<_>>();
                grouped.push(TargetResult {
                    target: target.clone(),
                    results: json!(results),
                });
            } else {
                let results = graph::find_references(&cwd, target, limit, &includes, excludes)?;
                let enriched = results
                    .into_iter()
                    .map(|row| {
                        let (ctx_lines, _) = source_context::read_source_context(
                            Path::new(&row.file),
                            row.line,
                            context,
                        );
                        json!({
                            "name": row.name,
                            "rel_path": row.rel_path,
                            "file": row.file,
                            "line": row.line,
                            "context": ctx_lines,
                            "reference_kind": row.kind,
                            "evidence": reference_evidence(&row.kind),
                            "confidence": reference_confidence(&row.kind),
                        })
                    })
                    .collect::<Vec<_>>();
                grouped.push(TargetResult {
                    target: target.clone(),
                    results: json!(enriched),
                });
            }
        }
        return output::write_structured(&json!({
            "operation": "refs",
            "targets": targets,
            "importers": importers,
            "depth": depth,
            "limit": limit,
            "context": context,
            "paths": path_filters,
            "excludes": excludes,
            "file": file,
            "result_count": nested_result_count(&grouped),
            "results": grouped,
            "available": true,
            "read_only": true,
        }));
    }

    for (target_index, target) in targets.iter().enumerate() {
        if target_index > 0 {
            println!();
        }

        if importers {
            let results = graph::find_importers(&cwd, target, depth, limit, &includes, excludes)?;
            if results.is_empty() {
                println!("No importers found for '{target}'.");
                continue;
            }
            let mut content = String::new();
            for result in &results {
                content.push_str(&format!("{}:{}\n", result.rel_path, result.import));
            }
            output::write_frontmatter(
                &[
                    ("symbol", target.clone()),
                    ("importer_count", results.len().to_string()),
                ],
                &content,
            )?;
            continue;
        }

        let results = graph::find_references(&cwd, target, limit, &includes, excludes)?;
        if results.is_empty() {
            println!("No references found for '{target}'.");
            continue;
        }
        let refs: Vec<source_context::RefLine> = results
            .iter()
            .map(|row| {
                let (ctx_lines, ctx_start) =
                    source_context::read_source_context(Path::new(&row.file), row.line, context);
                source_context::RefLine {
                    rel_path: row.rel_path.clone(),
                    line: row.line,
                    text: source_context::read_source_line(Path::new(&row.file), row.line)
                        .trim()
                        .to_string(),
                    context_lines: ctx_lines,
                    context_start: ctx_start,
                }
            })
            .collect();
        let (lines, groups) = source_context::dedup_ref_lines(&refs);
        let mut content = String::new();
        for line in &lines {
            content.push_str(line);
            content.push('\n');
        }

        let mut meta = vec![("symbol", target.clone())];
        if groups < results.len() {
            meta.push(("groups", groups.to_string()));
            meta.push(("total_refs", results.len().to_string()));
        } else {
            meta.push(("ref_count", results.len().to_string()));
        }
        output::write_frontmatter(&meta, &content)?;
    }

    Ok(())
}

pub fn run_importers(target: &str, depth: usize, limit: usize) -> anyhow::Result<()> {
    let cwd = std::env::current_dir()?;
    let results = graph::find_importers_by_path(&cwd, target, depth, limit)?;
    if results.is_empty() {
        bail!("no importers found for '{target}'");
    }
    if output::structured_enabled() {
        return output::write_structured(&results);
    }
    let mut content = String::new();
    for result in &results {
        content.push_str(&format!("{}:{}\n", result.rel_path, result.import));
    }
    output::write_frontmatter(
        &[
            ("target", target.to_string()),
            ("importer_count", results.len().to_string()),
        ],
        &content,
    )
}

pub fn run_callers(
    targets: &[String],
    limit: usize,
    context: usize,
    path_filters: &[String],
    excludes: &[String],
) -> anyhow::Result<()> {
    if targets.is_empty() {
        bail!("callers requires at least one target");
    }
    let cwd = std::env::current_dir()?;
    let store = crate::resolve::open_store(&cwd)?;
    let fetch_limit = crate::pathfilters::widen_path_filter_limit(
        limit,
        !path_filters.is_empty() || !excludes.is_empty(),
    )
    .max(1);
    let mut rows = Vec::new();
    for target in targets {
        for reference in
            store.find_references(target, fetch_limit, &[crate::symbols::REF_KIND_CALL])?
        {
            if !crate::pathfilters::include_path(
                Path::new(&reference.rel_path),
                path_filters,
                excludes,
            ) {
                continue;
            }
            let caller = store
                .enclosing_symbol_detail(&reference.file, reference.line)?
                .map(|symbol| symbol.name)
                .unwrap_or_else(|| "<top-level>".to_string());
            let (ctx_lines, _) = source_context::read_source_context(
                Path::new(&reference.file),
                reference.line,
                context,
            );
            rows.push(json!({
                "target": target,
                "caller": caller,
                "callee": reference.name,
                "file": reference.file,
                "rel_path": reference.rel_path,
                "line": reference.line,
                "context": ctx_lines,
                "reference_kind": reference.kind,
                "evidence": parsed_call_evidence(),
                "confidence": "high",
            }));
            if limit > 0 && rows.len() >= limit {
                break;
            }
        }
        if limit > 0 && rows.len() >= limit {
            break;
        }
    }
    if output::structured_enabled() {
        return output::write_structured(&json!({
            "operation": "callers",
            "targets": targets,
            "limit": limit,
            "context": context,
            "paths": path_filters,
            "excludes": excludes,
            "result_count": rows.len(),
            "results": rows,
            "available": true,
            "read_only": true,
        }));
    }
    println!("callers: {} result(s)", rows.len());
    for row in rows {
        println!("{}", source_hit_line(&row));
    }
    Ok(())
}

pub fn run_callees(
    targets: &[String],
    limit: usize,
    path_filters: &[String],
    excludes: &[String],
) -> anyhow::Result<()> {
    if targets.is_empty() {
        bail!("callees requires at least one target");
    }
    let cwd = std::env::current_dir()?;
    let fetch_limit = crate::pathfilters::widen_path_filter_limit(
        limit,
        !path_filters.is_empty() || !excludes.is_empty(),
    )
    .max(1);
    let mut rows = Vec::new();
    for target in targets {
        for edge in graph::find_trace(
            &cwd,
            strip_symbol_hint(target),
            1,
            fetch_limit,
            &[crate::symbols::REF_KIND_CALL],
        )? {
            if !crate::pathfilters::include_path(Path::new(&edge.rel_path), path_filters, excludes)
            {
                continue;
            }
            rows.push(json!({
                "target": target,
                "caller": edge.caller,
                "callee": edge.callee,
                "file": edge.file,
                "rel_path": edge.rel_path,
                "line": edge.line,
                "depth": edge.depth,
                "reference_kind": edge.kind,
                "evidence": reference_evidence(&edge.kind),
                "confidence": reference_confidence(&edge.kind),
            }));
            if limit > 0 && rows.len() >= limit {
                break;
            }
        }
        if limit > 0 && rows.len() >= limit {
            break;
        }
    }
    if output::structured_enabled() {
        return output::write_structured(&json!({
            "operation": "callees",
            "targets": targets,
            "limit": limit,
            "paths": path_filters,
            "excludes": excludes,
            "result_count": rows.len(),
            "results": rows,
            "available": true,
            "read_only": true,
        }));
    }
    println!("callees: {} result(s)", rows.len());
    for row in rows {
        println!("{}", source_hit_line(&row));
    }
    Ok(())
}

pub fn run_impact(
    targets: &[String],
    depth: usize,
    limit: usize,
    context: usize,
    stdin: bool,
) -> anyhow::Result<()> {
    let cwd = std::env::current_dir()?;
    let targets = multisym::collect_symbols(targets, stdin)?;

    let mut merged: Vec<crate::store::ImpactResult> = Vec::new();
    let mut source_map = std::collections::BTreeMap::<String, Vec<String>>::new();
    let mut seen = std::collections::BTreeMap::<String, usize>::new();

    for target in targets {
        for row in graph::find_impact(&cwd, &target, depth, limit)? {
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
            if !hits.contains(&target) {
                hits.push(target.clone());
            }
        }
    }

    if merged.is_empty() {
        bail!("no callers found");
    }

    if output::structured_enabled() {
        let results = merged
            .into_iter()
            .map(|row| {
                let key = format!("{}:{}|{}", row.file, row.line, row.caller);
                let hits = source_map.get(&key).cloned().unwrap_or_default();
                let (ctx_lines, _) =
                    source_context::read_source_context(Path::new(&row.file), row.line, context);
                json!({
                    "depth": row.depth,
                    "caller": row.caller,
                    "symbol": row.symbol,
                    "file": row.file,
                    "rel_path": row.rel_path,
                    "line": row.line,
                    "hit_symbols": hits,
                    "context": ctx_lines,
                    "reference_kind": row.kind,
                    "evidence": reference_evidence(&row.kind),
                    "confidence": reference_confidence(&row.kind),
                })
            })
            .collect::<Vec<_>>();
        return output::write_structured(&json!({
            "operation": "impact",
            "targets": source_map
                .values()
                .flatten()
                .cloned()
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect::<Vec<_>>(),
            "depth": depth,
            "limit": limit,
            "context": context,
            "result_count": results.len(),
            "results": results,
            "available": true,
            "read_only": true,
        }));
    }

    let max_depth = merged.iter().map(|row| row.depth).max().unwrap_or(0);
    let mut content = String::new();
    let mut total_groups = 0usize;
    for depth_level in 1..=max_depth {
        let refs: Vec<source_context::RefLine> = merged
            .iter()
            .filter(|row| row.depth == depth_level)
            .map(|row| {
                let key = format!("{}:{}|{}", row.file, row.line, row.caller);
                let hits = source_map.get(&key).cloned().unwrap_or_default();
                let label = source_context::read_source_line(Path::new(&row.file), row.line);
                let label = label.trim().to_string();
                let text = if hits.is_empty() {
                    label
                } else {
                    format!("{label}  [{}]", hits.join(","))
                };
                let (ctx_lines, ctx_start) =
                    source_context::read_source_context(Path::new(&row.file), row.line, context);
                source_context::RefLine {
                    rel_path: row.rel_path.clone(),
                    line: row.line,
                    text,
                    context_lines: ctx_lines,
                    context_start: ctx_start,
                }
            })
            .collect();
        if refs.is_empty() {
            continue;
        }
        let (lines, groups) = source_context::dedup_ref_lines(&refs);
        total_groups += groups;
        content.push_str(&format!("# depth {depth_level}\n"));
        for line in &lines {
            content.push_str(line);
            content.push('\n');
        }
    }

    let mut meta: Vec<(&str, String)> = Vec::new();
    meta.push(("depth", depth.to_string()));
    if total_groups < merged.len() {
        meta.push(("groups", total_groups.to_string()));
    }
    meta.push(("total_callers", merged.len().to_string()));
    output::write_frontmatter(&meta, &content)?;

    Ok(())
}

pub fn run_trace(
    targets: &[String],
    depth: usize,
    limit: usize,
    kinds: &str,
    stdin: bool,
) -> anyhow::Result<()> {
    let cwd = std::env::current_dir()?;
    let targets = multisym::collect_symbols(targets, stdin)?;

    let kinds = parse_kinds(kinds);
    let mut merged: Vec<crate::store::TraceResult> = Vec::new();
    let mut source_map = std::collections::BTreeMap::<String, Vec<String>>::new();
    let mut seen = std::collections::BTreeMap::<String, usize>::new();

    for target in targets {
        for row in graph::find_trace(&cwd, strip_symbol_hint(&target), depth, limit, &kinds)? {
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
            if !hits.contains(&target) {
                hits.push(target.clone());
            }
        }
    }

    if merged.is_empty() {
        bail!("no outgoing calls found");
    }

    if output::structured_enabled() {
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
                    "reference_kind": row.kind,
                    "evidence": reference_evidence(&row.kind),
                    "confidence": reference_confidence(&row.kind),
                })
            })
            .collect::<Vec<_>>();
        return output::write_structured(&json!({
            "operation": "trace",
            "targets": source_map
                .values()
                .flatten()
                .cloned()
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect::<Vec<_>>(),
            "depth": depth,
            "limit": limit,
            "kinds": kinds.join(","),
            "result_count": results.len(),
            "results": results,
            "available": true,
            "read_only": true,
        }));
    }

    for row in merged {
        let key = format!("{}:{}|{}", row.file, row.line, row.callee);
        let hits = source_map.get(&key).cloned().unwrap_or_default();
        if hits.is_empty() {
            println!(
                "[{}] {} -> {} {}:{}",
                row.depth, row.caller, row.callee, row.rel_path, row.line
            );
        } else {
            println!(
                "[{}] {} -> {} {}:{} [{}]",
                row.depth,
                row.caller,
                row.callee,
                row.rel_path,
                row.line,
                hits.join(",")
            );
        }
    }

    Ok(())
}

pub struct ImplsArgs<'a> {
    pub targets: &'a [String],
    pub lang: Option<&'a str>,
    pub limit: usize,
    pub path_filters: &'a [String],
    pub excludes: &'a [String],
    pub of: Option<&'a str>,
    pub resolved: bool,
    pub unresolved: bool,
    pub stdin: bool,
}

pub fn run_impls(args: &ImplsArgs<'_>) -> anyhow::Result<()> {
    let ImplsArgs {
        targets,
        lang,
        limit,
        path_filters,
        excludes,
        of,
        resolved,
        unresolved,
        stdin,
    } = *args;
    let cwd = std::env::current_dir()?;
    let opts = impls::FindImplOptions {
        lang,
        limit,
        includes: path_filters,
        excludes,
        resolved_only: resolved,
        unresolved_only: unresolved,
    };
    if let Some(of) = of {
        if !targets.is_empty() || stdin {
            bail!("pass either positional symbols or --of <type>, not both");
        }
        let results = impls::find_implements(&cwd, of, &opts)?;
        if results.is_empty() {
            println!("No implements edges found for '{of}'.");
            return Ok(());
        }
        if output::structured_enabled() {
            let payload = json!({
                "direction": "implements",
                "target": of,
                "results": results,
            });
            return output::write_structured(&json!({
                "operation": "impls",
                "targets": targets,
                "of": of,
                "lang": lang,
                "limit": limit,
                "paths": path_filters,
                "excludes": excludes,
                "resolved": resolved,
                "unresolved": unresolved,
                "result_count": impls_result_count(&payload),
                "results": payload,
                "available": true,
                "read_only": true,
            }));
        }
        let mut content = String::new();
        for result in &results {
            let tag = if result.resolved { "" } else { " (external)" };
            content.push_str(&format!(
                "{} {}:{}{}\n",
                result.target, result.rel_path, result.line, tag
            ));
        }
        return output::render(
            &results,
            &[
                ("symbol", of.to_string()),
                ("direction", "implements (outgoing)".to_string()),
                ("edges", results.len().to_string()),
            ],
            &content,
        );
    }

    let targets = multisym::collect_symbols(targets, stdin)?;

    if output::structured_enabled() {
        let mut grouped = Vec::new();
        for target in &targets {
            let results = impls::find_implementors(&cwd, target, &opts)?;
            grouped.push(TargetResult {
                target: target.clone(),
                results,
            });
        }
        return output::write_structured(&json!({
            "operation": "impls",
            "targets": targets,
            "of": of,
            "lang": lang,
            "limit": limit,
            "paths": path_filters,
            "excludes": excludes,
            "resolved": resolved,
            "unresolved": unresolved,
            "result_count": nested_result_count(&grouped),
            "results": {
                "direction": "implementors",
                "results": grouped,
            },
            "available": true,
            "read_only": true,
        }));
    }

    for (index, target) in targets.iter().enumerate() {
        print!("{}", multisym::multi_symbol_header(target, index == 0));
        let results = impls::find_implementors(&cwd, target, &opts)?;
        if results.is_empty() {
            println!("No implementors found for '{target}'.");
            continue;
        }
        let mut content = String::new();
        for result in &results {
            let tag = if result.resolved { "" } else { " (external)" };
            content.push_str(&format!(
                "{} {}:{}{}\n",
                result.implementer, result.rel_path, result.line, tag
            ));
        }
        output::write_frontmatter(
            &[
                ("symbol", target.clone()),
                ("direction", "implementors (incoming)".to_string()),
                ("implementor_count", results.len().to_string()),
            ],
            &content,
        )?;
    }

    Ok(())
}

pub fn run_types(
    targets: &[String],
    limit: usize,
    path_filters: &[String],
    excludes: &[String],
) -> anyhow::Result<()> {
    if targets.is_empty() {
        bail!("types requires at least one target");
    }
    let cwd = std::env::current_dir()?;
    let store = crate::resolve::open_store(&cwd)?;
    let mut grouped = Vec::new();
    for target in targets {
        let resolved = crate::resolve::resolve_symbol(&cwd, target)?;
        let symbol = resolved.symbol;
        let mut types = Vec::new();
        for name in extract_type_names(&symbol.signature) {
            let mut definitions = store.search_symbols(&name, "", "", true, false, 0)?;
            definitions.retain(|definition| {
                is_type_kind(&definition.kind)
                    && crate::pathfilters::include_path(
                        Path::new(&definition.rel_path),
                        path_filters,
                        excludes,
                    )
            });
            if limit > 0 && definitions.len() > limit {
                definitions.truncate(limit);
            }
            types.push(json!({
                "name": name,
                "definitions": definitions,
            }));
        }
        grouped.push(json!({
            "target": target,
            "symbol": symbol,
            "types": types,
        }));
    }
    if output::structured_enabled() {
        return output::write_structured(&json!({
            "operation": "types",
            "targets": targets,
            "limit": limit,
            "paths": path_filters,
            "excludes": excludes,
            "result_count": grouped.len(),
            "results": grouped,
            "available": true,
            "read_only": true,
        }));
    }
    println!("types: {} target(s)", grouped.len());
    Ok(())
}

pub fn run_schema(targets: &[String], limit: usize) -> anyhow::Result<()> {
    if targets.is_empty() {
        bail!("schema requires at least one target");
    }
    let cwd = std::env::current_dir()?;
    let store = crate::resolve::open_store(&cwd)?;
    let mut rows = Vec::new();
    for target in targets {
        let mut matches = store.search_symbols(target, "", "", true, false, 0)?;
        matches.retain(|symbol| is_type_kind(&symbol.kind));
        if limit > 0 && matches.len() > limit {
            matches.truncate(limit);
        }
        for symbol in matches {
            let source = read_symbol_source(&symbol.file, symbol.start_line, symbol.end_line);
            let fields = extract_schema_fields(&symbol.language, &symbol.kind, &source);
            rows.push(json!({
                "target": target,
                "name": symbol.name,
                "kind": symbol.kind,
                "language": symbol.language,
                "file": symbol.file,
                "rel_path": symbol.rel_path,
                "line": symbol.start_line,
                "fields": fields,
            }));
        }
    }
    if output::structured_enabled() {
        return output::write_structured(&json!({
            "operation": "schema",
            "targets": targets,
            "limit": limit,
            "result_count": rows.len(),
            "results": rows,
            "available": true,
            "read_only": true,
        }));
    }
    println!("schema: {} type(s)", rows.len());
    Ok(())
}

pub fn run_tests(
    targets: &[String],
    limit: usize,
    path_filters: &[String],
    excludes: &[String],
) -> anyhow::Result<()> {
    if targets.is_empty() {
        bail!("tests requires at least one target");
    }
    let cwd = std::env::current_dir()?;
    let store = crate::resolve::open_store(&cwd)?;
    let mut grouped = Vec::new();
    for target in targets {
        let fetch_limit = crate::pathfilters::widen_path_filter_limit(
            limit,
            !path_filters.is_empty() || !excludes.is_empty(),
        )
        .max(1);
        let mut rows = Vec::new();
        for reference in store.find_references(strip_symbol_hint(target), fetch_limit, &[])? {
            let Some(test_symbol) = enclosing_test_symbol(&store, &reference.file, reference.line)?
            else {
                continue;
            };
            if !crate::pathfilters::include_path(
                Path::new(&reference.rel_path),
                path_filters,
                excludes,
            ) {
                continue;
            }
            rows.push(json!({
                "target": target,
                "test": test_symbol.name,
                "test_kind": test_symbol.kind,
                "file": reference.file,
                "rel_path": reference.rel_path,
                "line": reference.line,
                "reference": reference.name,
                "reference_kind": reference.kind,
                "heuristic": test_heuristic_reason(&test_symbol),
                "evidence": test_reference_evidence(&test_symbol, &reference.kind),
                "confidence": test_reference_confidence(&test_symbol, &reference.kind),
            }));
            if limit > 0 && rows.len() >= limit {
                break;
            }
        }
        grouped.push(json!({ "target": target, "results": rows }));
    }
    if output::structured_enabled() {
        return output::write_structured(&json!({
            "operation": "tests",
            "targets": targets,
            "limit": limit,
            "paths": path_filters,
            "excludes": excludes,
            "heuristics": test_heuristics(),
            "limitations": test_heuristic_limitations(),
            "result_count": nested_value_result_count(&grouped),
            "results": grouped,
            "available": true,
            "read_only": true,
        }));
    }
    println!("tests: {} result(s)", nested_value_result_count(&grouped));
    Ok(())
}

pub fn run_test_deps(
    target: &str,
    limit: usize,
    path_filters: &[String],
    excludes: &[String],
) -> anyhow::Result<()> {
    if target.trim().is_empty() {
        bail!("test-deps target cannot be empty");
    }
    let cwd = std::env::current_dir()?;
    let store = crate::resolve::open_store(&cwd)?;
    let resolved = match crate::resolve::resolve_symbol(&cwd, target) {
        Ok(resolved) => resolved,
        Err(error) => {
            let rows = virtual_test_dependencies(&store, target, limit, path_filters, excludes)?;
            if rows.is_empty() {
                return Err(error);
            }
            if output::structured_enabled() {
                return output::write_structured(&json!({
                    "operation": "test-deps",
                    "target": target,
                    "limit": limit,
                    "paths": path_filters,
                    "excludes": excludes,
                    "heuristics": test_heuristics(),
                    "limitations": test_heuristic_limitations(),
                    "symbol": {
                        "name": target,
                        "kind": "test",
                    },
                    "is_test": true,
                    "result_count": rows.len(),
                    "results": rows,
                    "available": true,
                    "read_only": true,
                }));
            }
            println!("test-deps: {} result(s)", rows.len());
            return Ok(());
        }
    };
    let test_symbol = resolved.symbol;
    let is_test = is_test_symbol(&test_symbol);
    let fetch_limit = crate::pathfilters::widen_path_filter_limit(
        limit,
        !path_filters.is_empty() || !excludes.is_empty(),
    )
    .max(1);
    let trace = graph::find_trace(
        &cwd,
        strip_symbol_hint(target),
        1,
        fetch_limit,
        &[crate::symbols::REF_KIND_CALL],
    )?;
    let mut rows = Vec::new();
    for edge in trace {
        let mut definitions = store.search_symbols(&edge.callee, "", "", true, false, 0)?;
        definitions.retain(|symbol| {
            is_production_symbol(symbol)
                && crate::pathfilters::include_path(
                    Path::new(&symbol.rel_path),
                    path_filters,
                    excludes,
                )
        });
        if definitions.is_empty() {
            continue;
        }
        rows.push(json!({
            "test": target,
            "dependency": edge.callee,
            "call_file": edge.file,
            "call_rel_path": edge.rel_path,
            "call_line": edge.line,
            "definitions": definitions,
            "evidence": parsed_call_evidence(),
            "confidence": "high",
        }));
        if limit > 0 && rows.len() >= limit {
            break;
        }
    }
    if output::structured_enabled() {
        return output::write_structured(&json!({
            "operation": "test-deps",
            "target": target,
            "limit": limit,
            "paths": path_filters,
            "excludes": excludes,
            "heuristics": test_heuristics(),
            "limitations": test_heuristic_limitations(),
            "symbol": test_symbol,
            "is_test": is_test,
            "result_count": rows.len(),
            "results": rows,
            "available": true,
            "read_only": true,
        }));
    }
    println!("test-deps: {} result(s)", rows.len());
    Ok(())
}

pub fn run_untested(
    limit: usize,
    lang: Option<&str>,
    path_filters: &[String],
    excludes: &[String],
) -> anyhow::Result<()> {
    let cwd = std::env::current_dir()?;
    let store = crate::resolve::open_store(&cwd)?;
    let references = store.all_references()?;
    let mut reference_counts = BTreeMap::<String, usize>::new();
    let mut test_reference_counts = BTreeMap::<String, usize>::new();
    for reference in &references {
        *reference_counts.entry(reference.name.clone()).or_default() += 1;
        if enclosing_test_symbol(&store, &reference.file, reference.line)?.is_some() {
            *test_reference_counts
                .entry(reference.name.clone())
                .or_default() += 1;
        }
    }

    let mut rows = Vec::new();
    for symbol in store.search_symbols("", "", lang.unwrap_or(""), false, false, 0)? {
        if !is_assessable_production_symbol(&symbol)
            || !crate::pathfilters::include_path(
                Path::new(&symbol.rel_path),
                path_filters,
                excludes,
            )
        {
            continue;
        }
        let reference_count = reference_counts.get(&symbol.name).copied().unwrap_or(0);
        let test_reference_count = test_reference_counts
            .get(&symbol.name)
            .copied()
            .unwrap_or(0);
        if test_reference_count > 0 {
            continue;
        }
        let rank = crate::untested::rank(&symbol, reference_count, test_reference_count);
        rows.push(json!({
            "symbol": symbol,
            "reference_count": reference_count,
            "test_reference_count": test_reference_count,
            "rank_score": rank.score,
            "rank_reason": rank.reason,
            "rank_inputs": {
                "exported": rank.exported,
                "reference_count": reference_count,
                "fan_in": reference_count,
                "test_reference_count": test_reference_count,
            },
            "rank_source": "cached_index_aggregates",
            "reason": "no indexed test references",
            "evidence": evidence(
                "no_indexed_test_reference",
                "medium",
                "negative test-reference scan over indexed refs",
            ),
            "confidence": "medium",
        }));
    }
    rows.sort_by(|a, b| {
        let a_score = a.get("rank_score").and_then(Value::as_i64).unwrap_or(0);
        let b_score = b.get("rank_score").and_then(Value::as_i64).unwrap_or(0);
        let a_refs = a
            .get("rank_inputs")
            .and_then(|inputs| inputs.get("reference_count"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let b_refs = b
            .get("rank_inputs")
            .and_then(|inputs| inputs.get("reference_count"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let a_exported = a
            .get("rank_inputs")
            .and_then(|inputs| inputs.get("exported"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let b_exported = b
            .get("rank_inputs")
            .and_then(|inputs| inputs.get("exported"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        b_score
            .cmp(&a_score)
            .then_with(|| b_exported.cmp(&a_exported))
            .then_with(|| b_refs.cmp(&a_refs))
            .then_with(|| {
                let a_name = a["symbol"]
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let b_name = b["symbol"]
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                a_name.cmp(b_name)
            })
    });
    if limit > 0 && rows.len() > limit {
        rows.truncate(limit);
    }
    if output::structured_enabled() {
        return output::write_structured(&json!({
            "operation": "untested",
            "limit": limit,
            "lang": lang,
            "paths": path_filters,
            "excludes": excludes,
            "heuristics": test_heuristics(),
            "limitations": test_heuristic_limitations(),
            "result_count": rows.len(),
            "results": rows,
            "available": true,
            "read_only": true,
        }));
    }
    println!("untested: {} result(s)", rows.len());
    Ok(())
}

pub fn run_context(targets: &[String], callers: usize, stdin: bool) -> anyhow::Result<()> {
    let cwd = std::env::current_dir()?;
    let targets = multisym::collect_symbols(targets, stdin)?;

    if output::structured_enabled() {
        let mut grouped = Vec::new();
        for target in targets {
            let result = context::symbol_context(&cwd, &target, callers)?;
            grouped.push(TargetResult {
                target,
                results: result,
            });
        }
        return output::write_structured(&grouped);
    }

    for (index, target) in targets.iter().enumerate() {
        print!("{}", multisym::multi_symbol_header(target, index == 0));
        let result = context::symbol_context(&cwd, target, callers)?;
        print!("# Source\n{}", result.source);

        if !result.callers.is_empty() {
            println!("\n# Callers ({})", result.callers.len());
            for caller in result.callers {
                println!("{}:{}", caller.rel_path, caller.line);
            }
        }
        if !result.implementors.is_empty() {
            println!("\n# Implementors ({})", result.implementors.len());
            for implementor in result.implementors {
                let tag = if implementor.resolved {
                    ""
                } else {
                    " (external)"
                };
                println!(
                    "{} {}:{}{}",
                    implementor.implementer, implementor.rel_path, implementor.line, tag
                );
            }
        }
        if !result.implements.is_empty() {
            println!("\n# Implements ({})", result.implements.len());
            for edge in result.implements {
                let tag = if edge.resolved { "" } else { " (external)" };
                println!("{} {}:{}{}", edge.target, edge.rel_path, edge.line, tag);
            }
        }
        if !result.file_imports.is_empty() {
            println!("\n# Imports");
            for import in result.file_imports {
                println!("{import}");
            }
        }
    }

    Ok(())
}

pub fn run_investigate(targets: &[String], stdin: bool) -> anyhow::Result<()> {
    let cwd = std::env::current_dir()?;
    let targets = multisym::collect_symbols(targets, stdin)?;

    if output::structured_enabled() {
        let mut grouped = Vec::new();
        for target in &targets {
            let result = investigate::investigate(&cwd, target)?;
            grouped.push(TargetResult {
                target: target.clone(),
                results: result,
            });
        }
        return output::write_structured(&json!({
            "operation": "investigate",
            "targets": targets,
            "result_count": grouped.len(),
            "results": grouped,
            "available": true,
            "read_only": true,
        }));
    }

    for (index, target) in targets.iter().enumerate() {
        print!("{}", multisym::multi_symbol_header(target, index == 0));
        let result = investigate::investigate(&cwd, target)?;
        print!("# Source\n{}", result.source);

        if !result.members.is_empty() {
            println!("\n# Members ({})", result.members.len());
            for member in result.members {
                if member.signature.is_empty() {
                    println!(
                        "{} {} {}:{}",
                        member.kind, member.name, member.rel_path, member.start_line
                    );
                } else {
                    println!(
                        "{} {} {} {}:{}",
                        member.kind,
                        member.name,
                        member.signature,
                        member.rel_path,
                        member.start_line
                    );
                }
            }
        }

        if !result.refs.is_empty() {
            let label = if result.kind == "function" {
                "Callers"
            } else {
                "References"
            };
            println!("\n# {label} ({})", result.refs.len());
            for reference in result.refs {
                println!("{}:{}", reference.rel_path, reference.line);
            }
        }

        if !result.impact.is_empty() {
            println!("\n# Impact (depth 2)");
            for edge in result.impact {
                println!(
                    "[{}] {} -> {} {}:{}",
                    edge.depth, edge.caller, edge.symbol, edge.rel_path, edge.line
                );
            }
        }

        if !result.implementors.is_empty() {
            println!("\n# Implementors ({})", result.implementors.len());
            for implementor in result.implementors {
                let tag = if implementor.resolved {
                    ""
                } else {
                    " (external)"
                };
                println!(
                    "{} {}:{}{}",
                    implementor.implementer, implementor.rel_path, implementor.line, tag
                );
            }
        }

        if !result.implements.is_empty() {
            println!("\n# Implements ({})", result.implements.len());
            for edge in result.implements {
                let tag = if edge.resolved { "" } else { " (external)" };
                println!("{} {}:{}{}", edge.target, edge.rel_path, edge.line, tag);
            }
        }
    }

    Ok(())
}

pub fn run_structure(limit: usize) -> anyhow::Result<()> {
    let cwd = std::env::current_dir()?;
    let result = structure::analyze(&cwd, limit)?;

    if output::structured_enabled() {
        return output::write_structured(&result);
    }

    println!(
        "--- {} ({} files, {} symbols) ---",
        result.repo_root, result.files, result.symbols
    );
    println!();

    if !result.entry_points.is_empty() {
        println!("Entry points:");
        for symbol in result.entry_points {
            println!(
                "  {} {} {}:{}",
                symbol.kind, symbol.name, symbol.rel_path, symbol.start_line
            );
        }
        println!();
    }

    if !result.top_by_refs.is_empty() {
        println!("Most referenced symbols:");
        for symbol in result.top_by_refs {
            println!(
                "  {} {} ({} refs) {}:{}",
                symbol.symbol.kind,
                symbol.symbol.name,
                symbol.count,
                symbol.symbol.rel_path,
                symbol.symbol.start_line
            );
        }
        println!();
    }

    if !result.top_packages.is_empty() {
        println!("Largest packages:");
        for package in result.top_packages {
            println!(
                "  {} {} symbols, {} files",
                package.path, package.symbols, package.files
            );
        }
        println!();
    }

    if !result.top_by_import_fan.is_empty() {
        println!("Most imported files:");
        for file in result.top_by_import_fan {
            println!("  {} imported by {} files", file.rel_path, file.count);
        }
    }

    Ok(())
}

pub fn run_diff(target: &str, base: &str, stat: bool) -> anyhow::Result<()> {
    let cwd = std::env::current_dir()?;
    let result = diff::symbol_diff(&cwd, target, base, stat)?;
    if output::structured_enabled() {
        return output::write_structured(&json!({
            "operation": "diff",
            "target": target,
            "base": base,
            "stat": stat,
            "result": result,
            "available": true,
            "read_only": true,
        }));
    }
    if result.content.is_empty() {
        eprintln!(
            "No diff for {} ({}:{}-{}) against {}",
            result.symbol.name,
            result.symbol.rel_path,
            result.symbol.start_line,
            result.symbol.end_line,
            result.base
        );
        return Ok(());
    }
    print!("{}", result.content);
    Ok(())
}

pub fn run_version() -> anyhow::Result<()> {
    if output::structured_enabled() {
        return output::write_structured(&version::display_version());
    }
    println!("{}", version::display_version());
    Ok(())
}

fn parse_kinds(raw: &str) -> Vec<&str> {
    raw.split(',')
        .map(|part| part.trim())
        .filter(|part| !part.is_empty())
        .collect()
}

fn nested_result_count<T: Serialize>(grouped: &[TargetResult<T>]) -> usize {
    grouped
        .iter()
        .filter_map(|group| serde_json::to_value(&group.results).ok())
        .filter_map(|value| value.as_array().map(Vec::len))
        .sum()
}

fn nested_value_result_count(grouped: &[Value]) -> usize {
    grouped
        .iter()
        .filter_map(|group| group.get("results").and_then(Value::as_array))
        .map(Vec::len)
        .sum()
}

fn impls_result_count(value: &Value) -> usize {
    if let Some(results) = value.get("results").and_then(Value::as_array) {
        if results.iter().all(|item| item.get("results").is_some()) {
            return nested_value_result_count(results);
        }
        return results.len();
    }
    0
}

fn source_hit_line(item: &Value) -> String {
    let rel = item
        .get("rel_path")
        .and_then(Value::as_str)
        .or_else(|| item.get("file").and_then(Value::as_str))
        .unwrap_or("?");
    let line = item
        .get("line")
        .or_else(|| item.get("start_line"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let primary = item
        .get("caller")
        .or_else(|| item.get("callee"))
        .or_else(|| item.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if primary.is_empty() {
        format!("{rel}:{line}")
    } else {
        format!("{rel}:{line} {primary}")
    }
}

fn is_type_kind(kind: &str) -> bool {
    matches!(
        kind,
        "class" | "struct" | "interface" | "trait" | "enum" | "protocol" | "type"
    )
}

fn is_assessable_symbol_kind(kind: &str) -> bool {
    matches!(kind, "function" | "method")
}

fn is_test_file(rel_path: &str, language: &str) -> bool {
    let normalized = rel_path.replace('\\', "/");
    let file_name = normalized.rsplit('/').next().unwrap_or(&normalized);
    let stem = file_name
        .rsplit_once('.')
        .map(|(stem, _)| stem)
        .unwrap_or(file_name);
    normalized
        .split('/')
        .any(|part| matches!(part, "test" | "tests" | "__tests__" | "spec"))
        || stem.starts_with("test_")
        || stem.ends_with("_test")
        || file_name.contains(".test.")
        || file_name.contains(".spec.")
        || (language == "rust" && normalized.starts_with("tests/"))
}

fn is_test_symbol_name(name: &str) -> bool {
    name.starts_with("test_")
        || name.ends_with("_test")
        || name.starts_with("it_")
        || name.starts_with("should_")
}

fn has_rust_test_attr(file: &str, start_line: usize) -> bool {
    let Ok(contents) = fs::read_to_string(file) else {
        return false;
    };
    let lines = contents.lines().collect::<Vec<_>>();
    if start_line == 0 || start_line > lines.len() {
        return false;
    }
    let start = start_line.saturating_sub(4).max(1);
    lines[start - 1..start_line - 1]
        .iter()
        .map(|line| line.trim())
        .any(|line| {
            line == "#[test]"
                || line.starts_with("#[tokio::test")
                || line.starts_with("#[async_std::test")
                || line.starts_with("#[rstest")
        })
}

fn is_test_symbol(symbol: &crate::store::SymbolResult) -> bool {
    is_test_file(&symbol.rel_path, &symbol.language)
        || is_test_symbol_name(&symbol.name)
        || (symbol.language == "rust" && has_rust_test_attr(&symbol.file, symbol.start_line))
}

fn is_production_symbol(symbol: &crate::store::SymbolResult) -> bool {
    !is_test_file(&symbol.rel_path, &symbol.language) && !is_test_symbol(symbol)
}

fn is_assessable_production_symbol(symbol: &crate::store::SymbolResult) -> bool {
    is_assessable_symbol_kind(&symbol.kind) && is_production_symbol(symbol)
}

fn enclosing_test_symbol(
    store: &crate::store::Store,
    file: &str,
    line: usize,
) -> anyhow::Result<Option<crate::store::SymbolResult>> {
    let file_record = store
        .all_files(None)?
        .into_iter()
        .find(|row| row.path == file);
    if let Some(file_record) = file_record.as_ref()
        && is_test_file(&file_record.rel_path, &file_record.language)
        && let Some((name, start_line)) = test_wrapper_name(file, line)
    {
        return Ok(Some(crate::store::SymbolResult {
            name,
            kind: "test".to_string(),
            parent: String::new(),
            language: file_record.language.clone(),
            rel_path: file_record.rel_path.clone(),
            file: file_record.path.clone(),
            start_line,
            end_line: line,
            depth: 0,
            signature: String::new(),
        }));
    }

    if let Some(symbol) = store.enclosing_symbol_detail(file, line)? {
        if is_test_symbol(&symbol) {
            return Ok(Some(symbol));
        }
        return Ok(None);
    }

    let outline = store.file_outline(Path::new(file))?;
    Ok(outline
        .into_iter()
        .find(|symbol| is_test_file(&symbol.rel_path, &symbol.language)))
}

fn test_heuristic_reason(symbol: &crate::store::SymbolResult) -> &'static str {
    if symbol.kind == "test" {
        "test-wrapper"
    } else if is_test_file(&symbol.rel_path, &symbol.language) {
        "test-file-path"
    } else if is_test_symbol_name(&symbol.name) {
        "test-symbol-name"
    } else if symbol.language == "rust" && has_rust_test_attr(&symbol.file, symbol.start_line) {
        "rust-test-attribute"
    } else {
        "unknown"
    }
}

fn test_evidence_kind(symbol: &crate::store::SymbolResult) -> &'static str {
    if symbol.kind == "test" {
        "test_wrapper_convention"
    } else if symbol.language == "rust" && has_rust_test_attr(&symbol.file, symbol.start_line) {
        "rust_test_attribute"
    } else if is_test_symbol_name(&symbol.name) {
        "test_symbol_convention"
    } else if is_test_file(&symbol.rel_path, &symbol.language) {
        "test_file_convention"
    } else {
        "unknown"
    }
}

fn test_heuristics() -> Vec<&'static str> {
    vec![
        "path components named test, tests, __tests__, or spec",
        "file stems starting with test_ or ending with _test",
        "file names containing .test. or .spec.",
        "symbol names starting with test_, it_, or should_, or ending with _test",
        "Rust #[test], #[tokio::test], #[async_std::test], and #[rstest] attributes",
        "Jest/Vitest describe, it, and test wrapper names in recognized test files",
    ]
}

fn test_heuristic_limitations() -> Vec<&'static str> {
    vec![
        "dynamic dispatch, macro-generated tests, and framework-specific decorators may be missed",
        "simple Rust macro invocation bodies are scanned for direct call syntax, not fully expanded",
        "coverage means an indexed test reference or call, not executed runtime coverage",
        "name/path conventions can produce false positives in non-test helpers",
    ]
}

fn evidence(kind: &str, confidence: &str, source: &str) -> Value {
    json!({
        "kind": kind,
        "confidence": confidence,
        "source": source,
    })
}

fn parsed_call_evidence() -> Value {
    evidence(
        "parsed_call_edge",
        "high",
        "tree-sitter reference extracted as call",
    )
}

fn import_path_evidence() -> Value {
    evidence(
        "import_path_match",
        "medium",
        "import path matched indexed target path",
    )
}

fn reference_evidence(kind: &str) -> Value {
    match kind {
        crate::symbols::REF_KIND_CALL => parsed_call_evidence(),
        crate::symbols::REF_KIND_IMPLEMENTS => evidence(
            "parsed_conformance_edge",
            "high",
            "tree-sitter reference extracted as implements",
        ),
        crate::symbols::REF_KIND_USE => evidence(
            "lexical_reference",
            "medium",
            "tree-sitter reference extracted as use",
        ),
        _ => evidence("unknown", "low", "unclassified indexed reference"),
    }
}

fn reference_confidence(kind: &str) -> &'static str {
    match kind {
        crate::symbols::REF_KIND_CALL | crate::symbols::REF_KIND_IMPLEMENTS => "high",
        crate::symbols::REF_KIND_USE => "medium",
        _ => "low",
    }
}

fn test_reference_evidence(symbol: &crate::store::SymbolResult, reference_kind: &str) -> Value {
    let mut value = reference_evidence(reference_kind);
    if let Some(object) = value.as_object_mut() {
        object.insert(
            "test_classifier".to_string(),
            json!(test_evidence_kind(symbol)),
        );
    }
    value
}

fn test_reference_confidence(
    symbol: &crate::store::SymbolResult,
    reference_kind: &str,
) -> &'static str {
    match (test_evidence_kind(symbol), reference_kind) {
        ("rust_test_attribute", crate::symbols::REF_KIND_CALL) => "high",
        ("test_symbol_convention", crate::symbols::REF_KIND_CALL) => "high",
        ("test_file_convention", crate::symbols::REF_KIND_CALL) => "medium",
        ("test_wrapper_convention", crate::symbols::REF_KIND_CALL) => "medium",
        _ => reference_confidence(reference_kind),
    }
}

fn test_wrapper_name(file: &str, line: usize) -> Option<(String, usize)> {
    let contents = fs::read_to_string(file).ok()?;
    let lines = contents.lines().collect::<Vec<_>>();
    let end = line.min(lines.len());
    for index in (0..end).rev() {
        if let Some(wrapper) = test_wrapper_name_at(lines[index], index + 1) {
            return Some(wrapper);
        }
    }
    None
}

fn test_wrapper_name_at(line: &str, line_no: usize) -> Option<(String, usize)> {
    let trimmed = line.trim_start();
    for prefix in ["it", "test", "describe"] {
        let Some(rest) = trimmed.strip_prefix(prefix) else {
            continue;
        };
        if !rest.trim_start().starts_with('(') {
            continue;
        }
        if let Some(label) = first_quoted_argument(rest) {
            return Some((format!("{prefix}:{label}"), line_no));
        }
    }
    None
}

fn first_quoted_argument(value: &str) -> Option<String> {
    let mut chars = value.chars();
    let quote = chars.find(|ch| *ch == '\'' || *ch == '"')?;
    let mut label = String::new();
    for ch in chars {
        if ch == quote {
            return Some(label);
        }
        label.push(ch);
    }
    None
}

fn virtual_test_dependencies(
    store: &crate::store::Store,
    target: &str,
    limit: usize,
    path_filters: &[String],
    excludes: &[String],
) -> anyhow::Result<Vec<Value>> {
    let mut symbols = store.search_symbols("", "", "", false, false, 0)?;
    symbols.retain(|symbol| {
        is_assessable_production_symbol(symbol)
            && crate::pathfilters::include_path(Path::new(&symbol.rel_path), path_filters, excludes)
    });
    let mut rows = Vec::new();
    let mut seen = BTreeSet::new();
    for file in store.all_files(None)? {
        if !is_test_file(&file.rel_path, &file.language) {
            continue;
        }
        let Ok(contents) = fs::read_to_string(&file.path) else {
            continue;
        };
        let lines = contents.lines().collect::<Vec<_>>();
        for (index, line) in lines.iter().enumerate() {
            let Some((name, _)) = test_wrapper_name_at(line, index + 1) else {
                continue;
            };
            if name != target {
                continue;
            }
            let block = test_wrapper_block(&lines, index);
            for symbol in &symbols {
                if !block.contains(&format!("{}(", symbol.name)) {
                    continue;
                }
                let key = format!("{}:{}", file.path, symbol.name);
                if !seen.insert(key) {
                    continue;
                }
                rows.push(json!({
                    "test": target,
                    "dependency": symbol.name,
                    "call_file": file.path,
                    "call_rel_path": file.rel_path,
                    "call_line": index + 1,
                    "definitions": [symbol],
                    "evidence": evidence(
                        "test_wrapper_convention",
                        "medium",
                        "Jest/Vitest wrapper body lexical scan",
                    ),
                    "confidence": "medium",
                }));
                if limit > 0 && rows.len() >= limit {
                    return Ok(rows);
                }
            }
        }
    }
    Ok(rows)
}

fn test_wrapper_block(lines: &[&str], start: usize) -> String {
    let mut block = String::new();
    for line in &lines[start..] {
        block.push_str(line);
        block.push('\n');
        let trimmed = line.trim();
        if trimmed == "});" || trimmed == "})" || trimmed == "});;" {
            break;
        }
    }
    block
}

fn extract_type_names(signature: &str) -> Vec<String> {
    const EXCLUDED: &[&str] = &[
        "Self", "self", "str", "String", "bool", "char", "usize", "isize", "u8", "u16", "u32",
        "u64", "u128", "i8", "i16", "i32", "i64", "i128", "f32", "f64", "Option", "Result", "Vec",
        "Box", "HashMap", "BTreeMap", "HashSet", "BTreeSet",
    ];
    let mut names = BTreeSet::new();
    let mut current = String::new();
    for ch in signature.chars().chain(std::iter::once(' ')) {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == ':' {
            current.push(ch);
            continue;
        }
        let token = current.trim_matches(':');
        if !token.is_empty() {
            let name = token.rsplit("::").next().unwrap_or(token);
            if name
                .chars()
                .next()
                .is_some_and(|first| first.is_ascii_uppercase())
                && !EXCLUDED.contains(&name)
            {
                names.insert(name.to_string());
            }
        }
        current.clear();
    }
    names.into_iter().collect()
}

fn read_symbol_source(file: &str, start_line: usize, end_line: usize) -> String {
    let Ok(contents) = fs::read_to_string(file) else {
        return String::new();
    };
    contents
        .lines()
        .enumerate()
        .filter_map(|(index, line)| {
            let line_no = index + 1;
            (line_no >= start_line && line_no <= end_line).then_some(line)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn extract_schema_fields(language: &str, kind: &str, source: &str) -> Vec<Value> {
    match language {
        "rust" if kind == "struct" => extract_rust_struct_fields(source),
        "python" if kind == "class" => extract_python_init_fields(source),
        _ => Vec::new(),
    }
}

fn extract_rust_struct_fields(source: &str) -> Vec<Value> {
    let Some(start) = source.find('{') else {
        return Vec::new();
    };
    let Some(end) = source.rfind('}') else {
        return Vec::new();
    };
    if end <= start {
        return Vec::new();
    }
    source[start + 1..end]
        .split(',')
        .filter_map(|field| {
            let field = field.trim();
            let (name, ty) = field.split_once(':')?;
            let name = name
                .split_whitespace()
                .rfind(|part| *part != "pub")
                .unwrap_or("")
                .trim();
            let ty = ty.trim();
            if name.is_empty() || ty.is_empty() {
                return None;
            }
            Some(json!({ "name": name, "type": ty }))
        })
        .collect()
}

fn extract_python_init_fields(source: &str) -> Vec<Value> {
    let mut annotations = BTreeMap::new();
    for line in source.lines().map(str::trim) {
        if !line.starts_with("def __init__") {
            continue;
        }
        let Some(start) = line.find('(') else {
            continue;
        };
        let Some(end) = line[start + 1..].find(')') else {
            continue;
        };
        let params = &line[start + 1..start + 1 + end];
        for param in params.split(',').map(str::trim) {
            let Some((name, ty)) = param.split_once(':') else {
                continue;
            };
            let name = name.trim();
            if name == "self" || name.is_empty() {
                continue;
            }
            annotations.insert(
                name.to_string(),
                ty.split('=').next().unwrap_or("").trim().to_string(),
            );
        }
    }

    let mut fields = Vec::new();
    let mut seen = BTreeSet::new();
    for line in source.lines().map(str::trim) {
        let Some(rest) = line.strip_prefix("self.") else {
            continue;
        };
        let Some((name, _)) = rest.split_once('=') else {
            continue;
        };
        let name = name.trim();
        if name.is_empty() || !seen.insert(name.to_string()) {
            continue;
        }
        let ty = annotations
            .get(name)
            .filter(|ty| !ty.is_empty())
            .map(String::as_str)
            .unwrap_or("unknown");
        fields.push(json!({ "name": name, "type": ty }));
    }
    fields
}

fn strip_symbol_hint(target: &str) -> &str {
    let Some((prefix, symbol)) = target.rsplit_once(':') else {
        return target;
    };
    if looks_like_plain_file(prefix) || prefix.contains('/') || prefix.contains('\\') {
        symbol
    } else {
        target
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
    target.contains('/') || crate::lang::language_for_file(Path::new(target)).is_some()
}

fn is_line_range(value: &str) -> bool {
    let Some((start, end)) = value.split_once('-') else {
        return false;
    };
    start.trim_start_matches('L').parse::<usize>().is_ok()
        && end.trim_start_matches('L').parse::<usize>().is_ok()
}
