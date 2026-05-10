use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus};

use anyhow::{Context, Result};
use regex::Regex;
use serde_json::{Value, json};

const GRAPHITE_CONTEXT: &str = "## Graphite Workflow\n\nThis repo uses Graphite for stacked PRs. Decision rule: if on a gt-managed branch, use gt commands exclusively (never raw git rebase, git push, or git checkout -b). If not on a gt-managed branch, use git normally. Never mix.\n\n- Push / create-update PRs -> `Skill(gt:submit)`\n- Rebase / sync with main -> `Skill(gt:restack)`\n- Create branch / navigate / stack ops -> `Skill(gt:gt)`\n\nRaw git/gt in Bash is fine only when the user explicitly requests it. Return `app.graphite.com/...` URLs.";
const APPLY_PATCH_CONTEXT: &str = "File-edit tool: use `apply_patch` when the host provides it, otherwise pipe patches to `ct apply-patch`. Use it for every text file change - single-line, single-file, multi-file, creates, deletes, renames alike. Do not fall back to Edit/Write because a change is \"just one line\" or \"just one file\"; that is the documented failure mode. Use Edit/Write only when apply_patch genuinely cannot express the change (e.g. binary files) and say why in the same turn.";

pub fn run_hook(name: &str) -> Result<()> {
    match name {
        "notify" => crate::notify::run().map_err(|error| anyhow::anyhow!(error.to_string())),
        "apply-patch-remind" => apply_patch_remind(),
        "rtk-rewrite" => rtk_rewrite(),
        "gt-session-start" => gt_session_start(),
        "gt-validate-git" => gt_validate_git(),
        other => anyhow::bail!(
            "unknown hook {other:?} (supported: apply-patch-remind, notify, gt-session-start, gt-validate-git, rtk-rewrite)"
        ),
    }
}

fn gt_session_start() -> Result<()> {
    if !graphite_active_branch()? {
        return Ok(());
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "hookSpecificOutput": {
                "hookEventName": "SessionStart",
                "additionalContext": GRAPHITE_CONTEXT,
            }
        }))?
    );
    Ok(())
}

fn apply_patch_remind() -> Result<()> {
    emit_session_context(APPLY_PATCH_CONTEXT)
}

fn emit_session_context(context: &str) -> Result<()> {
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "hookSpecificOutput": {
                "hookEventName": "SessionStart",
                "additionalContext": context,
            }
        }))?
    );
    Ok(())
}

fn rtk_rewrite() -> Result<()> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    let mut payload: Value = serde_json::from_str(&input).context("hook input must be JSON")?;
    let command = payload
        .get("tool_input")
        .and_then(|tool_input| tool_input.get("command"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if command.is_empty() {
        return Ok(());
    }

    if !rtk_available()? {
        return Ok(());
    }

    let output = Command::new("rtk").arg("rewrite").arg(&command).output()?;
    let rewritten = String::from_utf8_lossy(&output.stdout).trim().to_string();

    match exit_code(output.status) {
        Some(0) => {
            if rewritten == command {
                return Ok(());
            }
            emit_rtk_update(&mut payload, &rewritten, true)
        }
        Some(3) => {
            if rewritten.is_empty() {
                return Ok(());
            }
            emit_rtk_update(&mut payload, &rewritten, false)
        }
        _ => Ok(()),
    }
}

fn gt_validate_git() -> Result<()> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    let command = hook_command(&input)?;
    if command.trim().is_empty() {
        return Ok(());
    }

    let Some(repo) = graphite_repo()? else {
        return Ok(());
    };
    if !is_graphite_active_branch(&repo.current_branch, &repo.trunk) {
        return Ok(());
    }

    if contains_command(&command, r"git\s+push") {
        deny("BLOCKED: raw 'git push' on stacked branch. Use /gt:submit instead.");
    }
    if contains_command(&command, r"git\s+pull") {
        deny("BLOCKED: raw 'git pull' on stacked branch. Use /gt:restack instead.");
    }
    if contains_command(&command, r"gh\s+pr\s+create") {
        deny("BLOCKED: raw 'gh pr create' in Graphite repo. Use /gt:submit instead.");
    }
    if contains_command(&command, r"git\s+rebase")
        && !contains_command(&command, r"git\s+rebase\s+--(abort|continue|skip)")
    {
        deny("BLOCKED: raw 'git rebase' in Graphite repo. Use /gt:restack instead.");
    }
    if contains_command(&command, r"git\s+checkout\s+-b") {
        deny(
            "BLOCKED: raw 'git checkout -b' in Graphite repo. Use /start or /gt:gt create instead.",
        );
    }
    if contains_command(&command, r"git\s+branch\s+-[dD]") {
        deny("BLOCKED: raw 'git branch -d/-D' in Graphite repo. Use /gt:gt delete instead.");
    }

    Ok(())
}

fn rtk_available() -> Result<bool> {
    let Ok(output) = Command::new("rtk").arg("--version").output() else {
        eprintln!(
            "[rtk] WARNING: rtk is not installed or not in PATH. Hook cannot rewrite commands. Install: https://github.com/rtk-ai/rtk#installation"
        );
        return Ok(false);
    };
    if !output.status.success() {
        return Ok(false);
    }
    let version = String::from_utf8_lossy(&output.stdout);
    let Some((major, minor, _patch)) = parse_version(&version) else {
        return Ok(true);
    };
    if major == 0 && minor < 23 {
        eprintln!(
            "[rtk] WARNING: rtk {major}.{minor}.x is too old (need >= 0.23.0). Upgrade: cargo install rtk"
        );
        return Ok(false);
    }
    Ok(true)
}

fn emit_rtk_update(payload: &mut Value, command: &str, allow: bool) -> Result<()> {
    let Some(tool_input) = payload.get_mut("tool_input").and_then(Value::as_object_mut) else {
        return Ok(());
    };
    tool_input.insert("command".to_string(), Value::String(command.to_string()));
    let updated = Value::Object(tool_input.clone());
    let mut hook_output = serde_json::Map::new();
    hook_output.insert(
        "hookEventName".to_string(),
        Value::String("PreToolUse".to_string()),
    );
    hook_output.insert("updatedInput".to_string(), updated);
    if allow {
        hook_output.insert(
            "permissionDecision".to_string(),
            Value::String("allow".to_string()),
        );
        hook_output.insert(
            "permissionDecisionReason".to_string(),
            Value::String("RTK auto-rewrite".to_string()),
        );
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "hookSpecificOutput": Value::Object(hook_output),
        }))?
    );
    Ok(())
}

fn hook_command(input: &str) -> Result<String> {
    if input.trim().is_empty() {
        return Ok(String::new());
    }
    let value: Value = serde_json::from_str(input).context("hook input must be JSON")?;
    Ok(value
        .get("tool_input")
        .and_then(|tool_input| tool_input.get("command"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string())
}

struct GraphiteRepo {
    trunk: String,
    current_branch: String,
}

fn graphite_active_branch() -> Result<bool> {
    Ok(graphite_repo()?
        .map(|repo| is_graphite_active_branch(&repo.current_branch, &repo.trunk))
        .unwrap_or(false))
}

fn graphite_repo() -> Result<Option<GraphiteRepo>> {
    let Some(config) = graphite_config_path()? else {
        return Ok(None);
    };
    let trunk = graphite_trunk(&config)?;
    let current_branch = git_output(&["symbolic-ref", "--short", "HEAD"]).unwrap_or_default();
    Ok(Some(GraphiteRepo {
        trunk,
        current_branch,
    }))
}

fn graphite_config_path() -> Result<Option<PathBuf>> {
    let Ok(git_dir) = git_output(&["rev-parse", "--path-format=absolute", "--git-common-dir"])
    else {
        return Ok(None);
    };
    let config = PathBuf::from(git_dir).join(".graphite_repo_config");
    Ok(config.exists().then_some(config))
}

fn graphite_trunk(path: &Path) -> Result<String> {
    let value: Value = serde_json::from_slice(&fs::read(path)?)?;
    Ok(value
        .get("trunk")
        .and_then(Value::as_str)
        .unwrap_or("main")
        .to_string())
}

fn git_output(args: &[&str]) -> Result<String> {
    let output = Command::new("git").args(args).output()?;
    if !output.status.success() {
        anyhow::bail!("git {} failed", args.join(" "));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn contains_command(command: &str, pattern: &str) -> bool {
    let re = Regex::new(&format!(r"(^|[;&|])\s*{pattern}(\s|$)")).expect("valid hook regex");
    re.is_match(command)
}

fn is_graphite_active_branch(current_branch: &str, trunk: &str) -> bool {
    !current_branch.is_empty() && current_branch != trunk
}

fn parse_version(text: &str) -> Option<(u64, u64, u64)> {
    let re = Regex::new(r"(\d+)\.(\d+)\.(\d+)").expect("valid version regex");
    let caps = re.captures(text)?;
    Some((
        caps.get(1)?.as_str().parse().ok()?,
        caps.get(2)?.as_str().parse().ok()?,
        caps.get(3)?.as_str().parse().ok()?,
    ))
}

fn exit_code(status: ExitStatus) -> Option<i32> {
    status.code()
}

fn deny(message: &str) -> ! {
    eprintln!(
        "{}",
        serde_json::to_string(&json!({
            "hookSpecificOutput": {
                "permissionDecision": "deny",
            },
            "systemMessage": message,
        }))
        .expect("deny JSON must serialize")
    );
    std::process::exit(2);
}

#[cfg(test)]
mod tests {
    use super::{contains_command, hook_command, is_graphite_active_branch, parse_version};

    #[test]
    fn command_match_respects_shell_separators() {
        assert!(contains_command("git status && git push", r"git\s+push"));
        assert!(contains_command(
            "echo ok; gh pr create",
            r"gh\s+pr\s+create"
        ));
        assert!(!contains_command("echo git push", r"git\s+push"));
    }

    #[test]
    fn hook_command_extracts_codex_payload() {
        let input = r#"{"tool_input":{"command":"git push"}}"#;
        assert_eq!(hook_command(input).unwrap(), "git push");
    }

    #[test]
    fn parse_version_finds_semver_in_cli_output() {
        assert_eq!(parse_version("rtk 0.23.1"), Some((0, 23, 1)));
        assert_eq!(parse_version("rtk dev"), None);
    }

    #[test]
    fn graphite_is_active_only_on_non_trunk_branch() {
        assert!(!is_graphite_active_branch("", "main"));
        assert!(!is_graphite_active_branch("main", "main"));
        assert!(is_graphite_active_branch("luan/stacked-change", "main"));
    }
}
