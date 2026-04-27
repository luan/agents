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
    Formatter,
    Autofix,
    Test,
    Other(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Diagnostic {
    pub source: DiagnosticSource,
    pub severity: DiagnosticSeverity,
    pub code: Option<String>,
    pub message: String,
    pub rel_path: Option<String>,
    pub start_line: Option<i64>,
    pub end_line: Option<i64>,
    pub fingerprint: String,
    pub content_hash: Option<String>,
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
pub enum LensTurnEventKind {
    TurnStart,
    ToolStart,
    ToolEnd,
    TurnEnd,
}

impl Default for LensTurnEventKind {
    fn default() -> Self {
        Self::ToolEnd
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LensToolEventPhase {
    PreTool,
    PostTool,
}

impl Default for LensToolEventPhase {
    fn default() -> Self {
        Self::PostTool
    }
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
}

fn default_turn_event_schema() -> String {
    LENS_TURN_EVENT_SCHEMA_VERSION.to_string()
}

fn default_touch_operation() -> String {
    "modify".to_string()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadCoverageRange {
    pub start_line: i64,
    pub end_line: i64,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GuardAction {
    Allow,
    Warn,
    Block,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GuardReason {
    Covered,
    ZeroRead,
    StaleRead,
    OutOfRange,
    NewFile,
    GeneratedOrPlaintext,
    ExplicitOverride,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GuardDecision {
    pub decision: GuardAction,
    pub reason: GuardReason,
    pub file: String,
    pub required_ranges: Vec<ReadCoverageRange>,
    pub covered_ranges: Vec<ReadCoverageRange>,
}
