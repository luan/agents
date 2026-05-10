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

const KIND_VALUES: [&str; 6] = ["all", "research", "design", "structure", "plan", "doc"];
const KIND_VALUES_NO_ALL: [&str; 5] = ["research", "design", "structure", "plan", "doc"];

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
pub enum TaskAction {
    #[command(about = "Create a project task")]
    Add {
        #[arg(help = "Task title")]
        title: String,
        #[arg(long = "type", help = "Task type: epic, feature, bug, or chore")]
        task_type: Option<String>,
        #[arg(short, long, help = "Task body/details")]
        body: Option<String>,
        #[arg(long, default_value = "open", help = "Task status")]
        status: String,
        #[arg(long, default_value_t = 0, help = "Task priority; higher shows first")]
        priority: i64,
        #[arg(long = "assigned-to", help = "Session/user this task is assigned to")]
        assigned_to: Option<String>,
        #[arg(long = "assigned-label", hide = true)]
        assigned_label: Option<String>,
        #[arg(long = "epic-id", help = "Stable epic/group identifier")]
        epic_id: Option<String>,
        #[arg(long = "epic-title", help = "Human-readable epic/group title")]
        epic_title: Option<String>,
        #[arg(long = "label", help = "Task label token")]
        labels: Vec<String>,
        #[arg(long = "parent-id", help = "Parent/coordinator task ID/prefix")]
        parent_id: Option<String>,
        #[arg(long = "blocked-by", help = "Task ID/prefix that blocks this task")]
        blocked_by: Vec<String>,
        #[arg(long, help = "Output JSON")]
        json: bool,
    },

    #[command(about = "List project tasks")]
    List {
        #[arg(long, help = "Filter by status")]
        status: Option<String>,
        #[arg(long = "type", help = "Filter by task type")]
        task_type: Option<String>,
        #[arg(long = "label", help = "Filter by task label")]
        label: Option<String>,
        #[arg(long = "epic-id", help = "Filter by epic label/id")]
        epic_id: Option<String>,
        #[arg(long = "assigned-to", help = "Filter by assignee/session")]
        assigned_to: Option<String>,
        #[arg(long, help = "Include all statuses")]
        all: bool,
        #[arg(long, help = "Output JSON")]
        json: bool,
    },

    #[command(about = "Show one task by ID or unique prefix")]
    Show {
        #[arg(help = "Task ID or unique prefix")]
        id: String,
        #[arg(long, help = "Output JSON")]
        json: bool,
    },

    #[command(about = "Update one task by ID or unique prefix")]
    Update {
        #[arg(help = "Task ID or unique prefix")]
        id: String,
        #[arg(long = "type", help = "New task type: epic, feature, bug, or chore")]
        task_type: Option<String>,
        #[arg(long, help = "New title")]
        title: Option<String>,
        #[arg(long, help = "New body/details")]
        body: Option<String>,
        #[arg(long, help = "New status")]
        status: Option<String>,
        #[arg(long, help = "New priority; higher shows first")]
        priority: Option<i64>,
        #[arg(long = "assigned-to", help = "Assign to this session/user")]
        assigned_to: Option<String>,
        #[arg(long = "assigned-label", hide = true)]
        assigned_label: Option<String>,
        #[arg(long, help = "Remove assignee")]
        clear_assignee: bool,
        #[arg(long = "epic-id", help = "Stable epic/group identifier")]
        epic_id: Option<String>,
        #[arg(long = "epic-title", help = "Human-readable epic/group title")]
        epic_title: Option<String>,
        #[arg(long = "label", help = "Replace labels with this task label")]
        labels: Vec<String>,
        #[arg(long, help = "Remove epic/group metadata")]
        clear_epic: bool,
        #[arg(long = "parent-id", help = "Parent/coordinator task ID/prefix")]
        parent_id: Option<String>,
        #[arg(long, help = "Remove parent task")]
        clear_parent: bool,
        #[arg(
            long = "blocked-by",
            help = "Replace blockers with these task IDs/prefixes"
        )]
        blocked_by: Vec<String>,
        #[arg(long, help = "Remove all blockers")]
        clear_blockers: bool,
        #[arg(long, help = "Output JSON")]
        json: bool,
    },

    #[command(about = "Accept an in-review feature or bug task")]
    Accept {
        #[arg(help = "Task ID or unique prefix")]
        id: String,
        #[arg(long, help = "Output JSON")]
        json: bool,
    },

    #[command(about = "Reject an in-review feature or bug task")]
    Reject {
        #[arg(help = "Task ID or unique prefix")]
        id: String,
        #[arg(required = true, num_args = 1.., help = "Rejection note")]
        note: Vec<String>,
        #[arg(long, help = "Output JSON")]
        json: bool,
    },

    #[command(about = "Render the ratatui task overlay model")]
    Tui {
        #[arg(long, default_value_t = 100, help = "Render width")]
        width: u16,
        #[arg(long, default_value_t = 30, help = "Render height")]
        height: u16,
        #[arg(long = "selected-task-id", help = "Currently selected task id")]
        selected_task_id: Option<String>,
        #[arg(long, help = "Overlay key input to apply before rendering")]
        input: Option<String>,
        #[arg(long, help = "Run newline-delimited JSON embedding protocol")]
        embed: bool,
        #[arg(long, help = "Output JSON")]
        json: bool,
    },

    #[command(about = "Delete one task by ID or unique prefix")]
    Delete {
        #[arg(help = "Task ID or unique prefix")]
        id: String,
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

        #[arg(long, help = "Include dive/ files (research only)")]
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
            help = "Route to dive/ instead of research/ (requires --source; research only)"
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
