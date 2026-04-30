use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::path::{Component, Path};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use super::contract::{LensEnvelope, LensMessage};
use super::store::{CleanupRunRecordInput, LensStore};
use super::types::{
    Diagnostic, DiagnosticListData, DiagnosticScope, DiagnosticSeverity, DiagnosticSnapshotInput,
    DiagnosticSnapshotMetadata, DiagnosticSnapshotResult, DiagnosticSource, LensTouchedFile,
};
use serde::{Deserialize, Serialize};

const DEFAULT_CLEANUP_TIMEOUT_MS: u64 = 10_000;
const DEFAULT_CLEANUP_RAW_OUTPUT_MAX_BYTES: usize = 64 * 1024;
const MAX_PARSED_DIAGNOSTICS: usize = 50;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CleanupRegistry {
    pub tools: Vec<CleanupToolDefinition>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CleanupToolDefinition {
    pub id: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub extensions: Vec<String>,
    #[serde(default)]
    pub filenames: Vec<String>,
    pub safety: CleanupSafetyClass,
    pub mutability: CleanupMutability,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
    #[serde(default)]
    pub parser: CleanupParserBehavior,
    #[serde(default = "default_raw_output_max_bytes")]
    pub raw_output_max_bytes: usize,
    #[serde(default)]
    pub purpose: String,
    #[serde(default)]
    pub install_hint: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CleanupSafetyClass {
    SafeAutoApply,
    Unsafe,
    Invasive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CleanupMutability {
    Mutates,
    CheckOnly,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CleanupParserBehavior {
    #[default]
    None,
    LineDiagnostics,
}

#[derive(Debug, Clone, Default)]
pub struct CleanupOptions {
    pub allow_unsafe: bool,
    pub registry: Option<CleanupRegistry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CleanupReport {
    pub project_id: i64,
    pub session: String,
    pub turn: String,
    pub scoped_files: Vec<CleanupScopedFile>,
    pub runs: Vec<CleanupRunReport>,
    pub suggestions: Vec<CleanupSuggestion>,
    pub mutations: Vec<CleanupMutation>,
    pub mutation_count: usize,
    pub diagnostics: CleanupDiagnosticReport,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CleanupScopedFile {
    pub path: String,
    pub generated_companion: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CleanupRunReport {
    pub run_id: Option<i64>,
    pub tool: String,
    pub command: Vec<String>,
    pub status: CleanupRunStatus,
    pub safety: CleanupSafetyClass,
    pub mutability: CleanupMutability,
    pub files: Vec<String>,
    pub duration_ms: u64,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub raw_output_original_bytes: i64,
    pub raw_output_retained_bytes: i64,
    pub raw_output_truncated: bool,
    pub diagnostic_snapshot: Option<DiagnosticSnapshotResult>,
    pub mutations: Vec<CleanupMutation>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CleanupRunStatus {
    Success,
    Failed,
    TimedOut,
    SkippedMissingCommand,
    SkippedNoFiles,
    SkippedUnsafe,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CleanupSuggestion {
    pub tool: String,
    pub safety: CleanupSafetyClass,
    pub mutability: CleanupMutability,
    pub files: Vec<String>,
    pub command: Vec<String>,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CleanupMutation {
    pub path: String,
    pub operation: String,
    pub before_hash: Option<String>,
    pub after_hash: Option<String>,
    pub tool: String,
    pub generated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CleanupDiagnosticReport {
    pub post_cleanup: DiagnosticListData,
    pub regressions: Vec<Diagnostic>,
    pub regression_count: usize,
}

#[derive(Debug, Clone)]
struct FileState {
    hash: Option<String>,
    exists: bool,
    generated_companion: bool,
}

#[derive(Debug)]
struct ProcessOutput {
    status: CleanupRunStatus,
    exit_code: Option<i32>,
    timed_out: bool,
    duration_ms: u64,
    stdout: CappedBytes,
    stderr: CappedBytes,
}

#[derive(Debug)]
struct CappedBytes {
    bytes: Vec<u8>,
    original_bytes: i64,
    truncated: bool,
}

pub fn cleanup_registry_from_env() -> Result<Option<CleanupRegistry>, Box<dyn std::error::Error>> {
    let Ok(value) = std::env::var("CT_LENS_CLEANUP_REGISTRY") else {
        return Ok(None);
    };
    if value.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(serde_json::from_str(&value)?))
}

pub fn default_cleanup_registry() -> CleanupRegistry {
    CleanupRegistry {
        tools: vec![
            cleanup_tool(
                "air",
                "air",
                &["format", "{files}"],
                &["R"],
                CleanupSafetyClass::SafeAutoApply,
                "format changed R files",
                "install air and make the air command available",
            ),
            cleanup_tool(
                "biome",
                "biome",
                &["format", "--write", "{files}"],
                &[
                    "js", "jsx", "ts", "tsx", "html", "css", "md", "json", "yaml", "yml",
                ],
                CleanupSafetyClass::SafeAutoApply,
                "format changed files with Biome",
                "install biome and add biome.json or biome.jsonc when Biome should own formatting",
            ),
            cleanup_tool(
                "cargofmt",
                "cargo",
                &["fmt", "--", "{files}"],
                &["rs"],
                CleanupSafetyClass::SafeAutoApply,
                "format changed Rust files through cargo fmt",
                "install rustfmt with rustup component add rustfmt",
            ),
            cleanup_tool(
                "clang-format",
                "clang-format",
                &["-i", "{files}"],
                &[
                    "c", "cpp", "cc", "cxx", "c++", "h", "hpp", "hh", "hxx", "h++", "ino",
                ],
                CleanupSafetyClass::SafeAutoApply,
                "format changed C/C++ files",
                "install clang-format and add .clang-format when clang-format should own formatting",
            ),
            cleanup_tool(
                "cljfmt",
                "cljfmt",
                &["fix", "{files}"],
                &["clj", "cljs", "cljc", "edn"],
                CleanupSafetyClass::SafeAutoApply,
                "format changed Clojure files",
                "install cljfmt",
            ),
            cleanup_tool(
                "dart",
                "dart",
                &["format", "{files}"],
                &["dart"],
                CleanupSafetyClass::SafeAutoApply,
                "format changed Dart files",
                "install Dart",
            ),
            cleanup_tool(
                "dfmt",
                "dfmt",
                &["-i", "{files}"],
                &["d"],
                CleanupSafetyClass::SafeAutoApply,
                "format changed D files",
                "install dfmt",
            ),
            cleanup_tool(
                "gleam",
                "gleam",
                &["format", "{files}"],
                &["gleam"],
                CleanupSafetyClass::SafeAutoApply,
                "format changed Gleam files",
                "install gleam",
            ),
            cleanup_tool(
                "gofmt",
                "gofmt",
                &["-w", "{files}"],
                &["go"],
                CleanupSafetyClass::SafeAutoApply,
                "format changed Go files",
                "install Go to make gofmt available",
            ),
            cleanup_tool(
                "htmlbeautifier",
                "htmlbeautifier",
                &["-r", "{files}"],
                &["erb"],
                CleanupSafetyClass::SafeAutoApply,
                "format changed ERB files",
                "install htmlbeautifier",
            ),
            cleanup_tool(
                "ktlint",
                "ktlint",
                &["-F", "{files}"],
                &["kt", "kts"],
                CleanupSafetyClass::SafeAutoApply,
                "format changed Kotlin files",
                "install ktlint",
            ),
            cleanup_tool(
                "mix",
                "mix",
                &["format", "{files}"],
                &["ex", "exs", "eex", "heex", "leex", "neex", "sface"],
                CleanupSafetyClass::SafeAutoApply,
                "format changed Elixir files",
                "install Elixir",
            ),
            cleanup_tool(
                "nixfmt",
                "nixfmt",
                &["{files}"],
                &["nix"],
                CleanupSafetyClass::SafeAutoApply,
                "format changed Nix files",
                "install nixfmt",
            ),
            cleanup_tool(
                "ocamlformat",
                "ocamlformat",
                &["--inplace", "{files}"],
                &["ml", "mli"],
                CleanupSafetyClass::SafeAutoApply,
                "format changed OCaml files",
                "install ocamlformat and add .ocamlformat",
            ),
            cleanup_tool(
                "ormolu",
                "ormolu",
                &["--mode", "inplace", "{files}"],
                &["hs"],
                CleanupSafetyClass::SafeAutoApply,
                "format changed Haskell files",
                "install ormolu",
            ),
            cleanup_tool(
                "oxfmt",
                "oxfmt",
                &["--write", "{files}"],
                &["js", "jsx", "ts", "tsx"],
                CleanupSafetyClass::Unsafe,
                "format changed JS/TS files with experimental oxfmt",
                "install oxfmt and enable it explicitly when desired",
            ),
            cleanup_tool(
                "pint",
                "vendor/bin/pint",
                &["{files}"],
                &["php"],
                CleanupSafetyClass::SafeAutoApply,
                "format changed PHP files with Laravel Pint",
                "install laravel/pint in composer.json",
            ),
            cleanup_tool(
                "prettier",
                "prettier",
                &["--write", "{files}"],
                &[
                    "js", "jsx", "ts", "tsx", "html", "css", "md", "json", "yaml", "yml",
                ],
                CleanupSafetyClass::SafeAutoApply,
                "format changed web/config files",
                "install prettier in the project or PATH",
            ),
            cleanup_tool(
                "rubocop",
                "rubocop",
                &["-A", "{files}"],
                &["rb", "rake", "gemspec", "ru"],
                CleanupSafetyClass::SafeAutoApply,
                "format changed Ruby files with RuboCop autocorrect",
                "install rubocop",
            ),
            cleanup_tool(
                "ruff",
                "ruff",
                &["format", "{files}"],
                &["py", "pyi"],
                CleanupSafetyClass::SafeAutoApply,
                "format changed Python files with Ruff",
                "install ruff and configure it for the project",
            ),
            cleanup_tool(
                "rustfmt",
                "rustfmt",
                &["--edition", "2024", "{files}"],
                &["rs"],
                CleanupSafetyClass::SafeAutoApply,
                "format changed Rust files",
                "install rustfmt with rustup component add rustfmt",
            ),
            cleanup_tool(
                "shfmt",
                "shfmt",
                &["-w", "{files}"],
                &["sh", "bash"],
                CleanupSafetyClass::SafeAutoApply,
                "format changed shell files",
                "install shfmt",
            ),
            cleanup_tool(
                "standardrb",
                "standardrb",
                &["--fix", "{files}"],
                &["rb", "rake", "gemspec", "ru"],
                CleanupSafetyClass::SafeAutoApply,
                "format changed Ruby files with Standard Ruby",
                "install standardrb",
            ),
            cleanup_tool(
                "terraform",
                "terraform",
                &["fmt", "{files}"],
                &["tf", "tfvars"],
                CleanupSafetyClass::SafeAutoApply,
                "format changed Terraform files",
                "install terraform",
            ),
            cleanup_tool(
                "uv",
                "uv",
                &["run", "ruff", "format", "{files}"],
                &["py", "pyi"],
                CleanupSafetyClass::SafeAutoApply,
                "format changed Python files with uv-managed Ruff",
                "install uv and ruff",
            ),
            cleanup_tool(
                "zig",
                "zig",
                &["fmt", "{files}"],
                &["zig", "zon"],
                CleanupSafetyClass::SafeAutoApply,
                "format changed Zig files",
                "install zig",
            ),
            cleanup_tool(
                "cargo-fmt-workspace",
                "cargo",
                &["fmt", "{no_files}"],
                &["rs"],
                CleanupSafetyClass::Invasive,
                "format the whole Rust workspace",
                "run cargo fmt explicitly when workspace-wide formatting is desired",
            ),
        ],
    }
}

fn cleanup_tool(
    id: &str,
    command: &str,
    args: &[&str],
    extensions: &[&str],
    safety: CleanupSafetyClass,
    purpose: &str,
    install_hint: &str,
) -> CleanupToolDefinition {
    CleanupToolDefinition {
        id: id.to_string(),
        command: command.to_string(),
        args: args.iter().map(|arg| arg.to_string()).collect(),
        extensions: extensions
            .iter()
            .map(|extension| extension.trim_start_matches('.').to_string())
            .collect(),
        filenames: Vec::new(),
        safety,
        mutability: CleanupMutability::Mutates,
        timeout_ms: DEFAULT_CLEANUP_TIMEOUT_MS,
        parser: CleanupParserBehavior::LineDiagnostics,
        raw_output_max_bytes: DEFAULT_CLEANUP_RAW_OUTPUT_MAX_BYTES,
        purpose: purpose.to_string(),
        install_hint: install_hint.to_string(),
    }
}

pub fn cleanup_turn_envelope(
    root: &Path,
    session: &str,
    turn: &str,
    options: CleanupOptions,
) -> Result<LensEnvelope<CleanupReport>, Box<dyn std::error::Error>> {
    let mut store = LensStore::open_for_project(root)?;
    let report = run_turn_cleanup_with_store(root, &mut store, session, turn, options)?;
    Ok(cleanup_envelope(report))
}

pub fn cleanup_envelope(report: CleanupReport) -> LensEnvelope<CleanupReport> {
    let mut warnings = Vec::new();
    for suggestion in &report.suggestions {
        warnings.push(LensMessage::warning_with_hint(
            "cleanup_suggested",
            format!(
                "cleanup tool '{}' was suggested but not run: {}",
                suggestion.tool, suggestion.reason
            ),
            suggestion.hint.clone().unwrap_or_else(|| {
                "run the tool explicitly if this wider cleanup is desired".to_string()
            }),
        ));
    }
    for run in &report.runs {
        match run.status {
            CleanupRunStatus::Failed => warnings.push(LensMessage::warning(
                "cleanup_failed",
                format!("cleanup tool '{}' exited unsuccessfully", run.tool),
            )),
            CleanupRunStatus::TimedOut => warnings.push(LensMessage::warning_with_hint(
                "cleanup_timed_out",
                format!("cleanup tool '{}' timed out", run.tool),
                "run the formatter manually or increase the registry timeout",
            )),
            CleanupRunStatus::SkippedMissingCommand => {
                warnings.push(LensMessage::warning_with_hint(
                    "cleanup_tool_missing",
                    format!("cleanup tool '{}' is not available", run.tool),
                    "install the tool or remove it from the cleanup registry",
                ))
            }
            _ => {}
        }
    }
    if report.diagnostics.regression_count > 0 {
        warnings.push(LensMessage::warning(
            "cleanup_regression",
            format!(
                "{} diagnostics appeared after cleanup",
                report.diagnostics.regression_count
            ),
        ));
    }
    if warnings.is_empty() {
        LensEnvelope::ok(report)
    } else {
        LensEnvelope::warning(report, warnings)
    }
}

pub fn run_turn_cleanup_with_store(
    root: &Path,
    store: &mut LensStore,
    session: &str,
    turn: &str,
    mut options: CleanupOptions,
) -> Result<CleanupReport, Box<dyn std::error::Error>> {
    let registry = options
        .registry
        .take()
        .or(cleanup_registry_from_env()?)
        .unwrap_or_else(default_cleanup_registry);
    let before_diagnostics = active_diagnostic_keys(&store.list_diagnostics(None)?);
    let touched = store.list_touched_files(session, turn)?;
    let scoped_files = cleanup_scope(root, &touched);
    let mut state = file_states(root, &scoped_files);
    let mut runs = Vec::new();
    let mut suggestions = Vec::new();
    let mut all_mutations = Vec::new();

    for tool in &registry.tools {
        let matched_files = matching_files(tool, &scoped_files);
        if matched_files.is_empty() {
            continue;
        }
        let command = command_line(root, tool, &matched_files);
        if !is_safe_to_run(tool, options.allow_unsafe) {
            suggestions.push(CleanupSuggestion {
                tool: tool.id.clone(),
                safety: tool.safety,
                mutability: tool.mutability,
                files: matched_files,
                command,
                reason: format!(
                    "{:?} cleanup is not enabled for automatic turn-end apply",
                    tool.safety
                ),
                hint: Some(tool.install_hint.clone()).filter(|hint| !hint.is_empty()),
            });
            continue;
        }
        if !command_available(root, &tool.command) {
            runs.push(CleanupRunReport {
                run_id: None,
                tool: tool.id.clone(),
                command,
                status: CleanupRunStatus::SkippedMissingCommand,
                safety: tool.safety,
                mutability: tool.mutability,
                files: matched_files,
                duration_ms: 0,
                exit_code: None,
                timed_out: false,
                raw_output_original_bytes: 0,
                raw_output_retained_bytes: 0,
                raw_output_truncated: false,
                diagnostic_snapshot: None,
                mutations: Vec::new(),
            });
            continue;
        }
        let before = state.clone();
        let process = run_process(root, tool, &command)?;
        let raw_output = combine_output(&process, tool.raw_output_max_bytes);
        let diagnostics = diagnostics_from_output(root, tool, &process, &raw_output.body);
        let diagnostic_snapshot =
            record_cleanup_snapshot(store, tool, &process, &raw_output.body, diagnostics)?;
        let after = file_states(root, &scoped_files);
        let mutations = detect_mutations(tool, &before, &after);
        state = after;
        let status = process.status;
        let run_id = store.record_cleanup_run(CleanupRunRecordInput {
            session,
            turn,
            tool: &tool.id,
            command: &command,
            status,
            safety: tool.safety,
            mutability: tool.mutability,
            file_count: matched_files.len(),
            mutation_count: mutations.len(),
            duration_ms: process.duration_ms,
            timed_out: process.timed_out,
            exit_code: process.exit_code,
            diagnostic_snapshot_id: diagnostic_snapshot
                .as_ref()
                .map(|snapshot| snapshot.snapshot_id),
            raw_output_id: diagnostic_snapshot
                .as_ref()
                .and_then(|snapshot| snapshot.raw_output.as_ref().map(|raw| raw.id)),
            mutations: &mutations,
        })?;
        all_mutations.extend(mutations.clone());
        runs.push(CleanupRunReport {
            run_id: Some(run_id),
            tool: tool.id.clone(),
            command,
            status,
            safety: tool.safety,
            mutability: tool.mutability,
            files: matched_files,
            duration_ms: process.duration_ms,
            exit_code: process.exit_code,
            timed_out: process.timed_out,
            raw_output_original_bytes: raw_output.original_bytes,
            raw_output_retained_bytes: raw_output.retained_bytes,
            raw_output_truncated: raw_output.truncated,
            diagnostic_snapshot,
            mutations,
        });
    }

    let post_cleanup = store.list_diagnostics_data(None, false)?;
    let regressions = post_cleanup
        .diagnostics
        .iter()
        .filter(|diagnostic| !before_diagnostics.contains(&diagnostic_key(diagnostic)))
        .cloned()
        .collect::<Vec<_>>();
    Ok(CleanupReport {
        project_id: store.project_id(),
        session: session.to_string(),
        turn: turn.to_string(),
        scoped_files,
        runs,
        suggestions,
        mutation_count: all_mutations.len(),
        mutations: all_mutations,
        diagnostics: CleanupDiagnosticReport {
            post_cleanup,
            regression_count: regressions.len(),
            regressions,
        },
    })
}

fn is_safe_to_run(tool: &CleanupToolDefinition, allow_unsafe: bool) -> bool {
    matches!(tool.safety, CleanupSafetyClass::SafeAutoApply) || allow_unsafe
}

fn cleanup_scope(root: &Path, touched: &[LensTouchedFile]) -> Vec<CleanupScopedFile> {
    let mut scoped: BTreeMap<String, CleanupScopedFile> = BTreeMap::new();
    for file in touched {
        if file.ignored || !is_write_operation(&file.operation) || !safe_rel_path(&file.path) {
            continue;
        }
        let full_path = root.join(&file.path);
        if !full_path.is_file() {
            continue;
        }
        scoped.insert(
            file.path.clone(),
            CleanupScopedFile {
                path: file.path.clone(),
                generated_companion: false,
            },
        );
        for companion in generated_companions(root, &file.path) {
            scoped
                .entry(companion.clone())
                .or_insert(CleanupScopedFile {
                    path: companion,
                    generated_companion: true,
                });
        }
    }
    scoped.into_values().collect()
}

fn is_write_operation(operation: &str) -> bool {
    matches!(
        operation,
        "add" | "create" | "delete" | "edit" | "modify" | "move" | "rename" | "write"
    )
}

fn generated_companions(root: &Path, rel_path: &str) -> Vec<String> {
    let path = Path::new(rel_path);
    let parent = path.parent().unwrap_or_else(|| Path::new(""));
    let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
        return Vec::new();
    };
    let stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or(file_name);
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default();
    let mut candidates = Vec::new();
    if !extension.is_empty() {
        candidates.push(parent.join(format!("{stem}.generated.{extension}")));
    }
    candidates.extend([
        parent.join(format!("{stem}.pb.go")),
        parent.join(format!("{stem}.pb.rs")),
        parent.join(format!("{stem}.generated.rs")),
        parent.join(format!("{stem}.generated.ts")),
    ]);
    match file_name {
        "Cargo.toml" => candidates.push(parent.join("Cargo.lock")),
        "package.json" => candidates.extend([
            parent.join("package-lock.json"),
            parent.join("pnpm-lock.yaml"),
            parent.join("yarn.lock"),
            parent.join("bun.lock"),
        ]),
        _ => {}
    }
    candidates
        .into_iter()
        .filter(|candidate| root.join(candidate).is_file())
        .filter_map(|candidate| path_to_slash(&candidate))
        .collect()
}

fn safe_rel_path(path: &str) -> bool {
    let path = Path::new(path);
    !path.is_absolute()
        && !path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
}

fn path_to_slash(path: &Path) -> Option<String> {
    let out = path
        .components()
        .filter_map(|component| match component {
            Component::Normal(part) => Some(part.to_string_lossy().to_string()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/");
    (!out.is_empty()).then_some(out)
}

fn file_states(root: &Path, files: &[CleanupScopedFile]) -> BTreeMap<String, FileState> {
    files
        .iter()
        .map(|file| {
            let full_path = root.join(&file.path);
            let hash = std::fs::read(&full_path)
                .ok()
                .map(|bytes| crate::apply_patch::sha1_hex(&bytes));
            (
                file.path.clone(),
                FileState {
                    exists: full_path.is_file(),
                    hash,
                    generated_companion: file.generated_companion,
                },
            )
        })
        .collect()
}

fn matching_files(tool: &CleanupToolDefinition, files: &[CleanupScopedFile]) -> Vec<String> {
    files
        .iter()
        .filter(|file| tool_matches(tool, &file.path))
        .map(|file| file.path.clone())
        .collect()
}

fn tool_matches(tool: &CleanupToolDefinition, rel_path: &str) -> bool {
    let path = Path::new(rel_path);
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    if tool.filenames.iter().any(|name| name == file_name) {
        return true;
    }
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default();
    tool.extensions.iter().any(|candidate| {
        candidate
            .trim_start_matches('.')
            .eq_ignore_ascii_case(extension)
    })
}

fn command_line(root: &Path, tool: &CleanupToolDefinition, files: &[String]) -> Vec<String> {
    let mut command =
        vec![resolve_command(root, &tool.command).unwrap_or_else(|| tool.command.clone())];
    let mut expanded = false;
    for arg in &tool.args {
        if arg == "{files}" {
            command.extend(files.iter().cloned());
            expanded = true;
        } else if arg == "{no_files}" {
            expanded = true;
        } else {
            command.push(arg.clone());
        }
    }
    if !expanded {
        command.extend(files.iter().cloned());
    }
    command
}

fn command_available(root: &Path, command: &str) -> bool {
    resolve_command(root, command).is_some()
}

fn resolve_command(root: &Path, command: &str) -> Option<String> {
    let path = Path::new(command);
    if path.components().count() > 1 {
        let path = if path.is_absolute() {
            path.to_path_buf()
        } else {
            root.join(path)
        };
        return path.is_file().then(|| path.display().to_string());
    }
    let local = root.join("node_modules").join(".bin").join(command);
    if local.is_file() {
        return Some(local.display().to_string());
    }
    let mason = dirs::home_dir()?
        .join(".local")
        .join("share")
        .join("nvim")
        .join("mason")
        .join("bin")
        .join(command);
    if mason.is_file() {
        return Some(mason.display().to_string());
    }
    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths)
        .map(|dir| dir.join(command))
        .find(|path| path.is_file())
        .map(|path| path.display().to_string())
}

fn run_process(
    root: &Path,
    tool: &CleanupToolDefinition,
    command: &[String],
) -> Result<ProcessOutput, Box<dyn std::error::Error>> {
    if command.is_empty() {
        return Err("cleanup command cannot be empty".into());
    }
    let start = Instant::now();
    let mut child = Command::new(&command[0])
        .args(&command[1..])
        .current_dir(root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let stdout = child.stdout.take().expect("stdout is piped");
    let stderr = child.stderr.take().expect("stderr is piped");
    let max_bytes = tool.raw_output_max_bytes;
    let stdout_reader = std::thread::spawn(move || read_capped(stdout, max_bytes));
    let stderr_reader = std::thread::spawn(move || read_capped(stderr, max_bytes));
    let timeout = Duration::from_millis(tool.timeout_ms.max(1));
    let (exit_code, timed_out) = loop {
        if let Some(status) = child.try_wait()? {
            break (status.code(), false);
        }
        if start.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            break (None, true);
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    let stdout = stdout_reader
        .join()
        .map_err(|_| "cleanup stdout reader panicked")??;
    let stderr = stderr_reader
        .join()
        .map_err(|_| "cleanup stderr reader panicked")??;
    let status = if timed_out {
        CleanupRunStatus::TimedOut
    } else if exit_code == Some(0) {
        CleanupRunStatus::Success
    } else {
        CleanupRunStatus::Failed
    };
    Ok(ProcessOutput {
        status,
        exit_code,
        timed_out,
        duration_ms: start.elapsed().as_millis() as u64,
        stdout,
        stderr,
    })
}

fn read_capped(mut reader: impl Read, max_bytes: usize) -> Result<CappedBytes, std::io::Error> {
    let mut original_bytes = 0_i64;
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        original_bytes += read as i64;
        let remaining = max_bytes.saturating_sub(bytes.len());
        if remaining > 0 {
            bytes.extend_from_slice(&buffer[..read.min(remaining)]);
        }
    }
    Ok(CappedBytes {
        truncated: original_bytes as usize > bytes.len(),
        bytes,
        original_bytes,
    })
}

struct RawOutputBody {
    body: String,
    original_bytes: i64,
    retained_bytes: i64,
    truncated: bool,
}

fn combine_output(process: &ProcessOutput, max_bytes: usize) -> RawOutputBody {
    let mut original_bytes = process.stdout.original_bytes + process.stderr.original_bytes;
    let mut text = String::new();
    if !process.stdout.bytes.is_empty() {
        text.push_str(&String::from_utf8_lossy(&process.stdout.bytes));
    }
    if !process.stderr.bytes.is_empty() {
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
            original_bytes += 1;
        }
        text.push_str(&String::from_utf8_lossy(&process.stderr.bytes));
    }
    let (body, truncated) = truncate_utf8(&text, max_bytes);
    RawOutputBody {
        retained_bytes: body.len() as i64,
        truncated: truncated || process.stdout.truncated || process.stderr.truncated,
        body,
        original_bytes,
    }
}

fn truncate_utf8(value: &str, max_bytes: usize) -> (String, bool) {
    if value.len() <= max_bytes {
        return (value.to_string(), false);
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    (value[..end].to_string(), true)
}

fn diagnostics_from_output(
    root: &Path,
    tool: &CleanupToolDefinition,
    process: &ProcessOutput,
    raw_output: &str,
) -> Vec<Diagnostic> {
    let default_severity = if matches!(
        process.status,
        CleanupRunStatus::Failed | CleanupRunStatus::TimedOut
    ) {
        DiagnosticSeverity::Error
    } else {
        DiagnosticSeverity::Warning
    };
    let mut diagnostics = Vec::new();
    if matches!(tool.parser, CleanupParserBehavior::LineDiagnostics) {
        for line in raw_output.lines().filter(|line| !line.trim().is_empty()) {
            if diagnostics.len() >= MAX_PARSED_DIAGNOSTICS {
                break;
            }
            if matches!(process.status, CleanupRunStatus::Success)
                && !line_has_explicit_severity(line)
            {
                continue;
            }
            diagnostics.push(diagnostic_from_line(
                root,
                &tool.id,
                line,
                default_severity.clone(),
            ));
        }
    }
    if diagnostics.is_empty() && !matches!(process.status, CleanupRunStatus::Success) {
        let message = if process.timed_out {
            format!("cleanup tool '{}' timed out", tool.id)
        } else {
            format!(
                "cleanup tool '{}' exited with {:?}",
                tool.id, process.exit_code
            )
        };
        diagnostics.push(Diagnostic {
            source: DiagnosticSource::Formatter,
            scope: DiagnosticScope::command(tool.id.clone()),
            severity: DiagnosticSeverity::Error,
            code: Some(
                if process.timed_out {
                    "timeout"
                } else {
                    "failed"
                }
                .to_string(),
            ),
            message,
            rel_path: None,
            start_line: None,
            end_line: None,
            fingerprint: crate::apply_patch::sha1_hex(
                format!("cleanup:{}:{:?}", tool.id, process.status).as_bytes(),
            ),
            content_hash: None,
            raw_output_id: None,
            snapshot_id: None,
            first_seen_at: None,
            last_seen_at: None,
            resolved_at: None,
        });
    }
    diagnostics
}

fn diagnostic_from_line(
    root: &Path,
    tool: &str,
    line: &str,
    default_severity: DiagnosticSeverity,
) -> Diagnostic {
    let mut rel_path = None;
    let mut start_line = None;
    let mut severity = default_severity;
    let mut message = line.trim().to_string();
    let parts = line.splitn(4, ':').collect::<Vec<_>>();
    if let Some((path, line_number)) = rustfmt_location(root, line) {
        rel_path = Some(path);
        start_line = Some(line_number);
    } else if parts.len() >= 3
        && safe_rel_path(parts[0])
        && let Ok(line_number) = parts[1].parse::<i64>()
    {
        rel_path = Some(parts[0].to_string());
        start_line = Some(line_number.max(1));
        message = parts[2..].join(":").trim().to_string();
        if parts.len() == 4 {
            severity = parse_line_severity(parts[2]).unwrap_or(severity);
            message = parts[3].trim().to_string();
        }
    }
    let scope = rel_path
        .as_deref()
        .map(DiagnosticScope::file)
        .unwrap_or_else(|| DiagnosticScope::command(tool.to_string()));
    Diagnostic {
        source: DiagnosticSource::Formatter,
        scope,
        severity,
        code: Some(tool.to_string()),
        message,
        rel_path,
        start_line,
        end_line: start_line,
        fingerprint: crate::apply_patch::sha1_hex(format!("cleanup:{tool}:{line}").as_bytes()),
        content_hash: None,
        raw_output_id: None,
        snapshot_id: None,
        first_seen_at: None,
        last_seen_at: None,
        resolved_at: None,
    }
}

fn rustfmt_location(root: &Path, line: &str) -> Option<(String, i64)> {
    let location = line.trim_start().strip_prefix("-->")?.trim();
    let mut parts = location.rsplitn(3, ':');
    let _column = parts.next()?;
    let line_number = parts.next()?.parse::<i64>().ok()?.max(1);
    let path = Path::new(parts.next()?.trim());
    let relative = if path.is_absolute() {
        path.strip_prefix(root).ok()?
    } else {
        path
    };
    if !safe_rel_path(relative.to_str()?) {
        return None;
    }
    Some((path_to_slash(relative)?, line_number))
}

fn line_has_explicit_severity(line: &str) -> bool {
    let parts = line.splitn(4, ':').collect::<Vec<_>>();
    parts.len() == 4 && parse_line_severity(parts[2]).is_some()
}

fn parse_line_severity(value: &str) -> Option<DiagnosticSeverity> {
    match value.trim().to_ascii_lowercase().as_str() {
        "error" => Some(DiagnosticSeverity::Error),
        "warning" | "warn" => Some(DiagnosticSeverity::Warning),
        "info" => Some(DiagnosticSeverity::Info),
        "hint" => Some(DiagnosticSeverity::Hint),
        _ => None,
    }
}

fn record_cleanup_snapshot(
    store: &mut LensStore,
    tool: &CleanupToolDefinition,
    process: &ProcessOutput,
    raw_output: &str,
    diagnostics: Vec<Diagnostic>,
) -> Result<Option<DiagnosticSnapshotResult>, Box<dyn std::error::Error>> {
    Ok(Some(store.record_diagnostic_snapshot(
        DiagnosticSnapshotInput {
            source: DiagnosticSource::Formatter,
            scope: DiagnosticScope::command(tool.id.clone()),
            diagnostics,
            raw_output: (!raw_output.is_empty()).then_some(raw_output.to_string()),
            raw_output_max_bytes: None,
            metadata: DiagnosticSnapshotMetadata {
                command: Some(tool.id.clone()),
                exit_code: process.exit_code.map(i64::from),
                duration_ms: Some(process.duration_ms),
            },
        },
    )?))
}

fn detect_mutations(
    tool: &CleanupToolDefinition,
    before: &BTreeMap<String, FileState>,
    after: &BTreeMap<String, FileState>,
) -> Vec<CleanupMutation> {
    after
        .iter()
        .filter_map(|(path, after_state)| {
            let before_state = before.get(path);
            let before_hash = before_state.and_then(|state| state.hash.clone());
            let after_hash = after_state.hash.clone();
            if before_hash == after_hash
                && before_state.is_some_and(|state| state.exists == after_state.exists)
            {
                return None;
            }
            let operation = match (
                before_state.map(|state| state.exists).unwrap_or(false),
                after_state.exists,
            ) {
                (false, true) => "create",
                (true, false) => "delete",
                _ => "modify",
            }
            .to_string();
            Some(CleanupMutation {
                path: path.clone(),
                operation,
                before_hash,
                after_hash,
                tool: tool.id.clone(),
                generated: after_state.generated_companion,
            })
        })
        .collect()
}

fn active_diagnostic_keys(diagnostics: &[Diagnostic]) -> BTreeSet<String> {
    diagnostics.iter().map(diagnostic_key).collect()
}

fn diagnostic_key(diagnostic: &Diagnostic) -> String {
    format!(
        "{:?}:{}:{}:{}",
        diagnostic.source, diagnostic.scope.kind, diagnostic.scope.key, diagnostic.fingerprint
    )
}

fn default_timeout_ms() -> u64 {
    DEFAULT_CLEANUP_TIMEOUT_MS
}

fn default_raw_output_max_bytes() -> usize {
    DEFAULT_CLEANUP_RAW_OUTPUT_MAX_BYTES
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lens::types::LensTouchedFileSource;
    use std::process::Command as StdCommand;

    fn git(cwd: &Path, args: &[&str]) {
        let status = StdCommand::new("git")
            .current_dir(cwd)
            .args(args)
            .env("GIT_AUTHOR_NAME", "ct-test")
            .env("GIT_AUTHOR_EMAIL", "ct-test@example.com")
            .env("GIT_COMMITTER_NAME", "ct-test")
            .env("GIT_COMMITTER_EMAIL", "ct-test@example.com")
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?} failed with {status}");
    }

    fn repo() -> tempfile::TempDir {
        let temp = tempfile::tempdir().unwrap();
        git(temp.path(), &["init", "--initial-branch=main"]);
        git(temp.path(), &["config", "user.name", "ct-test"]);
        git(
            temp.path(),
            &["config", "user.email", "ct-test@example.com"],
        );
        git(temp.path(), &["config", "commit.gpgsign", "false"]);
        std::fs::write(temp.path().join("main.fixture"), "one\n").unwrap();
        git(temp.path(), &["add", "."]);
        git(temp.path(), &["commit", "-m", "init"]);
        temp
    }

    fn registry(tool: CleanupToolDefinition) -> CleanupRegistry {
        CleanupRegistry { tools: vec![tool] }
    }

    #[test]
    fn default_registry_covers_opencode_builtin_formatters() {
        let registry = default_cleanup_registry();
        let ids = registry
            .tools
            .iter()
            .map(|tool| tool.id.as_str())
            .collect::<Vec<_>>();
        for expected in [
            "air",
            "biome",
            "cargofmt",
            "clang-format",
            "cljfmt",
            "dart",
            "dfmt",
            "gleam",
            "gofmt",
            "htmlbeautifier",
            "ktlint",
            "mix",
            "nixfmt",
            "ocamlformat",
            "ormolu",
            "oxfmt",
            "pint",
            "prettier",
            "rubocop",
            "ruff",
            "rustfmt",
            "shfmt",
            "standardrb",
            "terraform",
            "uv",
            "zig",
        ] {
            assert!(ids.contains(&expected), "missing {expected}");
        }
    }

    fn fixture_tool(args: Vec<&str>) -> CleanupToolDefinition {
        CleanupToolDefinition {
            id: "fixture".to_string(),
            command: "sh".to_string(),
            args: args.into_iter().map(str::to_string).collect(),
            extensions: vec!["fixture".to_string()],
            filenames: Vec::new(),
            safety: CleanupSafetyClass::SafeAutoApply,
            mutability: CleanupMutability::Mutates,
            timeout_ms: 5_000,
            parser: CleanupParserBehavior::LineDiagnostics,
            raw_output_max_bytes: 128,
            purpose: "fixture".to_string(),
            install_hint: "fixture hint".to_string(),
        }
    }

    fn record_touch(store: &mut LensStore, root: &Path, path: &str) {
        let event = crate::lens::LensTurnEvent {
            schema_version: crate::lens::types::LENS_TURN_EVENT_SCHEMA_VERSION.to_string(),
            session: "s".to_string(),
            turn: "t".to_string(),
            host: "test".to_string(),
            cwd: root.display().to_string(),
            event: crate::lens::LensTurnEventKind::ToolEnd,
            tool: "edit".to_string(),
            phase: crate::lens::LensToolEventPhase::PostTool,
            status: Some("success".to_string()),
            files: Vec::new(),
            policy: Default::default(),
        };
        store
            .record_turn_event(
                &event,
                &[LensTouchedFile {
                    path: path.to_string(),
                    operation: "modify".to_string(),
                    start_line: None,
                    end_line: None,
                    tool: "edit".to_string(),
                    source: LensTouchedFileSource::StructuredEvent,
                    explicit: true,
                    ignored: false,
                    generated: false,
                }],
            )
            .unwrap();
    }

    #[test]
    fn registry_safety_suggests_invasive_without_running() {
        let temp = repo();
        let mut store = LensStore::open_for_project(temp.path()).unwrap();
        record_touch(&mut store, temp.path(), "main.fixture");
        let mut tool = fixture_tool(vec!["-c", "exit 9", "fixture", "{files}"]);
        tool.safety = CleanupSafetyClass::Invasive;

        let report = run_turn_cleanup_with_store(
            temp.path(),
            &mut store,
            "s",
            "t",
            CleanupOptions {
                allow_unsafe: false,
                registry: Some(registry(tool)),
            },
        )
        .unwrap();

        assert!(report.runs.is_empty());
        assert_eq!(report.suggestions.len(), 1);
        assert_eq!(report.suggestions[0].safety, CleanupSafetyClass::Invasive);
    }

    #[test]
    fn cleanup_is_scoped_to_touched_files_and_generated_companions() {
        let temp = repo();
        std::fs::write(temp.path().join("main.generated.fixture"), "generated\n").unwrap();
        std::fs::write(temp.path().join("other.fixture"), "other\n").unwrap();
        let mut store = LensStore::open_for_project(temp.path()).unwrap();
        record_touch(&mut store, temp.path(), "main.fixture");
        let tool = fixture_tool(vec![
            "-c",
            "for f do printf 'cleaned:%s\n' \"$f\" >> \"$f\"; done",
            "fixture",
            "{files}",
        ]);

        let report = run_turn_cleanup_with_store(
            temp.path(),
            &mut store,
            "s",
            "t",
            CleanupOptions {
                registry: Some(registry(tool)),
                ..CleanupOptions::default()
            },
        )
        .unwrap();

        assert_eq!(report.runs.len(), 1);
        assert!(report.runs[0].files.contains(&"main.fixture".to_string()));
        assert!(
            report.runs[0]
                .files
                .contains(&"main.generated.fixture".to_string())
        );
        assert!(!report.runs[0].files.contains(&"other.fixture".to_string()));
        assert!(
            std::fs::read_to_string(temp.path().join("main.fixture"))
                .unwrap()
                .contains("cleaned:main.fixture")
        );
        assert!(
            std::fs::read_to_string(temp.path().join("main.generated.fixture"))
                .unwrap()
                .contains("cleaned:main.generated.fixture")
        );
        assert!(
            !std::fs::read_to_string(temp.path().join("other.fixture"))
                .unwrap()
                .contains("cleaned")
        );
        assert_eq!(report.mutation_count, 2);
        assert!(report.mutations.iter().any(|mutation| mutation.generated));
    }

    #[test]
    fn cleanup_timeout_records_diagnostic_regression() {
        let temp = repo();
        let mut store = LensStore::open_for_project(temp.path()).unwrap();
        record_touch(&mut store, temp.path(), "main.fixture");
        let mut tool = fixture_tool(vec!["-c", "sleep 1", "fixture", "{files}"]);
        tool.timeout_ms = 10;

        let report = run_turn_cleanup_with_store(
            temp.path(),
            &mut store,
            "s",
            "t",
            CleanupOptions {
                registry: Some(registry(tool)),
                ..CleanupOptions::default()
            },
        )
        .unwrap();

        assert_eq!(report.runs[0].status, CleanupRunStatus::TimedOut);
        assert!(report.runs[0].timed_out);
        assert_eq!(report.diagnostics.regression_count, 1);
    }

    #[test]
    fn cleanup_parses_rustfmt_absolute_locations() {
        let temp = repo();
        let root = temp.path().canonicalize().unwrap();
        std::fs::create_dir_all(temp.path().join("src")).unwrap();
        std::fs::write(temp.path().join("src/main.rs"), "fn main() {}\n").unwrap();
        let process = ProcessOutput {
            status: CleanupRunStatus::Failed,
            exit_code: Some(1),
            timed_out: false,
            duration_ms: 1,
            stdout: CappedBytes {
                bytes: Vec::new(),
                original_bytes: 0,
                truncated: false,
            },
            stderr: CappedBytes {
                bytes: Vec::new(),
                original_bytes: 0,
                truncated: false,
            },
        };

        let diagnostics = diagnostics_from_output(
            &root,
            &fixture_tool(Vec::new()),
            &process,
            &format!(
                "error: expected expression, found `;`\n --> {}:2:18\n  |\n2 |     let broken = ;\n",
                root.join("src/main.rs").display()
            ),
        );

        let diagnostic = diagnostics
            .iter()
            .find(|diagnostic| diagnostic.rel_path.as_deref() == Some("src/main.rs"))
            .unwrap();
        assert_eq!(diagnostic.start_line, Some(2));
        assert_eq!(diagnostic.severity, DiagnosticSeverity::Error);
    }

    #[test]
    fn successful_cleanup_clears_prior_formatter_diagnostics() {
        let temp = repo();
        let mut store = LensStore::open_for_project(temp.path()).unwrap();
        store
            .record_diagnostic_snapshot(DiagnosticSnapshotInput {
                source: DiagnosticSource::Formatter,
                scope: DiagnosticScope::command("fixture"),
                diagnostics: vec![Diagnostic {
                    source: DiagnosticSource::Formatter,
                    scope: DiagnosticScope::command("fixture"),
                    severity: DiagnosticSeverity::Error,
                    code: Some("fixture".to_string()),
                    message: "stale formatter failure".to_string(),
                    rel_path: None,
                    start_line: None,
                    end_line: None,
                    fingerprint: "stale-formatter-failure".to_string(),
                    content_hash: None,
                    raw_output_id: None,
                    snapshot_id: None,
                    first_seen_at: None,
                    last_seen_at: None,
                    resolved_at: None,
                }],
                raw_output: Some("failed".to_string()),
                raw_output_max_bytes: None,
                metadata: Default::default(),
            })
            .unwrap();
        record_touch(&mut store, temp.path(), "main.fixture");
        let tool = fixture_tool(vec!["-c", "exit 0", "fixture", "{files}"]);

        let report = run_turn_cleanup_with_store(
            temp.path(),
            &mut store,
            "s",
            "t",
            CleanupOptions {
                registry: Some(registry(tool)),
                ..CleanupOptions::default()
            },
        )
        .unwrap();

        assert_eq!(report.runs[0].status, CleanupRunStatus::Success);
        assert_eq!(report.diagnostics.post_cleanup.diagnostic_count, 0);
    }

    #[test]
    fn raw_output_is_capped() {
        let temp = repo();
        let mut store = LensStore::open_for_project(temp.path()).unwrap();
        record_touch(&mut store, temp.path(), "main.fixture");
        let mut tool = fixture_tool(vec!["-c", "printf '%*s' 512 x", "fixture", "{files}"]);
        tool.raw_output_max_bytes = 32;

        let report = run_turn_cleanup_with_store(
            temp.path(),
            &mut store,
            "s",
            "t",
            CleanupOptions {
                registry: Some(registry(tool)),
                ..CleanupOptions::default()
            },
        )
        .unwrap();

        assert!(report.runs[0].raw_output_truncated);
        assert!(report.runs[0].raw_output_retained_bytes <= 32);
        assert!(report.runs[0].raw_output_original_bytes >= 512);
    }

    #[test]
    fn cleanup_output_reports_regressions_after_cleanup() {
        let temp = repo();
        let mut store = LensStore::open_for_project(temp.path()).unwrap();
        record_touch(&mut store, temp.path(), "main.fixture");
        let tool = fixture_tool(vec![
            "-c",
            "echo 'main.fixture:1:error:boom' >&2; exit 1",
            "fixture",
            "{files}",
        ]);

        let report = run_turn_cleanup_with_store(
            temp.path(),
            &mut store,
            "s",
            "t",
            CleanupOptions {
                registry: Some(registry(tool)),
                ..CleanupOptions::default()
            },
        )
        .unwrap();

        assert_eq!(report.runs[0].status, CleanupRunStatus::Failed);
        assert_eq!(report.diagnostics.regression_count, 1);
        assert_eq!(
            report.diagnostics.regressions[0].rel_path.as_deref(),
            Some("main.fixture")
        );
        assert_eq!(
            report.diagnostics.regressions[0].severity,
            DiagnosticSeverity::Error
        );
    }
}
