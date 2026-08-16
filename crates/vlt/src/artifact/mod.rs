use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process;
use std::time::SystemTime;

use rmcp::schemars;
use serde::{Deserialize, Serialize};

mod archive;
mod crud;
mod listing;

#[cfg(test)]
pub(crate) static CT_BLUEPRINTS_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub use archive::{archive, cmd_archive, cmd_archive_batch};
pub use crud::{
    CreateOpts, cmd_read_resolved, cmd_rename, cmd_retag, create, read, resolve_artifact_path,
    resolve_optional_kind, resolve_stem_universal,
};
pub use listing::{
    list_all_archived_artifacts, list_all_artifacts, list_archived_artifacts, list_artifacts,
};

pub(crate) fn fatal(msg: &str) -> ! {
    eprintln!("artifact: {msg}");
    process::exit(1);
}

pub(crate) fn home_dir() -> String {
    env::var("HOME")
        .or_else(|_| env::var("USERPROFILE"))
        .unwrap_or_else(|_| fatal("cannot determine home directory"))
}

// ---------------------------------------------------------------------------
// ArtifactKind
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ArtifactKind {
    Design,
    Plan,
    Research,
    Structure,
    Doc,
    Custom(String),
}

/// Priority order for universal stem resolution.
pub const ALL_KINDS: [ArtifactKind; 5] = [
    ArtifactKind::Doc,
    ArtifactKind::Design,
    ArtifactKind::Structure,
    ArtifactKind::Plan,
    ArtifactKind::Research,
];

impl ArtifactKind {
    pub fn dir_name(&self) -> &str {
        match self {
            Self::Design => "design",
            Self::Plan => "plan",
            Self::Research => "research",
            Self::Structure => "structure",
            Self::Doc => "docs",
            Self::Custom(name) => name,
        }
    }

    pub fn from_dir_name(name: &str) -> Option<Self> {
        match name {
            "design" => Some(Self::Design),
            "plan" => Some(Self::Plan),
            "research" => Some(Self::Research),
            "structure" => Some(Self::Structure),
            "doc" | "docs" => Some(Self::Doc),
            other if validate_type_name(other).is_ok() => Some(Self::Custom(other.to_string())),
            _ => None,
        }
    }

    /// Singular name used in commit messages ("doc" not "docs").
    pub fn commit_name(&self) -> &str {
        match self {
            Self::Design => "design",
            Self::Plan => "plan",
            Self::Research => "research",
            Self::Structure => "structure",
            Self::Doc => "doc",
            Self::Custom(name) => name,
        }
    }
}

impl Serialize for ArtifactKind {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.dir_name())
    }
}

// ---------------------------------------------------------------------------
// Artifact struct
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct Artifact {
    pub name: String,
    pub path: PathBuf,
    pub title: String,
    #[serde(serialize_with = "serialize_project_name")]
    pub project: String,
    #[serde(rename = "modified", serialize_with = "serialize_mod_time")]
    pub mod_time: SystemTime,
    #[serde(serialize_with = "serialize_size")]
    pub size: u64,
    pub created: Option<String>,
    pub source: Option<String>,
    pub tags: Vec<String>,
    pub author: Option<String>,
}

fn serialize_mod_time<S: serde::Serializer>(t: &SystemTime, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&format_date(*t))
}

fn serialize_size<S: serde::Serializer>(b: &u64, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&format_size(*b))
}

fn serialize_project_name<S: serde::Serializer>(p: &str, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&project_name(p))
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/// Git sync failure — distinguishes add/commit (hard) from push (partial success).
#[derive(Debug)]
pub enum SyncError {
    Add(String),
    Commit(String),
    Push(String),
}

impl std::fmt::Display for SyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Add(msg) => write!(f, "git add failed: {msg}"),
            Self::Commit(msg) => write!(f, "git commit failed: {msg}"),
            Self::Push(msg) => write!(f, "git push failed: {msg}"),
        }
    }
}

impl std::error::Error for SyncError {}

/// Stem resolution failure — either nothing matched or multiple candidates did.
#[derive(Debug)]
pub enum ResolveError {
    NotFound(String),
    Ambiguous(Vec<PathBuf>),
}

impl std::fmt::Display for ResolveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound(arg) => write!(f, "artifact not found: {arg}"),
            Self::Ambiguous(matches) => {
                let list: Vec<_> = matches.iter().map(|m| m.display().to_string()).collect();
                write!(f, "ambiguous stem, matches:\n  {}", list.join("\n  "))
            }
        }
    }
}

impl std::error::Error for ResolveError {}

/// Unified error type for library-level vault operations.
#[derive(Debug)]
pub enum CtError {
    Sync(SyncError),
    Resolve(ResolveError),
    Io(std::io::Error),
    Validation(String),
}

impl std::fmt::Display for CtError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Sync(e) => write!(f, "{e}"),
            Self::Resolve(e) => write!(f, "{e}"),
            Self::Io(e) => write!(f, "{e}"),
            Self::Validation(msg) => write!(f, "{msg}"),
        }
    }
}

impl std::error::Error for CtError {}

impl From<SyncError> for CtError {
    fn from(e: SyncError) -> Self {
        Self::Sync(e)
    }
}

impl From<std::io::Error> for CtError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}

impl From<ResolveError> for CtError {
    fn from(e: ResolveError) -> Self {
        Self::Resolve(e)
    }
}

// ---------------------------------------------------------------------------
// Blueprints directory
// ---------------------------------------------------------------------------

/// Returns the blueprints vault directory or fatal if it doesn't exist.
pub fn blueprints_dir() -> PathBuf {
    let dir = blueprints_dir_unchecked();
    if !dir.is_dir() {
        fatal(&format!(
            "{} does not exist. Create the blueprints directory first.",
            dir.display()
        ));
    }
    dir
}

/// Non-panicking variant for server contexts where `fatal()` would kill the
/// whole MCP server mid-request.
pub fn blueprints_dir_checked() -> Result<PathBuf, CtError> {
    let dir = blueprints_dir_unchecked();
    if !dir.is_dir() {
        return Err(CtError::Validation(format!(
            "blueprints directory missing: {}. Create the blueprints directory first.",
            dir.display()
        )));
    }
    Ok(dir)
}

pub fn blueprints_dir_unchecked() -> PathBuf {
    if let Ok(custom) = env::var("CT_BLUEPRINTS_DIR") {
        return PathBuf::from(custom);
    }
    Path::new(&home_dir()).join("blueprints")
}

/// Assert that `p` resides inside the vault. Canonicalizes both the path and
/// the vault root before comparing so `..` components and symlinks are resolved.
pub(crate) fn ensure_in_vault(p: &Path) -> Result<PathBuf, ResolveError> {
    canonicalize_in_vault(p).map(|_| p.to_path_buf())
}

/// Shared canonicalization helper — returns both the canonicalized target and
/// the canonicalized vault root.
pub(crate) fn canonicalize_in_vault(p: &Path) -> Result<(PathBuf, PathBuf), ResolveError> {
    let bp = blueprints_dir_unchecked();
    let bp_canon = bp
        .canonicalize()
        .map_err(|_| ResolveError::NotFound(p.display().to_string()))?;
    let p_canon = p
        .canonicalize()
        .map_err(|_| ResolveError::NotFound(p.display().to_string()))?;
    if p_canon.starts_with(&bp_canon) {
        Ok((p_canon, bp_canon))
    } else {
        Err(ResolveError::NotFound(p.display().to_string()))
    }
}

/// Returns <vault>/<project>/<kind>/
pub fn artifact_dir(project_path: &str, kind: ArtifactKind) -> PathBuf {
    let bp = blueprints_dir();
    let name = project_name(project_path);
    bp.join(name).join(kind.dir_name())
}

/// Infer the artifact kind from the directory just above the file
/// (e.g. `<project>/research/foo.md` → `Research`). Returns None when the
/// containing directory is `dive/` (still a Research) or unrecognized.
pub fn infer_kind_from_path(path: &Path) -> Option<ArtifactKind> {
    let parent = path.parent()?;
    let name = parent.file_name()?.to_str()?;
    if name == "dive" {
        return Some(ArtifactKind::Research);
    }
    ArtifactKind::from_dir_name(name)
}

/// Test helper: artifact dir with custom base.
#[cfg(test)]
pub fn artifact_dir_with_base(project_path: &str, kind: &str, base: &Path) -> PathBuf {
    let name = project_name(project_path);
    base.join(name).join(kind)
}

// ---------------------------------------------------------------------------
// Project paths
// ---------------------------------------------------------------------------

/// Strip the stable numeric id or legacy date prefix from an artifact stem.
pub fn strip_artifact_prefix(stem: &str) -> &str {
    if stem.len() >= 6
        && stem.as_bytes()[0..4].iter().all(|b| b.is_ascii_digit())
        && stem.as_bytes()[4] == b'-'
    {
        &stem[5..]
    } else if stem.len() > 12
        && stem.as_bytes()[..8].iter().all(|b| b.is_ascii_digit())
        && stem.as_bytes()[8] == b'-'
        && stem.as_bytes()[9..11].iter().all(|b| b.is_ascii_digit())
        && stem.as_bytes()[11] == b'-'
    {
        &stem[12..]
    } else if stem.len() > 9
        && stem.as_bytes()[..8].iter().all(|b| b.is_ascii_digit())
        && stem.as_bytes()[8] == b'-'
    {
        &stem[9..]
    } else {
        stem
    }
}

pub fn strip_date_prefix(stem: &str) -> &str {
    strip_artifact_prefix(stem)
}

/// If `toplevel` is a git worktree, return the main repo root instead.
pub fn resolve_repo_root(toplevel: &str) -> String {
    let common = process::Command::new("git")
        .args(["-C", toplevel, "rev-parse", "--git-common-dir"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());

    if let Some(ref common_dir) = common {
        let p = Path::new(common_dir);
        if p.is_absolute() {
            let fname = p.file_name().unwrap_or_default().to_string_lossy();
            if fname == ".git" {
                return p.parent().unwrap().to_string_lossy().to_string();
            }
            return p.to_string_lossy().to_string();
        }
    }
    toplevel.to_string()
}

/// Auto-detect the current project from cwd.
pub fn current_project() -> String {
    let output = process::Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .output();
    if let Ok(o) = output
        && o.status.success()
    {
        return resolve_repo_root(String::from_utf8_lossy(&o.stdout).trim());
    }
    env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| fatal("cannot determine working directory"))
}

pub fn project_name(project_path: &str) -> String {
    if project_path.is_empty() {
        return String::from("(no project)");
    }
    let path = Path::new(project_path);
    let components: Vec<&str> = path
        .components()
        .filter_map(|c| c.as_os_str().to_str())
        .collect();

    for comp in &components {
        if comp.ends_with(".git") {
            // All worktrees of a repo share the same project name
            let name = comp.strip_suffix(".git").unwrap_or(comp);
            return name.replace('.', "_");
        }
    }

    let name = path
        .file_name()
        .map(|f| f.to_string_lossy().into_owned())
        .unwrap_or_else(|| project_path.to_string());
    // Dots break Obsidian wiki-links and tag rendering
    name.replace('.', "_")
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

pub fn validate_tag(tag: &str) -> Result<(), CtError> {
    if tag.is_empty() {
        return Err(CtError::Validation("tag is empty".to_string()));
    }
    if tag != tag.trim() {
        return Err(CtError::Validation(format!(
            "tag {tag:?} has leading/trailing whitespace"
        )));
    }
    for ch in tag.chars() {
        if ch == '\n' || ch == '\r' {
            return Err(CtError::Validation(format!(
                "tag {tag:?} contains a line break"
            )));
        }
        if ch.is_control() && ch != '\t' {
            return Err(CtError::Validation(format!(
                "tag {tag:?} contains a control character"
            )));
        }
    }
    if tag.contains("---") {
        return Err(CtError::Validation(format!(
            "tag {tag:?} contains a YAML document separator"
        )));
    }
    Ok(())
}

pub fn validate_project_name(name: &str) -> Result<(), CtError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(CtError::Validation("project name is empty".to_string()));
    }
    if trimmed == "." || trimmed == ".." {
        return Err(CtError::Validation(format!(
            "project name {trimmed:?} is not a valid vault subdirectory"
        )));
    }
    for ch in trimmed.chars() {
        if ch == '/' || ch == '\\' || ch == '\0' || ch.is_control() {
            return Err(CtError::Validation(format!(
                "project name {trimmed:?} contains a path separator or control character"
            )));
        }
    }
    Ok(())
}

pub fn validate_type_name(name: &str) -> Result<(), CtError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(CtError::Validation("artifact type is empty".to_string()));
    }
    if trimmed == "all" || trimmed == "archive" || trimmed == "." || trimmed == ".." {
        return Err(CtError::Validation(format!(
            "artifact type {trimmed:?} is reserved"
        )));
    }
    for ch in trimmed.chars() {
        if ch == '/' || ch == '\\' || ch == '\0' || ch.is_control() {
            return Err(CtError::Validation(format!(
                "artifact type {trimmed:?} contains a path separator or control character"
            )));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// YAML / frontmatter parsing
// ---------------------------------------------------------------------------

pub fn yaml_quote(s: &str) -> String {
    if s.contains(':')
        || s.contains('{')
        || s.contains('}')
        || s.contains('[')
        || s.contains(']')
        || s.contains('&')
        || s.contains('*')
        || s.contains('?')
        || s.contains('|')
        || s.contains('>')
        || s.contains('!')
        || s.contains('%')
        || s.contains('@')
        || s.contains('`')
        || s.contains('#')
        || s.contains(',')
        || s.contains('"')
        || s.contains('\'')
        || s.contains('\n')
        || s.contains('\\')
        || s.starts_with(' ')
        || s.ends_with(' ')
    {
        let escaped = s.replace('\\', "\\\\").replace('"', "\\\"");
        format!("\"{escaped}\"")
    } else {
        s.to_string()
    }
}

pub fn parse_frontmatter(content: &str) -> (Option<&str>, &str) {
    let delim = "---\n";
    if !content.starts_with(delim) {
        return (None, content);
    }

    let rest = &content[delim.len()..];
    if let Some(end) = rest.find("\n---\n") {
        let yaml = &rest[..end];
        let body = &rest[end + 5..];
        (Some(yaml), body)
    } else if let Some(yaml) = rest.strip_suffix("\n---") {
        (Some(yaml), "")
    } else {
        (None, content)
    }
}

pub fn parse_yaml_map(yaml: &str) -> Vec<(String, String)> {
    yaml.lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            let idx = line.find(':')?;
            let key = line[..idx].trim().to_string();
            let mut val = line[idx + 1..].trim().to_string();
            if val.len() >= 2
                && ((val.starts_with('"') && val.ends_with('"'))
                    || (val.starts_with('\'') && val.ends_with('\'')))
            {
                val = val[1..val.len() - 1].to_string();
                val = val.replace("\\\"", "\"").replace("\\\\", "\\");
            }
            Some((key, val))
        })
        .collect()
}

pub(crate) fn strip_yaml_quotes(s: &str) -> String {
    let trimmed = s.trim();
    if trimmed.len() >= 2
        && ((trimmed.starts_with('"') && trimmed.ends_with('"'))
            || (trimmed.starts_with('\'') && trimmed.ends_with('\'')))
    {
        let inner = &trimmed[1..trimmed.len() - 1];
        inner.replace("\\\"", "\"").replace("\\\\", "\\")
    } else {
        trimmed.to_string()
    }
}

/// Parse the standard frontmatter fields out of an already-isolated YAML slice.
pub(crate) fn parse_frontmatter_fields(
    yaml: &str,
) -> (
    String,
    String,
    Option<String>,
    Option<String>,
    Vec<String>,
    Option<String>,
) {
    let mut title = String::new();
    let mut project = String::new();
    let mut created = None;
    let mut source = None;
    let mut tags = Vec::new();
    let mut author = None;
    let mut in_tags = false;

    for line in yaml.lines() {
        let trimmed = line.trim();

        if in_tags {
            if let Some(item) = trimmed.strip_prefix("- ") {
                tags.push(strip_yaml_quotes(item));
                continue;
            }
            in_tags = false;
        }

        if let Some(val) = trimmed.strip_prefix("topic:") {
            title = strip_yaml_quotes(val);
        } else if let Some(val) = trimmed.strip_prefix("project:") {
            project = strip_yaml_quotes(val);
        } else if let Some(val) = trimmed.strip_prefix("created:") {
            let v = strip_yaml_quotes(val);
            if !v.is_empty() {
                created = Some(v);
            }
        } else if let Some(val) = trimmed.strip_prefix("source:") {
            let v = strip_yaml_quotes(val);
            if !v.is_empty() {
                let stripped = v.trim_start_matches("[[").trim_end_matches("]]");
                source = Some(stripped.to_string());
            }
        } else if let Some(val) = trimmed.strip_prefix("tags:") {
            if val.trim().is_empty() {
                in_tags = true;
            }
        } else if let Some(val) = trimmed.strip_prefix("author:") {
            let v = strip_yaml_quotes(val);
            if !v.is_empty() {
                author = Some(v);
            }
        }
    }
    (title, project, created, source, tags, author)
}

/// Full frontmatter extraction from string: falls back to H1 when no `topic:` set.
pub(crate) fn extract_frontmatter_full_from_str(
    content: &str,
) -> (
    String,
    String,
    Option<String>,
    Option<String>,
    Vec<String>,
    Option<String>,
) {
    let (yaml, body) = parse_frontmatter(content);
    let (mut title, project, created, source, tags, author) = match yaml {
        Some(y) => parse_frontmatter_fields(y),
        None => (String::new(), String::new(), None, None, Vec::new(), None),
    };
    if title.is_empty() {
        for line in body.lines() {
            let trimmed = line.trim();
            if let Some(t) = trimmed.strip_prefix("# ") {
                title = t.to_string();
                break;
            }
        }
    }
    (title, project, created, source, tags, author)
}

/// 16 KiB header read for bounded frontmatter parsing — any real frontmatter +
/// H1 title fits well under this.
const HEADER_READ_CAP: u64 = 16 * 1024;

pub(crate) fn read_frontmatter_prefix(path: &Path) -> Option<String> {
    use std::io::Read;
    let f = fs::File::open(path).ok()?;
    let mut buf = Vec::with_capacity(HEADER_READ_CAP as usize);
    f.take(HEADER_READ_CAP).read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

pub(crate) fn extract_frontmatter_full(
    path: &Path,
) -> (
    String,
    String,
    Option<String>,
    Option<String>,
    Vec<String>,
    Option<String>,
) {
    match read_frontmatter_prefix(path) {
        Some(content) => extract_frontmatter_full_from_str(&content),
        None => (String::new(), String::new(), None, None, Vec::new(), None),
    }
}

// ---------------------------------------------------------------------------
// Date + size formatting
// ---------------------------------------------------------------------------

struct DateTime {
    year: i64,
    month: u32,
    day: u32,
    hours: u32,
    minutes: u32,
    seconds: u32,
}

fn now_utc() -> DateTime {
    let duration = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = duration.as_secs();

    let mut days = (secs / 86400) as i64;
    let day_secs = (secs % 86400) as u32;

    days += 719468;
    let era = if days >= 0 { days } else { days - 146096 } / 146097;
    let doe = (days - era * 146097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };

    DateTime {
        year: if m <= 2 { y + 1 } else { y },
        month: m,
        day: d,
        hours: day_secs / 3600,
        minutes: (day_secs % 3600) / 60,
        seconds: day_secs % 60,
    }
}

pub fn chrono_rfc3339() -> String {
    let dt = now_utc();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        dt.year, dt.month, dt.day, dt.hours, dt.minutes, dt.seconds
    )
}

pub fn format_size(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{bytes}B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1}K", bytes as f64 / 1024.0)
    } else {
        format!("{:.1}M", bytes as f64 / (1024.0 * 1024.0))
    }
}

pub fn format_date(time: SystemTime) -> String {
    let duration = time
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = duration.as_secs() as i64;

    let days = secs / 86400;
    let mut y = 1970i32;
    let mut remaining_days = days;

    loop {
        let days_in_year = if is_leap(y) { 366 } else { 365 };
        if remaining_days < days_in_year {
            break;
        }
        remaining_days -= days_in_year;
        y += 1;
    }

    let months_days: &[i64] = if is_leap(y) {
        &[31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        &[31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };

    let mut m = 0;
    for (i, &md) in months_days.iter().enumerate() {
        if remaining_days < md {
            m = i;
            break;
        }
        remaining_days -= md;
    }

    let d = remaining_days + 1;
    let month_names = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];

    let now_secs = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let now_days = now_secs / 86400;
    let mut current_year = 1970i32;
    let mut rd = now_days;
    loop {
        let diy = if is_leap(current_year) { 366 } else { 365 };
        if rd < diy {
            break;
        }
        rd -= diy;
        current_year += 1;
    }

    if y != current_year {
        format!("{} {y}", month_names[m])
    } else {
        format!("{} {d:02}", month_names[m])
    }
}

fn is_leap(y: i32) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

// ---------------------------------------------------------------------------
// Git sync (commit + push in the vault repo)
// ---------------------------------------------------------------------------

/// Commit and push one or more files in the blueprints repo. Relative paths
/// must already be anchored to the vault root. Returns `Ok(())` when there was
/// nothing to commit (idempotent no-op), `SyncError::Push` when the commit
/// exists locally but the remote push failed, and `SyncError::{Add, Commit}`
/// for earlier-stage failures.
pub fn commit_and_push_paths(relative_paths: &[&Path], message: &str) -> Result<(), SyncError> {
    if relative_paths.is_empty() {
        return Ok(());
    }
    let bp = blueprints_dir();
    let bp_str = bp.to_string_lossy();

    let mut add = process::Command::new("git");
    add.args(["-C", &bp_str, "add", "--"]);
    for p in relative_paths {
        add.arg(p);
    }
    let add_ok = add.status().is_ok_and(|s| s.success());
    if !add_ok {
        return Err(SyncError::Add(format!(
            "git add failed in {}",
            bp.display()
        )));
    }

    let commit_output = process::Command::new("git")
        .args(["-C", &bp_str, "commit", "-m", message])
        .output();

    match commit_output {
        Ok(o) if o.status.success() => {}
        Ok(o) => {
            let stderr = String::from_utf8_lossy(&o.stderr);
            if stderr.contains("nothing to commit") {
                return Ok(());
            }
            return Err(SyncError::Commit(stderr.trim().to_string()));
        }
        Err(e) => {
            return Err(SyncError::Commit(format!(
                "failed to run git commit in {}: {e}",
                bp.display()
            )));
        }
    }

    let push_ok = process::Command::new("git")
        .args(["-C", &bp_str, "push"])
        .status()
        .is_ok_and(|s| s.success());

    if !push_ok {
        return Err(SyncError::Push(format!(
            "commit saved locally in {}, push manually",
            bp.display()
        )));
    }

    Ok(())
}

/// Commit and push a single file in the blueprints repo.
pub fn commit_and_push(relative_path: &Path, message: &str) -> Result<(), SyncError> {
    commit_and_push_paths(&[relative_path], message)
}

/// Outcome of a `commit_edits` call. `committed: false` means the file had no
/// pending changes, so nothing was sent to the remote.
#[derive(Debug, Clone, Serialize)]
pub struct CommitOutcome {
    pub committed: bool,
    pub pushed: bool,
    pub message: String,
}

/// Commit and push pending edits to a vault file. Validates that the path
/// resides inside the vault, refuses non-`.md` files and `.git/` paths, and
/// no-ops when there are no pending changes.
pub fn commit_edits(path_arg: &str, message: Option<&str>) -> Result<CommitOutcome, CtError> {
    let bp = blueprints_dir_checked()?;
    let path = Path::new(path_arg);
    let full_path: PathBuf = if path.is_absolute() {
        path.to_path_buf()
    } else {
        bp.join(path)
    };

    let (full_canonical, bp_canonical) = canonicalize_in_vault(&full_path)?;
    if full_canonical.components().any(|c| c.as_os_str() == ".git") {
        return Err(CtError::Validation(
            "path contains a .git component".to_string(),
        ));
    }
    if full_canonical.extension().and_then(|e| e.to_str()) != Some("md") {
        return Err(CtError::Validation(
            "only .md artifacts can be committed through this tool".to_string(),
        ));
    }

    let rel_path = full_canonical
        .strip_prefix(&bp_canonical)
        .expect("canonicalize_in_vault guarantees prefix")
        .to_path_buf();

    let resolved_message = message
        .map(|m| m.to_string())
        .unwrap_or_else(|| default_edit_message(&rel_path));

    if no_pending_changes(&bp_canonical, &rel_path) {
        return Ok(CommitOutcome {
            committed: false,
            pushed: false,
            message: "nothing to commit".to_string(),
        });
    }

    commit_and_push(&rel_path, &resolved_message)?;

    Ok(CommitOutcome {
        committed: true,
        pushed: true,
        message: resolved_message,
    })
}

/// Default commit message of the form `<kind>(<project>): edit <slug>` derived
/// from a vault-relative path like `myproj/research/20260416-10-foo.md`.
fn default_edit_message(rel_path: &Path) -> String {
    let components: Vec<&str> = rel_path
        .components()
        .filter_map(|c| c.as_os_str().to_str())
        .collect();
    let project = components.first().copied().unwrap_or("unknown");
    let kind_dir = components.get(1).copied().unwrap_or("edit");
    let kind = ArtifactKind::from_dir_name(kind_dir)
        .map(|k| k.commit_name().to_string())
        .unwrap_or_else(|| kind_dir.to_string());
    let slug = rel_path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    format!("{kind}({project}): edit {slug}")
}

fn no_pending_changes(bp: &Path, rel_path: &Path) -> bool {
    let bp_str = bp.to_string_lossy();
    let is_clean = |cached: bool| {
        let mut cmd = std::process::Command::new("git");
        cmd.args(["-C", &bp_str, "diff", "--quiet"]);
        if cached {
            cmd.arg("--cached");
        }
        cmd.arg("--")
            .arg(rel_path)
            .status()
            .is_ok_and(|s| s.success())
    };
    is_clean(false) && is_clean(true)
}

#[cfg(test)]
mod tests;
