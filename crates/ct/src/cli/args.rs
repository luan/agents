use std::path::PathBuf;

use clap::ValueEnum;
use clap::{Args, Subcommand};
use clap_complete::Shell;

use crate::artifact::ArtifactKind;

/// Parse a `-t` argument into an optional kind. `"all"` (the default) yields
/// `None`, signalling cross-kind operation. `"doc"` is accepted as an alias
/// for the on-disk `docs/` directory.
pub fn parse_kind_filter(s: &str) -> Option<ArtifactKind> {
    match s {
        "all" => None,
        "doc" => Some(ArtifactKind::Doc),
        _ => ArtifactKind::from_dir_name(s),
    }
}

const KIND_VALUES: [&str; 6] = ["all", "spec", "plan", "review", "report", "doc"];
const KIND_VALUES_NO_ALL: [&str; 5] = ["spec", "plan", "review", "report", "doc"];

#[derive(Args)]
pub struct ApplyPatchArgs {
    #[command(subcommand)]
    pub action: Option<ApplyPatchAction>,

    #[arg(long, help = "Working directory for raw apply; default: process cwd")]
    pub cwd: Option<String>,

    #[arg(long, help = "Preview raw apply without writing to disk")]
    pub dry_run: bool,
}

#[derive(Subcommand)]
pub enum ApplyPatchAction {
    #[command(about = "Show apply_patch telemetry summary")]
    Stats {
        #[arg(long, help = "Walk all project databases")]
        all_projects: bool,

        #[arg(long, default_value_t = 30, help = "Window in days")]
        days: i64,
    },

    #[command(about = "Render apply_patch failure diagnostic report")]
    Report {
        diagnostic_id: Option<String>,
        #[arg(long, default_value_t = 20, help = "Maximum diagnostics to show")]
        limit: usize,
        #[arg(long, help = "Output JSON")]
        json: bool,
    },

    #[command(about = "Show one apply_patch failure diagnostic")]
    Show {
        diagnostic_id: String,
        #[arg(long, help = "Output JSON")]
        json: bool,
    },

    #[command(about = "Delete telemetry older than --days")]
    Prune {
        #[arg(long, default_value_t = 90, help = "Retention window in days")]
        days: i64,
    },

    #[command(about = "Validate and describe an apply_patch payload from stdin as JSON")]
    Preview {
        #[arg(long, help = "Working directory; default: process cwd")]
        cwd: Option<String>,
        #[arg(long, help = "Accept an incomplete envelope by appending End Patch")]
        partial: bool,
        #[arg(long, help = "Read JSONL preview requests from stdin until EOF")]
        watch: bool,
        #[arg(long, help = "Use JSON Lines protocol for --watch")]
        jsonl: bool,
    },

    #[command(about = "Manage retained apply_patch drafts")]
    Draft {
        #[command(subcommand)]
        action: ApplyPatchDraftAction,
    },
}

#[derive(Subcommand)]
pub enum ApplyPatchDraftAction {
    #[command(about = "Create an apply_patch draft from stdin")]
    Create {
        #[arg(long, help = "Working directory")]
        cwd: Option<String>,
        #[arg(long, help = "Output JSON")]
        json: bool,
    },
    #[command(about = "Show apply_patch draft status")]
    Status {
        patch_id: String,
        #[arg(long, help = "Output JSON")]
        json: bool,
    },
    #[command(about = "Show an apply_patch draft or chunk")]
    Show {
        patch_id: String,
        #[arg(long, help = "Chunk index")]
        chunk: Option<usize>,
        #[arg(long, help = "Output JSON")]
        json: bool,
    },
    #[command(about = "Amend an apply_patch draft chunk")]
    Amend {
        patch_id: String,
        #[arg(long, help = "Chunk index")]
        chunk: usize,
        #[arg(long, help = "Replacement anchor")]
        anchor: Option<String>,
        #[arg(long, help = "Output JSON")]
        json: bool,
    },
    #[command(about = "Apply an apply_patch draft atomically")]
    Apply {
        patch_id: String,
        #[arg(long, help = "Output JSON")]
        json: bool,
    },
    #[command(about = "Discard an apply_patch draft")]
    Discard {
        patch_id: String,
        #[arg(long, help = "Output JSON")]
        json: bool,
    },
}

#[derive(Subcommand)]
pub enum RepoAction {
    #[command(about = "Print detected project identity")]
    Project,

    #[command(about = "Gather branch context: diff, log, and files")]
    Context {
        #[arg(long, default_value = "main", help = "Base branch for comparison")]
        base: String,
        #[arg(long, default_value = "text", value_parser = ["text", "json"], help = "Output format")]
        format: String,
        #[arg(
            long,
            default_value_t = 3000,
            help = "Max total diff lines before truncation"
        )]
        max_total: usize,
        #[arg(long, default_value_t = 200, help = "Per-file diff line threshold")]
        max_file: usize,
        #[arg(long, help = "Output diff --stat instead of full diff")]
        stat: bool,
        #[arg(long, help = "Include co-change candidates in output")]
        cochanges: bool,
    },

    #[command(about = "Check doc references against project filesystem")]
    CheckRefs {
        #[arg(help = "Doc file path or stem")]
        file: String,
        #[arg(
            long,
            help = "Project root path (default: git rev-parse --show-toplevel)"
        )]
        project_root: Option<String>,
    },

    #[command(about = "Find files frequently changed together with current changes")]
    Cochanges {
        #[arg(
            long,
            default_value = "main",
            help = "Base branch/ref for changed-file detection"
        )]
        base: String,
        #[arg(long, default_value_t = 0.3, help = "Min co-change fraction 0.0-1.0")]
        threshold: f64,
        #[arg(long, default_value_t = 5, help = "Min commits a file must appear in")]
        min_commits: usize,
        #[arg(
            long,
            default_value = "20",
            help = "Max output files (integer or 'all')"
        )]
        max_files: String,
        #[arg(
            long,
            default_value_t = 10000,
            help = "How many recent commits to analyze"
        )]
        num_commits: usize,
    },

    #[command(about = "Report per-module LOC and recent git churn")]
    Churn {
        #[arg(
            long,
            help = "Project root path (default: git rev-parse --show-toplevel)"
        )]
        project_root: Option<String>,
        #[arg(
            long,
            default_value = "2w",
            help = "Git log time window (e.g. 2w, 30d, 3m)"
        )]
        since: String,
        #[arg(long, default_value_t = 0, help = "Minimum LOC to include in output")]
        min_loc: usize,
    },
}

#[derive(Subcommand)]
pub enum ShellAction {
    #[command(about = "Generate shell completion scripts")]
    Completion {
        #[arg(help = "Shell type (bash, zsh, fish, powershell, elvish)")]
        shell: Shell,
    },
}

#[derive(Subcommand)]
pub enum TuiAction {
    #[command(about = "Render subscription usage bars from JSON on stdin")]
    UsageBar {
        #[arg(long, default_value_t = 80, help = "Terminal width in cells")]
        width: usize,
    },
    #[command(about = "Render subscription usage bars for all local providers")]
    UsageBars {
        #[arg(long, default_value_t = 80, help = "Terminal width in cells")]
        width: usize,
        #[arg(long, help = "Render the tmux mux-sidebar layout")]
        sidebar: bool,
    },
}

#[derive(Subcommand)]
pub enum DevAction {
    #[command(about = "Generate URL-safe slug from text")]
    Slug {
        #[arg(
            help = "Words to slugify",
            trailing_var_arg = true,
            allow_hyphen_values = true
        )]
        words: Vec<String>,
    },

    #[command(about = "Parse phase markers from plan file")]
    Phases {
        #[arg(help = "Plan file to parse (or stdin if omitted)")]
        file: Option<String>,
    },

    #[command(about = "Raw backend/debug helpers")]
    Debug {
        #[command(subcommand)]
        action: DevDebugAction,
    },
}

#[derive(Subcommand)]
pub enum DevDebugAction {
    #[command(about = "Raw symbol backend CLI")]
    Sym(sym::cli::SymArgs),

    #[command(about = "Raw AST backend CLI")]
    Ast {
        #[command(subcommand)]
        action: AstAction,
    },

    #[command(about = "Raw LSP backend CLI")]
    Lsp {
        #[command(subcommand)]
        action: LspAction,
    },
}

#[derive(Subcommand)]
pub enum McpAction {
    #[command(hide = true, about = "Serve the apply_patch MCP over stdio")]
    ApplyPatch,

    #[command(hide = true, about = "Serve the sym MCP over stdio")]
    Sym,

    #[command(hide = true, about = "Serve the ast MCP over stdio")]
    Ast,

    #[command(about = "Serve the lens MCP over stdio")]
    Lens,

    #[command(hide = true, about = "Serve the lsp MCP over stdio")]
    Lsp,
}

#[derive(Subcommand)]
pub enum SourceAction {
    #[command(about = "Search source by symbol, text, path, or structural pattern")]
    Search {
        #[arg(help = "Search query; structural mode may use --pattern instead")]
        query: Vec<String>,
        #[arg(long, value_enum, default_value_t = SourceSearchMode::Symbol)]
        mode: SourceSearchMode,
        #[arg(short = 'n', long, default_value_t = 20, help = "Maximum results")]
        limit: usize,
        #[arg(short = 'k', long, help = "Symbol kind filter for symbol mode")]
        kind: Option<String>,
        #[arg(
            short = 'l',
            long,
            help = "Language filter; required for structural mode"
        )]
        lang: Option<String>,
        #[arg(short = 'e', long, help = "Require exact matching where supported")]
        exact: bool,
        #[arg(
            short = 'i',
            long = "ignore-case",
            help = "Case-insensitive symbol matching"
        )]
        ignore_case: bool,
        #[arg(long = "path", help = "Include path/glob filters")]
        paths: Vec<String>,
        #[arg(long = "exclude", help = "Exclude path/glob filters")]
        excludes: Vec<String>,
        #[arg(long, help = "Structural AST pattern; defaults to query text")]
        pattern: Option<String>,
        #[arg(long, help = "ast-grep selector for structural mode")]
        selector: Option<String>,
        #[arg(long, help = "Context lines for structural matches")]
        context: Option<usize>,
        #[arg(long, help = "Include ignored files where the backend supports it")]
        include_ignored: bool,
        #[arg(long, help = "Output JSON")]
        json: bool,
        #[arg(long, help = "Override sym database path for symbol mode")]
        db: Option<String>,
    },

    #[command(about = "Resolve symbols to structured source metadata")]
    Show {
        #[arg(help = "Symbols to resolve; use file:symbol for file hints")]
        targets: Vec<String>,
        #[arg(
            long,
            help = "Return every definition when a symbol target is ambiguous"
        )]
        all: bool,
        #[arg(long, help = "Output JSON")]
        json: bool,
        #[arg(long, help = "Override sym database path for symbol resolution")]
        db: Option<String>,
    },

    #[command(about = "Outline symbols defined in a file")]
    Outline {
        #[arg(help = "File to outline")]
        file: PathBuf,
        #[arg(short = 's', long, help = "Include signatures in text renderers")]
        signatures: bool,
        #[arg(long, help = "Return only unique symbol names")]
        names: bool,
        #[arg(long, help = "Output JSON")]
        json: bool,
        #[arg(long, help = "Override sym database path for symbol resolution")]
        db: Option<String>,
    },

    #[command(about = "Find references to symbols")]
    Refs {
        #[arg(help = "Symbols to find references for")]
        targets: Vec<String>,
        #[arg(long, help = "Also include files importing the defining file")]
        importers: bool,
        #[arg(long, help = "Route to transitive impact analysis")]
        impact: bool,
        #[arg(
            short = 'D',
            long = "depth",
            default_value_t = 1,
            help = "Reference/importer depth"
        )]
        depth: usize,
        #[arg(short = 'n', long, default_value_t = 20, help = "Maximum results")]
        limit: usize,
        #[arg(
            short = 'C',
            long = "context",
            default_value_t = 1,
            help = "Context lines around references"
        )]
        context: usize,
        #[arg(long = "path", help = "Include path/glob filters")]
        paths: Vec<String>,
        #[arg(long = "exclude", help = "Exclude path/glob filters")]
        excludes: Vec<String>,
        #[arg(long, help = "Limit references to paths containing this fragment")]
        file: Option<String>,
        #[arg(long, help = "Output JSON")]
        json: bool,
        #[arg(long, help = "Override sym database path for symbol resolution")]
        db: Option<String>,
    },

    #[command(about = "Find transitive callers/dependents of symbols")]
    Impact {
        #[arg(help = "Symbols to analyze")]
        targets: Vec<String>,
        #[arg(
            short = 'D',
            long = "depth",
            default_value_t = 2,
            help = "Traversal depth"
        )]
        depth: usize,
        #[arg(short = 'n', long, default_value_t = 50, help = "Maximum results")]
        limit: usize,
        #[arg(
            short = 'C',
            long = "context",
            default_value_t = 1,
            help = "Context lines around hits"
        )]
        context: usize,
        #[arg(long, help = "Output JSON")]
        json: bool,
        #[arg(long, help = "Override sym database path for symbol resolution")]
        db: Option<String>,
    },

    #[command(about = "Follow the call graph downward from symbols")]
    Trace {
        #[arg(help = "Symbols to trace")]
        targets: Vec<String>,
        #[arg(long, default_value_t = 3, help = "Traversal depth")]
        depth: usize,
        #[arg(short = 'n', long, default_value_t = 50, help = "Maximum results")]
        limit: usize,
        #[arg(
            long,
            default_value = "call",
            help = "Trace edge kinds, e.g. call or call,use"
        )]
        kinds: String,
        #[arg(long, help = "Output JSON")]
        json: bool,
        #[arg(long, help = "Override sym database path for symbol resolution")]
        db: Option<String>,
    },

    #[command(about = "Find types that implement a symbol or what a type implements")]
    Impls {
        #[arg(help = "Symbols to find implementations/conformances for")]
        targets: Vec<String>,
        #[arg(short = 'l', long, help = "Language filter")]
        lang: Option<String>,
        #[arg(short = 'n', long, default_value_t = 50, help = "Maximum results")]
        limit: usize,
        #[arg(long = "path", help = "Include path/glob filters")]
        paths: Vec<String>,
        #[arg(long = "exclude", help = "Exclude path/glob filters")]
        excludes: Vec<String>,
        #[arg(
            long = "of",
            help = "Find protocols/interfaces implemented by this symbol"
        )]
        of: Option<String>,
        #[arg(long, help = "Only include resolved implementation targets")]
        resolved: bool,
        #[arg(long, help = "Only include unresolved implementation targets")]
        unresolved: bool,
        #[arg(long, help = "Output JSON")]
        json: bool,
        #[arg(long, help = "Override sym database path for symbol resolution")]
        db: Option<String>,
    },

    #[command(about = "Kind-adaptive investigation for symbols")]
    Investigate {
        #[arg(help = "Symbols to investigate")]
        targets: Vec<String>,
        #[arg(long, help = "Output JSON")]
        json: bool,
        #[arg(long, help = "Override sym database path for symbol resolution")]
        db: Option<String>,
    },

    #[command(about = "Show git diff scoped to a symbol's definition")]
    Diff {
        #[arg(help = "Symbol whose definition-scoped diff should be shown")]
        target: String,
        #[arg(default_value = "HEAD", help = "Base ref")]
        base: String,
        #[arg(long, help = "Return diffstat instead of full diff")]
        stat: bool,
        #[arg(long, help = "Output JSON")]
        json: bool,
        #[arg(long, help = "Override sym database path for symbol resolution")]
        db: Option<String>,
    },
}

#[derive(Copy, Clone, Debug, Eq, PartialEq, ValueEnum)]
pub enum SourceSearchMode {
    Symbol,
    Text,
    Path,
    Structural,
}

#[derive(Subcommand)]
pub enum AstAction {
    #[command(about = "Search code using AST-aware patterns")]
    Search {
        #[arg(long, help = "AST pattern to search for")]
        pattern: String,
        #[arg(long, help = "Target language")]
        lang: String,
        #[arg(long = "path", help = "Paths/globs to search")]
        paths: Vec<String>,
        #[arg(long, help = "Output JSON")]
        json: bool,
        #[arg(long, help = "Extract this selector")]
        selector: Option<String>,
        #[arg(long, help = "Context lines around matches")]
        context: Option<usize>,
        #[arg(long, help = "Include ignored files explicitly")]
        include_ignored: bool,
    },

    #[command(about = "Replace code using AST-aware patterns")]
    Replace {
        #[arg(long, help = "AST pattern to match")]
        pattern: String,
        #[arg(long, help = "Replacement using metavariables")]
        rewrite: String,
        #[arg(long, help = "Target language")]
        lang: String,
        #[arg(long = "path", help = "Paths/globs to search")]
        paths: Vec<String>,
        #[arg(long, help = "Output JSON")]
        json: bool,
        #[arg(long, help = "Apply changes; default is dry-run")]
        apply: bool,
        #[arg(long, help = "Include ignored files explicitly")]
        include_ignored: bool,
    },
}

#[derive(Subcommand)]
pub enum LspAction {
    #[command(about = "Run an LSP navigation request")]
    Request {
        #[arg(long, help = "Operation name")]
        operation: String,
        #[arg(long, help = "File path")]
        file_path: Option<String>,
        #[arg(long, help = "1-based line")]
        line: Option<usize>,
        #[arg(long, help = "1-based character")]
        character: Option<usize>,
        #[arg(long, help = "Output JSON")]
        json: bool,
        #[arg(long, help = "Workspace symbol query")]
        query: Option<String>,
        #[arg(long, help = "New symbol name for rename")]
        new_name: Option<String>,
    },

    #[command(about = "Collect LSP diagnostics")]
    Diagnostics {
        #[arg(long, help = "Optional file path")]
        file_path: Option<String>,
        #[arg(long, help = "Output JSON")]
        json: bool,
    },
}

#[derive(Subcommand)]
pub enum LensAction {
    #[command(about = "Show lens state status")]
    Status {
        #[arg(long, help = "Working directory")]
        cwd: Option<String>,
        #[arg(long, help = "Output JSON")]
        json: bool,
        #[arg(long, help = "Include disk usage")]
        disk: bool,
        #[arg(long, help = "Include resolver/debug fields in JSON")]
        debug: bool,
        #[arg(long, help = "Include raw backend fields in JSON")]
        raw: bool,
    },

    #[command(about = "Inspect lens diagnostics")]
    Diagnostics {
        #[command(subcommand)]
        action: LensDiagnosticsAction,
    },

    #[command(about = "Run repository-configured Lens checks and scanners")]
    Checks {
        #[command(subcommand)]
        action: LensChecksAction,
    },

    #[command(about = "List files touched during a turn")]
    Touched {
        #[arg(long, help = "Working directory")]
        cwd: Option<String>,
        #[arg(long, help = "Session id")]
        session: String,
        #[arg(long, help = "Turn id")]
        turn: String,
        #[arg(long, help = "Output JSON")]
        json: bool,
    },

    #[command(about = "Show compact turn health")]
    Health {
        #[arg(long, help = "Working directory")]
        cwd: Option<String>,
        #[arg(long, help = "Session id")]
        session: String,
        #[arg(long, help = "Turn id")]
        turn: String,
        #[arg(long, help = "Output JSON")]
        json: bool,
        #[arg(long, help = "Print final/agent-end style text")]
        final_output: bool,
    },
}

#[derive(Subcommand)]
pub enum LensChecksAction {
    #[command(about = "List configured checks, scanners, and suggestions")]
    List {
        #[arg(long, help = "Working directory")]
        cwd: Option<String>,
        #[arg(long, help = "Output JSON")]
        json: bool,
    },
    #[command(about = "Run configured checks and scanners")]
    Run {
        #[arg(long, help = "Working directory")]
        cwd: Option<String>,
        #[arg(long, help = "Output JSON")]
        json: bool,
        #[arg(long, help = "Run only automatic checks/scanners")]
        automatic: bool,
        #[arg(long, help = "Run all configured checks/scanners")]
        all: bool,
        #[arg(long, help = "Configured check/scanner name to run")]
        name: Vec<String>,
        #[arg(long, help = "Include configured scanners")]
        scanners: bool,
    },
}

#[derive(Subcommand)]
pub enum LensDiagnosticsAction {
    #[command(about = "List diagnostics")]
    List {
        #[arg(long, help = "Working directory")]
        cwd: Option<String>,
        #[arg(long, help = "Output JSON")]
        json: bool,
        #[arg(long, help = "Optional path filter")]
        path: Option<String>,
        #[arg(long, help = "Show all diagnostics")]
        all: bool,
    },
    #[command(about = "Record one diagnostic")]
    Record {
        #[arg(long, help = "Working directory")]
        cwd: Option<String>,
        #[arg(long, help = "Output JSON")]
        json: bool,
        #[arg(long, help = "Diagnostic source")]
        source: String,
        #[arg(long, help = "Diagnostic scope kind (workspace, file, command)")]
        scope_kind: Option<String>,
        #[arg(long, help = "Diagnostic scope key")]
        scope_key: Option<String>,
        #[arg(long, help = "Diagnostic severity: error, warning, info, hint")]
        severity: String,
        #[arg(long, help = "Path for the diagnostic")]
        path: Option<String>,
        #[arg(long, help = "Diagnostic code")]
        code: Option<String>,
        #[arg(long, help = "Diagnostic message")]
        message: String,
        #[arg(long, help = "Start line")]
        start_line: Option<i64>,
        #[arg(long, help = "End line")]
        end_line: Option<i64>,
        #[arg(long, help = "Stable diagnostic fingerprint")]
        fingerprint: Option<String>,
    },
    #[command(about = "Record a replacing diagnostic snapshot from JSON stdin")]
    Snapshot {
        #[arg(long, help = "Working directory")]
        cwd: Option<String>,
        #[arg(long, help = "Output JSON")]
        json: bool,
    },
}

#[derive(Subcommand)]
pub enum VaultAction {
    #[command(about = "List artifacts (defaults to current project)")]
    List {
        #[arg(short = 't', long = "type", default_value = "all", value_parser = KIND_VALUES, help = "Artifact type filter ('all' for cross-kind)")]
        kind: String,

        #[arg(long, help = "Output as JSON")]
        json: bool,

        #[arg(long, help = "Show artifacts from all projects")]
        all: bool,

        #[arg(short, long, help = "Filter by project path")]
        project: Option<String>,

        #[arg(long, help = "Show archived artifacts instead of active")]
        archived: bool,

        #[arg(long, help = "Include dive/ files (spec only)")]
        include_dives: bool,
    },

    #[command(about = "Create a new artifact")]
    Create {
        #[arg(short = 't', long = "type", value_parser = KIND_VALUES_NO_ALL, help = "Artifact type")]
        kind: String,

        #[arg(long, help = "Artifact topic")]
        topic: String,

        #[arg(long, help = "Project path (defaults to current git repo / cwd)")]
        project: Option<String>,

        #[arg(long, help = "Custom slug (auto-generated if omitted)")]
        slug: Option<String>,

        #[arg(long, help = "Source artifact stem for [[wiki-link]]")]
        source: Option<String>,

        #[arg(
            long,
            help = "Comma-separated tags (e.g. domain/combat,stage/research)"
        )]
        tags: Option<String>,

        #[arg(
            long,
            help = "Route to dive/ instead of spec/ (requires --source; spec only)"
        )]
        dive: bool,

        #[arg(long, help = "Output JSON")]
        json: bool,
    },

    #[command(about = "Read artifact body or frontmatter (universal stem resolution by default)")]
    Read {
        #[arg(short = 't', long = "type", default_value = "all", value_parser = KIND_VALUES, help = "Restrict resolution to this artifact type")]
        kind: String,

        #[arg(help = "File path or stem")]
        file: String,

        #[arg(long, help = "Output frontmatter as JSON")]
        frontmatter: bool,

        #[arg(long, help = "Output JSON envelope")]
        json: bool,
    },

    #[command(about = "Move an artifact to archive/")]
    Archive {
        #[arg(short = 't', long = "type", default_value = "all", value_parser = KIND_VALUES, help = "Restrict resolution to this artifact type")]
        kind: String,

        #[arg(help = "File path or stem")]
        file: Option<String>,

        #[arg(long, num_args = 1.., help = "Batch archive multiple files")]
        batch: Vec<String>,

        #[arg(long, help = "Preview what would be archived without acting")]
        dry_run: bool,

        #[arg(long, help = "Output JSON")]
        json: bool,
    },

    #[command(about = "Archive artifacts older than N days")]
    Prune {
        #[arg(short = 't', long = "type", default_value = "all", value_parser = KIND_VALUES, help = "Restrict to this artifact type")]
        kind: String,

        #[arg(long, default_value_t = 30, help = "Age threshold in days")]
        days: u64,

        #[arg(long, help = "Dry run — print what would be archived")]
        dry_run: bool,

        #[arg(short, long, help = "Filter by project path")]
        project: Option<String>,

        #[arg(long, help = "Output JSON")]
        json: bool,
    },

    #[command(about = "Extract inline HTML comments from an artifact")]
    Comments {
        #[arg(short = 't', long = "type", default_value = "all", value_parser = KIND_VALUES, help = "Restrict resolution to this artifact type")]
        kind: String,

        #[arg(help = "File path or stem")]
        file: String,

        #[arg(long, help = "Output as JSON")]
        json: bool,
    },

    #[command(about = "Rename an artifact and update its frontmatter")]
    Rename {
        #[arg(short = 't', long = "type", default_value = "all", value_parser = KIND_VALUES, help = "Restrict resolution to this artifact type")]
        kind: String,

        #[arg(help = "Current file path or stem")]
        old: String,

        #[arg(help = "New slug for the file")]
        new_slug: String,

        #[arg(long, help = "Output JSON")]
        json: bool,
    },

    #[command(about = "Fix auto-derived tags (type/*, project/*) in frontmatter")]
    Retag {
        #[arg(short = 't', long = "type", default_value = "all", value_parser = KIND_VALUES, help = "Restrict resolution to this artifact type")]
        kind: String,

        #[arg(help = "File path or stem")]
        file: String,

        #[arg(long, help = "Output JSON")]
        json: bool,
    },

    #[command(about = "Find related artifacts by topic keyword overlap")]
    Related {
        #[arg(long, help = "Project path (defaults to current git repo / cwd)")]
        project: Option<String>,

        #[arg(help = "Topic to match against")]
        topic: String,

        #[arg(long, help = "Include archived artifacts")]
        archive: bool,

        #[arg(long, help = "Output JSON")]
        json: bool,
    },

    #[command(about = "Check for unresolved wiki-links (via Obsidian CLI)")]
    Check {
        #[arg(long, help = "Include archived artifacts")]
        archive: bool,

        #[arg(long, help = "Output JSON")]
        json: bool,
    },

    #[command(about = "Search artifacts (via Obsidian CLI)")]
    Search {
        #[arg(help = "Search query")]
        query: String,

        #[arg(long, help = "Output as JSON")]
        json: bool,

        #[arg(long = "type", value_parser = KIND_VALUES_NO_ALL, help = "Filter by artifact type")]
        kind: Option<String>,

        #[arg(short, long, help = "Filter by project path")]
        project: Option<String>,

        #[arg(long, help = "Include archived artifacts")]
        archive: bool,
    },

    #[command(about = "Show vault status (git state, artifact count)")]
    Status {
        #[arg(long, help = "Output JSON")]
        json: bool,
    },

    #[command(about = "Commit and push edits to a vault file")]
    Commit {
        #[arg(help = "Absolute or vault-relative path to the edited file")]
        path: String,

        #[arg(
            long,
            help = "Commit message (defaults to '<kind>(<project>): edit <slug>')"
        )]
        message: Option<String>,

        #[arg(long, help = "Output JSON")]
        json: bool,
    },
}
