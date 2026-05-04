use std::path::Path;
use std::process::Command;

const DEFAULT_TERMINAL_APP: &str = "Ghostty";

fn terminal_app() -> String {
    terminal_app_from_env(|key| std::env::var(key).ok())
}

fn terminal_app_from_env(get: impl Fn(&str) -> Option<String>) -> String {
    if let Some(terminal) = get("CT_TERMINAL").filter(|value| !value.trim().is_empty()) {
        return terminal;
    }

    let term_program = get("TERM_PROGRAM");
    if get("GHOSTTY_RESOURCES_DIR").is_some()
        || get("TERM")
            .as_deref()
            .is_some_and(|term| term.contains("ghostty"))
        || term_program
            .as_deref()
            .is_some_and(|program| program.eq_ignore_ascii_case("ghostty"))
    {
        return "Ghostty".to_string();
    }

    if get("WEZTERM_EXECUTABLE").is_some()
        || term_program
            .as_deref()
            .is_some_and(|program| program.eq_ignore_ascii_case("wezterm"))
    {
        return "WezTerm".to_string();
    }

    if term_program
        .as_deref()
        .is_some_and(|program| program == "Apple_Terminal")
    {
        return "Terminal".to_string();
    }

    DEFAULT_TERMINAL_APP.to_string()
}

fn frontmost_app_name() -> Option<String> {
    let front = Command::new("lsappinfo")
        .args(["front"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())?;

    let front_handle = front.trim();
    if front_handle.is_empty() {
        return None;
    }

    Command::new("lsappinfo")
        .args(["info", "-only", "name", front_handle])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|output| parse_lsappinfo_name(&output).map(ToString::to_string))
}

/// Returns true if the given app name is currently the frontmost application.
pub fn is_app_focused(app_name: &str) -> bool {
    frontmost_app_name().is_some_and(|name| name == app_name)
}

fn is_terminal_focused() -> bool {
    let Some(name) = frontmost_app_name() else {
        return false;
    };
    if std::env::var("CT_TERMINAL").is_ok() {
        return is_app_focused(&terminal_app());
    }
    matches!(
        name.as_str(),
        "WezTerm" | "Ghostty" | "Terminal" | "iTerm2" | "Alacritty" | "kitty"
    )
}

/// Parse the app name from lsappinfo output like: `"name"="Ghostty"`
/// or the display-name-only shape: `"LSDisplayName"="Ghostty"`.
pub fn parse_lsappinfo_name(output: &str) -> Option<&str> {
    for line in output.lines() {
        let trimmed = line.trim();
        for key in ["\"name\"=", "\"LSDisplayName\"="] {
            // Look for key="value" pattern (quoted value only)
            if let Some(rest) = trimmed.strip_prefix(key)
                && let Some(quoted) = rest.trim().strip_prefix('"')
                && let Some(end) = quoted.find('"')
            {
                return Some(&quoted[..end]);
            }
        }
    }
    None
}

/// Returns true if the tmux client's active session matches the given session name.
/// Requires TMUX to be set.
pub fn is_session_active(session: &str) -> bool {
    if std::env::var("TMUX").is_err() {
        return false;
    }

    let client_tty = Command::new("tmux")
        .args(["display-message", "-p", "#{client_tty}"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string());

    let tty = match client_tty {
        Some(t) if !t.is_empty() => t,
        _ => return false,
    };

    Command::new("tmux")
        .args(["display-message", "-p", "-t", &tty, "#{client_session}"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim() == session)
        .unwrap_or(false)
}

/// Returns true when the source tmux pane is the active pane in an attached session.
/// `TMUX_PANE` is set by tmux and inherited by extension-launched `ct notify`.
fn is_source_pane_active() -> bool {
    let Ok(pane) = std::env::var("TMUX_PANE") else {
        return false;
    };

    let out = Command::new("tmux")
        .args([
            "display-message",
            "-p",
            "-t",
            &pane,
            "#{pane_active}:#{session_attached}",
        ])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok());

    matches!(out.as_deref().map(str::trim), Some("1:1"))
}

fn home_dir() -> Option<std::path::PathBuf> {
    std::env::var("HOME").ok().map(std::path::PathBuf::from)
}

/// Ensure Claude app is registered with grrr. Idempotent.
fn ensure_app_registered() {
    let Some(home) = home_dir() else { return };

    let app_dir = home.join(".growlrrr/apps/Claude.app");
    if !app_dir.exists() {
        let icon = home.join(".claude/claude.png");
        let _ = Command::new("grrr")
            .args([
                "apps",
                "add",
                "--appId",
                "Claude",
                "--appIcon",
                &icon.to_string_lossy(),
            ])
            .output();
    }
}

/// Builds the --execute command string for grrr, inlining focus-session.sh logic with absolute binary paths.
pub fn build_focus_command(session: &str) -> String {
    let terminal = terminal_app();
    let tmux_bin = which_bin("tmux").unwrap_or_else(|| "/usr/local/bin/tmux".to_string());
    let grrr_bin = which_bin("grrr").unwrap_or_else(|| "/usr/local/bin/grrr".to_string());

    format!(
        "open -a '{terminal}' & {grrr_bin} clear 'claude-{session}' >/dev/null 2>&1 & \
         client=$({tmux_bin} list-clients -F '#{{client_tty}}' | head -1) ; \
         [ -n \"$client\" ] && {tmux_bin} switch-client -c \"$client\" -t '{session}'"
    )
}

fn which_bin(name: &str) -> Option<String> {
    Command::new("which")
        .arg(name)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Build and return the grrr Command with all required flags.
/// Does not execute it — caller decides whether to spawn.
pub fn build_grrr_command(
    session: Option<&str>,
    title: &str,
    subtitle: &str,
    message: &str,
    sound: &str,
    icon_path: Option<&str>,
    terminal_focused: bool,
) -> Command {
    let mut cmd = Command::new("grrr");
    cmd.arg("send");

    cmd.args(["--appId", "Claude"]);
    cmd.args(["--title", title]);
    cmd.args(["--subtitle", subtitle]);

    if terminal_focused {
        cmd.args(["--sound", "none"]);
    } else {
        cmd.args(["--sound", sound]);
    }

    if let Some(path) = icon_path
        && Path::new(path).exists()
    {
        cmd.args(["--image", path]);
    }

    if let Some(sess) = session {
        let thread_id = format!("claude-{sess}");
        cmd.args(["--threadId", &thread_id, "--identifier", &thread_id]);

        let focus_cmd = build_focus_command(sess);
        cmd.args(["--execute", &focus_cmd]);
    } else {
        let terminal = terminal_app();
        cmd.args(["--execute", &format!("open -a '{terminal}'")]);
    }

    cmd.arg(message);

    cmd
}

/// Send a macOS notification via grrr.
///
/// Skips if all of these hold: TMUX is set, Ghostty is focused, and the
/// client's active session matches `session`.
pub fn notify(
    session: Option<&str>,
    subtitle: &str,
    message: &str,
    sound: &str,
    icon_path: Option<&str>,
) -> Result<(), String> {
    let terminal_focused = is_terminal_focused();

    if terminal_focused && is_source_pane_active() {
        return Ok(());
    }

    // Set @attention on the session so sidebar/status bar highlight it.
    // Cleared when the session becomes current (see tmux-session update).
    if let Some(sess) = session {
        let _ = Command::new("tmux")
            .args(["set-option", "-t", sess, "@attention", "1"])
            .output();
    }

    ensure_app_registered();

    let title = session.unwrap_or("Claude Code");
    let mut cmd = build_grrr_command(
        session,
        title,
        subtitle,
        message,
        sound,
        icon_path,
        terminal_focused,
    );

    cmd.output().map_err(|e| format!("grrr failed: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_lsappinfo_name_extracts_quoted_value() {
        let output = r#"
LSAppInfoItem 0x600003744540 "com.mitchellh.ghostty" (Ghostty)
"name"="Ghostty" "pid"=1234
"#;
        assert_eq!(parse_lsappinfo_name(output), Some("Ghostty"));
    }

    #[test]
    fn parse_lsappinfo_name_extracts_display_name() {
        let output = r#""LSDisplayName"="Ghostty""#;
        assert_eq!(parse_lsappinfo_name(output), Some("Ghostty"));
    }

    #[test]
    fn parse_lsappinfo_name_returns_none_for_unrecognized_format() {
        let output = "no equals sign here\n";
        assert_eq!(parse_lsappinfo_name(output), None);
    }

    #[test]
    fn parse_lsappinfo_name_returns_none_for_empty() {
        assert_eq!(parse_lsappinfo_name(""), None);
    }

    #[test]
    fn parse_lsappinfo_name_handles_unquoted_value() {
        let output = "\"name\"=Ghostty\n";
        assert_eq!(parse_lsappinfo_name(output), None);
    }

    #[test]
    fn build_focus_command_contains_session_name() {
        let cmd = build_focus_command("my-session");
        assert!(cmd.contains("claude-my-session"));
        assert!(cmd.contains("switch-client"));
        assert!(cmd.contains("open -a '"));
    }

    fn env_value(vars: &[(&str, &str)], key: &str) -> Option<String> {
        vars.iter()
            .find(|(name, _)| *name == key)
            .map(|(_, value)| (*value).to_string())
    }

    #[test]
    fn terminal_app_defaults_to_ghostty() {
        assert_eq!(terminal_app_from_env(|_| None), "Ghostty");
    }

    #[test]
    fn terminal_app_prefers_explicit_override() {
        assert_eq!(
            terminal_app_from_env(|key| env_value(&[("CT_TERMINAL", "WezTerm")], key)),
            "WezTerm"
        );
    }

    #[test]
    fn terminal_app_detects_source_ghostty_env() {
        assert_eq!(
            terminal_app_from_env(|key| env_value(&[("TERM", "xterm-ghostty")], key)),
            "Ghostty"
        );
        assert_eq!(
            terminal_app_from_env(|key| env_value(&[("GHOSTTY_RESOURCES_DIR", "/app")], key)),
            "Ghostty"
        );
    }

    #[test]
    fn terminal_app_detects_source_wezterm_env() {
        assert_eq!(
            terminal_app_from_env(|key| env_value(
                &[("WEZTERM_EXECUTABLE", "/Applications/WezTerm.app")],
                key
            )),
            "WezTerm"
        );
    }

    #[test]
    fn build_grrr_command_uses_none_sound_when_terminal_focused() {
        let cmd = build_grrr_command(None, "Claude Code", "Ready", "Ready", "Hero", None, true);
        let args: Vec<_> = cmd.get_args().collect();
        let args: Vec<&str> = args.iter().map(|a| a.to_str().unwrap()).collect();
        let sound_pos = args.iter().position(|&a| a == "--sound").unwrap();
        assert_eq!(args[sound_pos + 1], "none");
    }

    #[test]
    fn build_grrr_command_uses_provided_sound_when_not_focused() {
        let cmd = build_grrr_command(None, "Claude Code", "Ready", "Ready", "Hero", None, false);
        let args: Vec<_> = cmd.get_args().collect();
        let args: Vec<&str> = args.iter().map(|a| a.to_str().unwrap()).collect();
        let sound_pos = args.iter().position(|&a| a == "--sound").unwrap();
        assert_eq!(args[sound_pos + 1], "Hero");
    }

    #[test]
    fn build_grrr_command_sets_thread_and_identifier_for_session() {
        let cmd = build_grrr_command(Some("work"), "work", "Done", "Done", "Hero", None, false);
        let args: Vec<_> = cmd.get_args().collect();
        let args: Vec<&str> = args.iter().map(|a| a.to_str().unwrap()).collect();
        assert!(args.contains(&"--threadId"));
        assert!(args.contains(&"claude-work"));
        assert!(args.contains(&"--identifier"));
    }

    #[test]
    fn build_grrr_command_no_thread_flags_when_no_session() {
        let cmd = build_grrr_command(None, "Claude Code", "Ready", "Ready", "Hero", None, false);
        let args: Vec<_> = cmd.get_args().collect();
        let args: Vec<&str> = args.iter().map(|a| a.to_str().unwrap()).collect();
        assert!(!args.contains(&"--threadId"));
        assert!(!args.contains(&"--identifier"));
    }

    #[test]
    fn build_grrr_command_skips_image_flag_when_no_icon() {
        let cmd = build_grrr_command(None, "Claude Code", "Ready", "Ready", "Hero", None, false);
        let args: Vec<_> = cmd.get_args().collect();
        let args: Vec<&str> = args.iter().map(|a| a.to_str().unwrap()).collect();
        assert!(!args.contains(&"--image"));
    }
}
