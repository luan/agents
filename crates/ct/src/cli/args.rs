use clap::{Args, Subcommand};
use clap_complete::Shell;

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
        #[arg(long, help = "Continuously redraw and reload config changes")]
        watch: bool,
        #[arg(
            long,
            default_value_t = 1000,
            help = "Watch redraw interval in milliseconds"
        )]
        interval_ms: u64,
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

    #[command(hide = true, about = "Serve the ast MCP over stdio")]
    Ast,

    #[command(hide = true, about = "Serve the lsp MCP over stdio")]
    Lsp,

    #[command(about = "Serve the vault MCP over stdio")]
    Vault,
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
