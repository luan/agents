use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

use super::contract::{LensEnvelope, LensMessage};
use super::store::LensStore;
use super::types::{
    GuardAction, LensToolEventPhase, LensTouchedFile, LensTouchedFileInput, LensTouchedFileSource,
    LensTurnEvent, LensTurnEventKind, LensTurnRecordData, LensTurnTouchedData,
};

pub fn record_turn_event_envelope(
    fallback_cwd: &Path,
    mut event: LensTurnEvent,
) -> Result<LensEnvelope<LensTurnRecordData>, Box<dyn std::error::Error>> {
    let event_cwd = if event.cwd.trim().is_empty() {
        fallback_cwd.to_path_buf()
    } else {
        PathBuf::from(&event.cwd)
    };
    let event_cwd = canonical_or_self(&event_cwd);
    event.cwd = event_cwd.display().to_string();
    let root = project_root(&event_cwd).unwrap_or_else(|| canonical_or_self(&event_cwd));
    let mut store = LensStore::open_for_project(&root)?;
    let (files, git_fallback_used) = touched_files_from_event(&root, &event_cwd, &event)?;
    let policy = super::policy::resolve_policy(&root).policy.guard;
    let guard_action = guard_action_for_mode(policy.mode);
    let mut guard_decisions = Vec::new();
    if matches!(event.phase, LensToolEventPhase::PreTool) {
        for file in files
            .iter()
            .filter(|file| is_write_operation(&file.operation))
        {
            let (start, end) = guard_range(&root, file)?;
            guard_decisions.push(store.check_guard_with_overrides(
                Some(&event.session),
                Path::new(&file.path),
                start,
                end,
                guard_action.clone(),
                policy.allow_overrides,
            )?);
        }
    }
    if matches!(event.phase, LensToolEventPhase::PostTool) {
        for file in files
            .iter()
            .filter(|file| is_read_operation(&file.operation))
        {
            let (start, end) = guard_range(&root, file)?;
            if root.join(&file.path).is_file() {
                store.record_read(Some(&event.session), Path::new(&file.path), start, end)?;
            }
        }
    }
    store.record_turn_event(&event, &files)?;
    let cleanup = if matches!(event.event, LensTurnEventKind::TurnEnd) {
        Some(super::cleanup::run_turn_cleanup_with_store(
            &root,
            &mut store,
            &event.session,
            &event.turn,
            super::cleanup::CleanupOptions::default(),
        )?)
    } else {
        None
    };
    let files = store.list_touched_files(&event.session, &event.turn)?;
    let blocked = guard_decisions
        .iter()
        .any(|decision| matches!(decision.decision, GuardAction::Block));
    let warned = guard_decisions
        .iter()
        .any(|decision| matches!(decision.decision, GuardAction::Warn));
    let turn_checks = if matches!(event.event, LensTurnEventKind::TurnEnd) {
        Some(super::checks::automatic_turn_checks_envelope(&root)?)
    } else {
        None
    };
    let mut warnings = Vec::new();
    if warned {
        warnings.push(LensMessage::warning(
            "guard_warned",
            "one or more write targets are not covered by current read ranges",
        ));
    }
    if let Some(cleanup) = &cleanup {
        warnings.extend(super::cleanup::cleanup_envelope(cleanup.clone()).warnings);
    }
    if let Some(checks) = &turn_checks {
        warnings.extend(checks.warnings.clone());
    }
    let data = LensTurnRecordData {
        project_id: store.project_id(),
        session: event.session,
        turn: event.turn,
        host: event.host,
        cwd: event_cwd.display().to_string(),
        tool: event.tool,
        event: event.event,
        phase: event.phase,
        git_fallback_used,
        guard_decisions,
        file_count: files.len(),
        files,
        cleanup,
        checks: turn_checks.map(|envelope| envelope.data),
    };
    if blocked {
        Ok(LensEnvelope::error(
            data,
            vec![LensMessage::error(
                "guard_blocked",
                "one or more write targets are not covered by current read ranges",
            )],
        ))
    } else if !warnings.is_empty() {
        Ok(LensEnvelope::warning(data, warnings))
    } else {
        Ok(LensEnvelope::ok(data))
    }
}

fn guard_action_for_mode(mode: super::policy::LensGuardMode) -> GuardAction {
    match mode {
        super::policy::LensGuardMode::Off => GuardAction::Allow,
        super::policy::LensGuardMode::Warn => GuardAction::Warn,
        super::policy::LensGuardMode::Block => GuardAction::Block,
    }
}

fn guard_range(
    root: &Path,
    file: &LensTouchedFile,
) -> Result<(i64, i64), Box<dyn std::error::Error>> {
    if let (Some(start), Some(end)) = (file.start_line, file.end_line) {
        return Ok((start, end));
    }
    let line_count = std::fs::read_to_string(root.join(&file.path))
        .map(|content| content.lines().count().max(1) as i64)
        .unwrap_or(1);
    Ok((
        file.start_line.unwrap_or(1),
        file.end_line.unwrap_or(line_count),
    ))
}

fn is_write_operation(operation: &str) -> bool {
    matches!(
        operation,
        "add" | "create" | "delete" | "edit" | "modify" | "move" | "rename" | "write"
    )
}

fn is_read_operation(operation: &str) -> bool {
    matches!(operation, "discover" | "open" | "read" | "view")
}

pub fn touched_files_envelope(
    root: &Path,
    session: &str,
    turn: &str,
) -> Result<LensEnvelope<LensTurnTouchedData>, Box<dyn std::error::Error>> {
    let store = LensStore::open_for_project(root)?;
    let files = store.list_touched_files(session, turn)?;
    Ok(LensEnvelope::ok(LensTurnTouchedData {
        project_id: store.project_id(),
        session: session.to_string(),
        turn: turn.to_string(),
        file_count: files.len(),
        files,
    }))
}

pub fn touched_files_from_event(
    root: &Path,
    event_cwd: &Path,
    event: &LensTurnEvent,
) -> Result<(Vec<LensTouchedFile>, bool), Box<dyn std::error::Error>> {
    let mut files: BTreeMap<(String, LensTouchedFileSource), LensTouchedFile> = BTreeMap::new();

    for input in &event.files {
        if let Some(file) = structured_file(root, event_cwd, event, input)? {
            files.insert((file.path.clone(), file.source.clone()), file);
        }
    }

    let should_fallback = event.policy.git_fallback
        && (event.files.is_empty()
            || is_shell_tool(&event.tool)
            || !matches!(event.phase, LensToolEventPhase::PostTool)
            || matches!(event.event, LensTurnEventKind::ToolStart));
    let mut git_fallback_used = false;
    if should_fallback {
        for file in git_status_files(root, event)? {
            git_fallback_used = true;
            files
                .entry((file.path.clone(), file.source.clone()))
                .or_insert(file);
        }
    }

    Ok((files.into_values().collect(), git_fallback_used))
}

fn structured_file(
    root: &Path,
    event_cwd: &Path,
    event: &LensTurnEvent,
    input: &LensTouchedFileInput,
) -> Result<Option<LensTouchedFile>, Box<dyn std::error::Error>> {
    let Some(path) = rel_path(root, event_cwd, Path::new(&input.path)) else {
        return Ok(None);
    };
    let ignored = is_git_ignored(root, &path)?;
    Ok(Some(LensTouchedFile {
        path,
        operation: input.operation.clone(),
        start_line: input.start_line,
        end_line: input.end_line,
        tool: event.tool.clone(),
        source: LensTouchedFileSource::StructuredEvent,
        explicit: true,
        ignored,
        generated: input.generated,
    }))
}

fn git_status_files(
    root: &Path,
    event: &LensTurnEvent,
) -> Result<Vec<LensTouchedFile>, Box<dyn std::error::Error>> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["status", "--porcelain=v1", "-z", "--untracked-files=all"])
        .output();
    let Ok(output) = output else {
        return Ok(Vec::new());
    };
    if !output.status.success() {
        return Ok(Vec::new());
    }

    let mut out = Vec::new();
    let mut entries = output.stdout.split(|byte| *byte == 0).peekable();
    while let Some(entry) = entries.next() {
        if entry.is_empty() || entry.len() < 4 {
            continue;
        }
        let x = entry[0] as char;
        let y = entry[1] as char;
        let path_bytes = &entry[3..];
        let path = String::from_utf8_lossy(path_bytes).to_string();
        if matches!(x, 'R' | 'C') || matches!(y, 'R' | 'C') {
            let _ = entries.next();
        }
        if path.is_empty() || is_git_ignored(root, &path)? {
            continue;
        }
        out.push(LensTouchedFile {
            path,
            operation: git_operation(x, y),
            start_line: None,
            end_line: None,
            tool: event.tool.clone(),
            source: LensTouchedFileSource::GitStatus,
            explicit: false,
            ignored: false,
            generated: false,
        });
    }
    Ok(out)
}

fn git_operation(x: char, y: char) -> String {
    if matches!(x, 'R' | 'C') || matches!(y, 'R' | 'C') {
        "rename".to_string()
    } else if x == '?' || x == 'A' || y == 'A' {
        "create".to_string()
    } else if x == 'D' || y == 'D' {
        "delete".to_string()
    } else {
        "modify".to_string()
    }
}

fn is_shell_tool(tool: &str) -> bool {
    matches!(
        tool.to_ascii_lowercase().as_str(),
        "bash" | "shell" | "sh" | "zsh" | "terminal" | "run_command"
    )
}

fn is_git_ignored(root: &Path, rel_path: &str) -> Result<bool, Box<dyn std::error::Error>> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["check-ignore", "-q", "--"])
        .arg(rel_path)
        .output();
    let Ok(output) = output else {
        return Ok(false);
    };
    Ok(output.status.code() == Some(0))
}

fn project_root(cwd: &Path) -> Option<PathBuf> {
    let output = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!text.is_empty()).then(|| PathBuf::from(text))
}

fn rel_path(root: &Path, cwd: &Path, path: &Path) -> Option<String> {
    let full = if path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd.join(path)
    };
    let full = normalize_path(&full);
    let root = normalize_path(root);
    let rel = full.strip_prefix(&root).ok()?;
    if rel.as_os_str().is_empty() || rel.components().any(|c| matches!(c, Component::ParentDir)) {
        return None;
    }
    Some(path_to_slash(rel))
}

fn path_to_slash(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy().to_string()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => out.push(prefix.as_os_str()),
            Component::RootDir => out.push(Path::new(std::path::MAIN_SEPARATOR_STR)),
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(part) => out.push(part),
        }
    }
    out
}

fn canonical_or_self(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::super::types::GuardReason;
    use super::*;

    fn git(cwd: &Path, args: &[&str]) {
        let status = Command::new("git")
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
        std::fs::write(temp.path().join(".gitignore"), "ignored.log\ngen/\n").unwrap();
        std::fs::write(temp.path().join("main.rs"), "fn main() {}\n").unwrap();
        git(temp.path(), &["add", ".gitignore", "main.rs"]);
        git(temp.path(), &["commit", "-m", "init"]);
        temp
    }

    fn event(root: &Path) -> LensTurnEvent {
        LensTurnEvent {
            schema_version: super::super::types::LENS_TURN_EVENT_SCHEMA_VERSION.to_string(),
            session: "s".to_string(),
            turn: "t".to_string(),
            host: "test".to_string(),
            cwd: root.display().to_string(),
            event: LensTurnEventKind::ToolEnd,
            tool: "edit".to_string(),
            phase: LensToolEventPhase::PostTool,
            status: Some("success".to_string()),
            files: Vec::new(),
            policy: Default::default(),
        }
    }

    #[test]
    fn structured_event_extracts_explicit_touched_files() {
        let temp = repo();
        let mut event = event(temp.path());
        event.files.push(LensTouchedFileInput {
            path: "main.rs".to_string(),
            operation: "modify".to_string(),
            start_line: None,
            end_line: None,
            generated: false,
            include_ignored: false,
        });

        let (files, fallback) = touched_files_from_event(temp.path(), temp.path(), &event).unwrap();

        assert!(!fallback);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "main.rs");
        assert_eq!(files[0].source, LensTouchedFileSource::StructuredEvent);
        assert!(files[0].explicit);
    }

    #[test]
    fn git_status_fallback_finds_shell_mutations() {
        let temp = repo();
        std::fs::write(temp.path().join("main.rs"), "fn main() { println!(); }\n").unwrap();
        let mut event = event(temp.path());
        event.tool = "bash".to_string();

        let (files, fallback) = touched_files_from_event(temp.path(), temp.path(), &event).unwrap();

        assert!(fallback);
        assert!(files.iter().any(|file| file.path == "main.rs"
            && file.source == LensTouchedFileSource::GitStatus
            && !file.explicit));
    }

    #[test]
    fn git_fallback_drops_ignored_noise() {
        let temp = repo();
        std::fs::write(temp.path().join("ignored.log"), "noise\n").unwrap();
        let mut event = event(temp.path());
        event.tool = "bash".to_string();

        let (files, _) = touched_files_from_event(temp.path(), temp.path(), &event).unwrap();

        assert!(files.iter().all(|file| file.path != "ignored.log"));
    }

    #[test]
    fn pre_tool_write_event_runs_guard_checks() {
        let temp = repo();
        let mut event = event(temp.path());
        event.phase = LensToolEventPhase::PreTool;
        event.event = LensTurnEventKind::ToolStart;
        event.files.push(LensTouchedFileInput {
            path: "main.rs".to_string(),
            operation: "modify".to_string(),
            start_line: Some(1),
            end_line: Some(1),
            generated: false,
            include_ignored: false,
        });

        let envelope = record_turn_event_envelope(temp.path(), event).unwrap();

        assert_eq!(
            envelope.status,
            super::super::contract::LensResponseStatus::Error
        );
        assert_eq!(envelope.data.guard_decisions.len(), 1);
        assert_eq!(
            envelope.data.guard_decisions[0].reason,
            GuardReason::ZeroRead
        );
    }

    #[test]
    fn post_tool_read_event_records_guard_coverage() {
        let temp = repo();
        let mut read_event = event(temp.path());
        read_event.phase = LensToolEventPhase::PostTool;
        read_event.event = LensTurnEventKind::ToolEnd;
        read_event.files.push(LensTouchedFileInput {
            path: "main.rs".to_string(),
            operation: "read".to_string(),
            start_line: Some(1),
            end_line: Some(1),
            generated: false,
            include_ignored: false,
        });

        let envelope = record_turn_event_envelope(temp.path(), read_event).unwrap();
        assert_eq!(
            envelope.status,
            super::super::contract::LensResponseStatus::Ok
        );

        let mut store = LensStore::open_for_project(temp.path()).unwrap();
        let decision = store
            .check_guard(Some("s"), Path::new("main.rs"), 1, 1, GuardAction::Block)
            .unwrap();
        assert_eq!(decision.reason, GuardReason::Covered);
    }

    #[test]
    fn current_turn_explicit_ignored_file_is_retained() {
        let temp = repo();
        std::fs::write(temp.path().join("ignored.log"), "generated\n").unwrap();
        let mut event = event(temp.path());
        event.files.push(LensTouchedFileInput {
            path: "ignored.log".to_string(),
            operation: "create".to_string(),
            start_line: None,
            end_line: None,
            generated: true,
            include_ignored: true,
        });

        let (files, _) = touched_files_from_event(temp.path(), temp.path(), &event).unwrap();

        let ignored = files
            .iter()
            .find(|file| file.path == "ignored.log")
            .unwrap();
        assert!(ignored.ignored);
        assert!(ignored.generated);
        assert!(ignored.explicit);
    }
}
