pub mod cli;
pub mod context;
pub mod diff;
pub mod graph;
pub mod impls;
pub mod indexer;
pub mod investigate;
pub mod lang;
pub mod ls;
pub mod multisym;
pub mod outline;
pub mod output;
pub mod parser;
pub mod pathfilters;
pub mod repo;
pub mod resolve;
pub mod search;
pub mod show;
pub mod source_context;
pub mod store;
pub mod structure;
pub mod symbols;
pub mod untested;
pub mod version;
pub mod walker;

pub fn run(args: cli::SymArgs) -> anyhow::Result<()> {
    output::set_format(args.format.unwrap_or_else(output::default_format).into());

    if let Some(db) = &args.db {
        // CLI entrypoint runs before any parallel work begins, so this process-wide
        // override is safe and gives --db precedence over inherited SYM_DB.
        unsafe {
            std::env::set_var("SYM_DB", db);
        }
    }

    match args.command {
        cli::Command::Index {
            path,
            workers: _,
            force,
            reset,
            ignore,
        } => cli::run_index(&path, force, reset, &ignore),
        cli::Command::Search {
            query,
            text,
            limit,
            kind,
            lang,
            exact,
            ignore_case,
            path_filters,
            excludes,
        } => cli::run_search(&cli::SearchArgs {
            query: &query,
            text,
            limit,
            kind: kind.as_deref(),
            lang: lang.as_deref(),
            exact,
            ignore_case,
            path_filters: &path_filters,
            excludes: &excludes,
        }),
        cli::Command::Stats => cli::run_stats(),
        cli::Command::Map { level, limit } => cli::run_map(level, limit),
        cli::Command::Query {
            query,
            limit,
            kind,
            lang,
            exact,
            path_filters,
            excludes,
        } => cli::run_query(&cli::QueryArgs {
            query: &query,
            limit,
            kind: kind.as_deref(),
            lang: lang.as_deref(),
            exact,
            path_filters: &path_filters,
            excludes: &excludes,
        }),
        cli::Command::Inspect {
            file,
            signatures,
            names,
        } => cli::run_inspect(&file, signatures, names),
        cli::Command::Outline {
            file,
            signatures,
            names,
        } => cli::run_outline(&file, signatures, names),
        cli::Command::Show {
            targets,
            context,
            all,
            stdin,
        } => cli::run_show(&targets, context, all, stdin),
        cli::Command::Ls {
            path,
            repos,
            stats,
            depth,
        } => cli::run_ls(path.as_deref(), repos, stats, depth),
        cli::Command::Refs {
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
        } => cli::run_refs(&cli::RefsArgs {
            targets: &targets,
            importers,
            impact,
            depth,
            limit,
            context,
            path_filters: &path_filters,
            excludes: &excludes,
            file: file.as_deref(),
            stdin,
        }),
        cli::Command::Importers {
            target,
            depth,
            limit,
        } => cli::run_importers(&target, depth, limit),
        cli::Command::Callers {
            targets,
            limit,
            context,
            path_filters,
            excludes,
        } => cli::run_callers(&targets, limit, context, &path_filters, &excludes),
        cli::Command::Callees {
            targets,
            limit,
            path_filters,
            excludes,
        } => cli::run_callees(&targets, limit, &path_filters, &excludes),
        cli::Command::Impact {
            targets,
            depth,
            limit,
            context,
            stdin,
        } => cli::run_impact(&targets, depth, limit, context, stdin),
        cli::Command::Trace {
            targets,
            depth,
            limit,
            kinds,
            stdin,
        } => cli::run_trace(&targets, depth, limit, &kinds, stdin),
        cli::Command::Impls {
            targets,
            lang,
            limit,
            path_filters,
            excludes,
            of,
            resolved,
            unresolved,
            stdin,
        } => cli::run_impls(&cli::ImplsArgs {
            targets: &targets,
            lang: lang.as_deref(),
            limit,
            path_filters: &path_filters,
            excludes: &excludes,
            of: of.as_deref(),
            resolved,
            unresolved,
            stdin,
        }),
        cli::Command::Types {
            targets,
            limit,
            path_filters,
            excludes,
        } => cli::run_types(&targets, limit, &path_filters, &excludes),
        cli::Command::Schema { targets, limit } => cli::run_schema(&targets, limit),
        cli::Command::Tests {
            targets,
            limit,
            path_filters,
            excludes,
        } => cli::run_tests(&targets, limit, &path_filters, &excludes),
        cli::Command::TestDeps {
            target,
            limit,
            path_filters,
            excludes,
        } => cli::run_test_deps(&target, limit, &path_filters, &excludes),
        cli::Command::Untested {
            limit,
            lang,
            path_filters,
            excludes,
        } => cli::run_untested(limit, lang.as_deref(), &path_filters, &excludes),
        cli::Command::Context {
            targets,
            callers,
            stdin,
        } => cli::run_context(&targets, callers, stdin),
        cli::Command::Investigate { targets, stdin } => cli::run_investigate(&targets, stdin),
        cli::Command::Structure { limit } => cli::run_structure(limit),
        cli::Command::Diff { target, base, stat } => cli::run_diff(&target, &base, stat),
        cli::Command::Version => cli::run_version(),
    }
}
