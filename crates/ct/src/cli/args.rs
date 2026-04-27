use clap::Subcommand;
use clap::ValueEnum;
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

#[derive(Subcommand)]
pub enum ToolAction {
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

    #[command(about = "Generate shell completion scripts")]
    Completion {
        #[arg(help = "Shell type (bash, zsh, fish, powershell, elvish)")]
        shell: Shell,
    },

    #[command(about = "Gather branch context (diff, log, files) for skills")]
    Gitcontext {
        #[arg(long, default_value = "main", help = "Base branch for comparison")]
        base: String,

        #[arg(long, default_value = "text", help = "Output format: text or json", value_parser = ["text", "json"])]
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

    #[command(about = "Apply a patch (envelope format) to files under cwd")]
    ApplyPatch {
        #[arg(long, help = "Working directory (default: process cwd)")]
        cwd: Option<String>,

        #[arg(long, help = "Preview changes without writing to disk")]
        dry_run: bool,
    },
}

#[derive(Subcommand)]
pub enum ApplyPatchCmd {
    #[command(about = "Show apply_patch telemetry summary")]
    Stats {
        #[arg(long, help = "Walk all project databases")]
        all_projects: bool,

        #[arg(long, default_value_t = 30, help = "Window in days")]
        days: i64,
    },

    #[command(about = "Delete telemetry older than --days")]
    Prune {
        #[arg(long, default_value_t = 90, help = "Retention window in days")]
        days: i64,
    },
}

#[derive(Subcommand)]
pub enum McpAction {
    #[command(about = "Serve the vault MCP over stdio")]
    Vault,

    #[command(about = "Serve the apply_patch MCP over stdio")]
    ApplyPatch,

    #[command(about = "Serve the sym MCP over stdio")]
    Sym,

    #[command(about = "Serve the ast MCP over stdio")]
    Ast,

    #[command(about = "Serve the lens MCP over stdio")]
    Lens,

    #[command(about = "Serve the lsp MCP over stdio")]
    Lsp,
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
    #[command(about = "Discover code through the routed Lens facade")]
    Discover {
        #[arg(long, help = "Working directory")]
        cwd: Option<String>,
        #[arg(long, help = "Output JSON")]
        json: bool,
        #[arg(
            long,
            help = "Discovery intent: symbol, text, path, source-context, ast, or lsp"
        )]
        intent: String,
        #[arg(long, help = "Symbol, text, AST, or LSP workspace query")]
        query: Option<String>,
        #[arg(long, help = "Optional file/path filter")]
        path: Option<String>,
        #[arg(long, help = "1-based source line")]
        line: Option<usize>,
        #[arg(long, help = "1-based ending source line")]
        end_line: Option<usize>,
        #[arg(long, help = "1-based source character for LSP requests")]
        character: Option<usize>,
        #[arg(long, help = "Language hint")]
        lang: Option<String>,
        #[arg(long, default_value_t = 10, help = "Maximum normalized results")]
        limit: usize,
        #[arg(long, default_value_t = 2, help = "Context lines when source is shown")]
        context: usize,
        #[arg(long, help = "Session id for read coverage")]
        session: Option<String>,
        #[arg(long, help = "LSP operation, e.g. hover or definition")]
        lsp_operation: Option<String>,
        #[arg(long, help = "Include resolver/debug fields in JSON")]
        debug: bool,
        #[arg(long, help = "Include raw backend fields in JSON")]
        raw: bool,
    },

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
        #[arg(long, value_enum, help = "Runtime guard policy override")]
        guard_mode: Option<GuardAction>,
    },

    #[command(about = "Inspect lens diagnostics")]
    Diagnostics {
        #[command(subcommand)]
        action: LensDiagnosticsAction,
    },

    #[command(about = "Record read coverage")]
    Read {
        #[command(subcommand)]
        action: LensReadAction,
    },

    #[command(about = "Check edit guard decisions")]
    Guard {
        #[command(subcommand)]
        action: LensGuardAction,
    },

    #[command(about = "Record and inspect turn-scoped touched files")]
    Turn {
        #[command(subcommand)]
        action: LensTurnAction,
    },

    #[command(about = "Prune lens state")]
    Prune {
        #[arg(long, help = "Working directory")]
        cwd: Option<String>,
        #[arg(long, help = "Output JSON")]
        json: bool,
        #[arg(long, help = "Preview without deleting")]
        dry_run: bool,
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
}

#[derive(Subcommand)]
pub enum LensReadAction {
    #[command(about = "Record a read range")]
    Record {
        #[arg(long, help = "Working directory")]
        cwd: Option<String>,
        #[arg(long, help = "Output JSON")]
        json: bool,
        #[arg(long, help = "Path read")]
        path: String,
        #[arg(long, help = "Start line")]
        start_line: i64,
        #[arg(long, help = "End line")]
        end_line: i64,
        #[arg(long, help = "Session id")]
        session: Option<String>,
    },
}

#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum GuardAction {
    Off,
    Warn,
    Block,
}

#[derive(Subcommand)]
pub enum LensTurnAction {
    #[command(about = "Record one normalized Lens turn event from stdin")]
    Record {
        #[arg(long, help = "Working directory used when event.cwd is empty")]
        cwd: Option<String>,
        #[arg(long, help = "Output JSON")]
        json: bool,
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
}

#[derive(Subcommand)]
pub enum LensGuardAction {
    #[command(about = "Check whether an edit range is covered")]
    Check {
        #[arg(long, help = "Working directory")]
        cwd: Option<String>,
        #[arg(long, help = "Output JSON")]
        json: bool,
        #[arg(long, help = "Path to edit")]
        path: String,
        #[arg(long, help = "Start line")]
        start_line: i64,
        #[arg(long, help = "End line")]
        end_line: i64,
        #[arg(long, help = "Session id")]
        session: Option<String>,
        #[arg(long, value_enum, default_value_t = GuardAction::Warn)]
        mode: GuardAction,
    },

    #[command(about = "Allow one edit despite guard findings")]
    AllowOnce {
        #[arg(long, help = "Output JSON")]
        json: bool,
        #[arg(long, help = "Path to allow")]
        path: String,
        #[arg(long, help = "Session id")]
        session: Option<String>,
    },
}

#[derive(Subcommand)]
pub enum PatchAction {
    #[command(about = "Manage durable patch drafts")]
    Draft {
        #[command(subcommand)]
        action: PatchDraftAction,
    },
}

#[derive(Subcommand)]
pub enum PatchDraftAction {
    #[command(about = "Create a patch draft from stdin")]
    Create {
        #[arg(long, help = "Working directory")]
        cwd: Option<String>,
        #[arg(long, help = "Output JSON")]
        json: bool,
    },
    #[command(about = "Show patch draft status")]
    Status {
        patch_id: String,
        #[arg(long, help = "Output JSON")]
        json: bool,
    },
    #[command(about = "Show a patch draft or chunk")]
    Show {
        patch_id: String,
        #[arg(long, help = "Chunk index")]
        chunk: Option<usize>,
        #[arg(long, help = "Output JSON")]
        json: bool,
    },
    #[command(about = "Amend a patch draft chunk")]
    Amend {
        patch_id: String,
        #[arg(long, help = "Chunk index")]
        chunk: usize,
        #[arg(long, help = "Replacement anchor")]
        anchor: Option<String>,
        #[arg(long, help = "Output JSON")]
        json: bool,
    },
    #[command(about = "Apply a patch draft atomically")]
    Apply {
        patch_id: String,
        #[arg(long, help = "Output JSON")]
        json: bool,
    },
    #[command(about = "Discard a patch draft")]
    Discard {
        patch_id: String,
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
    },

    #[command(about = "Read artifact body or frontmatter (universal stem resolution by default)")]
    Read {
        #[arg(short = 't', long = "type", default_value = "all", value_parser = KIND_VALUES, help = "Restrict resolution to this artifact type")]
        kind: String,

        #[arg(help = "File path or stem")]
        file: String,

        #[arg(long, help = "Output frontmatter as JSON")]
        frontmatter: bool,
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
    },

    #[command(about = "Fix auto-derived tags (type/*, project/*) in frontmatter")]
    Retag {
        #[arg(short = 't', long = "type", default_value = "all", value_parser = KIND_VALUES, help = "Restrict resolution to this artifact type")]
        kind: String,

        #[arg(help = "File path or stem")]
        file: String,
    },

    #[command(about = "Find related artifacts by topic keyword overlap")]
    Related {
        #[arg(long, help = "Project path (defaults to current git repo / cwd)")]
        project: Option<String>,

        #[arg(help = "Topic to match against")]
        topic: String,

        #[arg(long, help = "Include archived artifacts")]
        archive: bool,
    },

    #[command(about = "Check for unresolved wiki-links (via Obsidian CLI)")]
    Check {
        #[arg(long, help = "Include archived artifacts")]
        archive: bool,
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
    Status,

    #[command(about = "Commit and push edits to a vault file")]
    Commit {
        #[arg(help = "Absolute or vault-relative path to the edited file")]
        path: String,

        #[arg(
            long,
            help = "Commit message (defaults to '<kind>(<project>): edit <slug>')"
        )]
        message: Option<String>,
    },
}
