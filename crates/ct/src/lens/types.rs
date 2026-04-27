use serde::{Deserialize, Serialize};

pub const LENS_TURN_EVENT_SCHEMA_VERSION: &str = "lens.turn_event.v1";

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ProjectId(pub String);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct FileId(pub i64);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SessionId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileSnapshot {
    pub rel_path: String,
    pub language: Option<String>,
    pub hash: Option<String>,
    pub mtime_ns: Option<i64>,
    pub size_bytes: Option<i64>,
    pub line_count: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticSeverity {
    Error,
    Warning,
    Info,
    Hint,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticSource {
    Lsp,
    AstGrep,
    TreeSitter,
    Secrets,
    Security,
    Formatter,
    Autofix,
    Test,
    Other(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Diagnostic {
    pub source: DiagnosticSource,
    #[serde(default)]
    pub scope: DiagnosticScope,
    pub severity: DiagnosticSeverity,
    pub code: Option<String>,
    pub message: String,
    pub rel_path: Option<String>,
    pub start_line: Option<i64>,
    pub end_line: Option<i64>,
    pub fingerprint: String,
    pub content_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_output_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_seen_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_seen_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct DiagnosticScope {
    pub kind: String,
    pub key: String,
}

impl DiagnosticScope {
    pub fn workspace() -> Self {
        Self {
            kind: "workspace".to_string(),
            key: String::new(),
        }
    }

    pub fn file(path: impl Into<String>) -> Self {
        Self {
            kind: "file".to_string(),
            key: path.into(),
        }
    }

    pub fn command(command: impl Into<String>) -> Self {
        Self {
            kind: "command".to_string(),
            key: command.into(),
        }
    }

    pub fn check(name: impl Into<String>) -> Self {
        Self {
            kind: "check".to_string(),
            key: name.into(),
        }
    }

    pub fn scanner(name: impl Into<String>) -> Self {
        Self {
            kind: "scanner".to_string(),
            key: name.into(),
        }
    }
}

impl Default for DiagnosticScope {
    fn default() -> Self {
        Self::workspace()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticDeltaStatus {
    New,
    Resolved,
    Unchanged,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct DiagnosticSnapshotMetadata {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiagnosticSnapshotInput {
    pub source: DiagnosticSource,
    #[serde(default)]
    pub scope: DiagnosticScope,
    #[serde(default)]
    pub diagnostics: Vec<Diagnostic>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_output: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_output_max_bytes: Option<usize>,
    #[serde(default)]
    pub metadata: DiagnosticSnapshotMetadata,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawOutputRef {
    pub id: i64,
    pub original_bytes: i64,
    pub retained_bytes: i64,
    pub truncated: bool,
    pub redacted: bool,
    pub expires_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiagnosticDeltaSet {
    pub new: Vec<Diagnostic>,
    pub resolved: Vec<Diagnostic>,
    pub unchanged: Vec<Diagnostic>,
}

impl DiagnosticDeltaSet {
    pub fn empty() -> Self {
        Self {
            new: Vec::new(),
            resolved: Vec::new(),
            unchanged: Vec::new(),
        }
    }

    pub fn count(&self) -> usize {
        self.new.len() + self.resolved.len() + self.unchanged.len()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiagnosticSnapshotResult {
    pub project_id: i64,
    pub snapshot_id: i64,
    pub source: DiagnosticSource,
    pub scope: DiagnosticScope,
    pub raw_output: Option<RawOutputRef>,
    pub diagnostic_count: usize,
    pub deltas: DiagnosticDeltaSet,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiagnosticRelevance {
    pub changed_files: Vec<String>,
    pub all: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiagnosticListData {
    pub project_id: i64,
    pub path: Option<String>,
    pub diagnostics: Vec<Diagnostic>,
    pub diagnostic_count: usize,
    pub deltas: DiagnosticDeltaSet,
    pub delta_count: usize,
    pub relevance: DiagnosticRelevance,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolRunSummary {
    pub tool: String,
    pub status: String,
    pub file_count: usize,
    pub diagnostic_count: usize,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum LensTurnEventKind {
    TurnStart,
    ToolStart,
    #[default]
    ToolEnd,
    TurnEnd,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum LensToolEventPhase {
    PreTool,
    #[default]
    PostTool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LensTurnEventPolicy {
    pub git_fallback: bool,
    pub include_ignored: bool,
}

impl Default for LensTurnEventPolicy {
    fn default() -> Self {
        Self {
            git_fallback: true,
            include_ignored: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LensTouchedFileInput {
    pub path: String,
    #[serde(default = "default_touch_operation")]
    pub operation: String,
    #[serde(default)]
    pub start_line: Option<i64>,
    #[serde(default)]
    pub end_line: Option<i64>,
    #[serde(default)]
    pub generated: bool,
    #[serde(default)]
    pub include_ignored: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LensTurnEvent {
    #[serde(default = "default_turn_event_schema")]
    pub schema_version: String,
    #[serde(alias = "session_id")]
    pub session: String,
    #[serde(alias = "turn_id")]
    pub turn: String,
    pub host: String,
    pub cwd: String,
    #[serde(default)]
    pub event: LensTurnEventKind,
    pub tool: String,
    #[serde(default)]
    pub phase: LensToolEventPhase,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub files: Vec<LensTouchedFileInput>,
    #[serde(default)]
    pub policy: LensTurnEventPolicy,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LensTouchedFileSource {
    StructuredEvent,
    GitStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LensTouchedFile {
    pub path: String,
    pub operation: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_line: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_line: Option<i64>,
    pub tool: String,
    pub source: LensTouchedFileSource,
    pub explicit: bool,
    pub ignored: bool,
    pub generated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LensTurnTouchedData {
    pub project_id: i64,
    pub session: String,
    pub turn: String,
    pub files: Vec<LensTouchedFile>,
    pub file_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LensTurnRecordData {
    pub project_id: i64,
    pub session: String,
    pub turn: String,
    pub host: String,
    pub cwd: String,
    pub tool: String,
    pub event: LensTurnEventKind,
    pub phase: LensToolEventPhase,
    pub git_fallback_used: bool,
    pub files: Vec<LensTouchedFile>,
    pub file_count: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cleanup: Option<super::cleanup::CleanupReport>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checks: Option<super::checks::LensChecksData>,
}

fn default_turn_event_schema() -> String {
    LENS_TURN_EVENT_SCHEMA_VERSION.to_string()
}

fn default_touch_operation() -> String {
    "modify".to_string()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PatchHunkRecord {
    pub old_start: Option<i64>,
    pub old_end: Option<i64>,
    pub new_start: Option<i64>,
    pub new_end: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PatchDraftSummary {
    pub id: String,
    pub status: String,
    pub patch_sha: String,
    pub body_bytes: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PatchDraftChunk {
    pub chunk_index: i64,
    pub file_path: String,
    pub change_type: String,
    pub status: String,
    pub old_start: Option<i64>,
    pub old_end: Option<i64>,
    pub new_start: Option<i64>,
    pub new_end: Option<i64>,
    pub error_kind: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PatchRepairSymbol {
    pub name: String,
    pub kind: String,
    pub start_line: i64,
    pub end_line: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PatchCandidate {
    pub chunk_index: i64,
    pub line: i64,
    pub suggested_anchor: Option<String>,
    pub enclosing_symbol: Option<String>,
    pub enclosing_kind: Option<String>,
    pub symbol_start: Option<i64>,
    pub symbol_end: Option<i64>,
    pub candidate_kind: String,
    pub symbol: Option<PatchRepairSymbol>,
    pub anchors: Vec<String>,
    pub confidence: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AffectedSymbol {
    pub file_path: String,
    pub symbol_name: Option<String>,
    pub symbol_kind: Option<String>,
    pub old_start: Option<i64>,
    pub old_end: Option<i64>,
    pub new_start: Option<i64>,
    pub new_end: Option<i64>,
}
