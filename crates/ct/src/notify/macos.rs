use std::path::Path;
use std::process::Command;

fn terminal_app() -> Option<String> {
    if std::env::var("TMUX").is_ok()
        && let Some(term) = tmux_client_terminal()
        && let Some(app) = terminal_app_from_term(&term)
    {
        return Some(app);
    }

    terminal_app_from_env(|key| std::env::var(key).ok())
}

fn tmux_client_terminal() -> Option<String> {
    Command::new("tmux")
        .args(["display-message", "-p", "#{client_termname}"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|term| term.trim().to_string())
        .filter(|term| !term.is_empty())
}

fn terminal_app_from_env(get: impl Fn(&str) -> Option<String>) -> Option<String> {
    if let Some(terminal) = get("CT_TERMINAL").filter(|value| !value.trim().is_empty()) {
        return Some(terminal);
    }

    if get("GHOSTTY_RESOURCES_DIR").is_some() {
        return Some("Ghostty".to_string());
    }
    if get("WEZTERM_EXECUTABLE").is_some() {
        return Some("WezTerm".to_string());
    }

    ["TERM", "TERM_PROGRAM", "LC_TERMINAL"]
        .into_iter()
        .filter_map(&get)
        .find_map(|term| terminal_app_from_term(&term))
}

fn terminal_app_from_term(term: &str) -> Option<String> {
    let term = term.to_ascii_lowercase();
    let app = if term.contains("ghostty") {
        "Ghostty"
    } else if term.contains("wezterm") {
        "WezTerm"
    } else if term.contains("alacritty") {
        "Alacritty"
    } else if term.contains("iterm") {
        "iTerm2"
    } else if term.contains("apple_terminal") {
        "Terminal"
    } else if term.contains("kitty") {
        "kitty"
    } else if term.contains("bootty") {
        "Bootty"
    } else if term.contains("warp") {
        "Warp"
    } else {
        return None;
    };
    Some(app.to_string())
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

fn is_terminal_focused() -> bool {
    let Some(name) = frontmost_app_name() else {
        return false;
    };
    terminal_app()
        .as_deref()
        .is_some_and(|terminal| name == terminal)
        || matches!(
            name.as_str(),
            "WezTerm"
                | "Ghostty"
                | "Terminal"
                | "iTerm2"
                | "Alacritty"
                | "kitty"
                | "Bootty"
                | "Warp"
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

fn build_app_registration_command(app_id: &str, app_icon: Option<&Path>) -> Command {
    let mut cmd = Command::new("grrr");
    cmd.args(["apps", "add", "--appId", app_id]);
    if let Some(icon) = app_icon.filter(|path| path.exists()) {
        cmd.args(["--appIcon", &icon.to_string_lossy()]);
    }
    cmd
}

/// Ensure the notification app is registered with grrr. Idempotent.
fn ensure_app_registered(app_id: &str, notification_icon: Option<&Path>) {
    let Some(home) = home_dir() else { return };

    let app_dir = home.join(".growlrrr/apps").join(format!("{app_id}.app"));
    if app_dir.exists() {
        return;
    }

    let app_icon = if app_id == "Claude" {
        Some(home.join(".claude/claude.png"))
    } else {
        notification_icon.map(Path::to_path_buf)
    };
    let _ = build_app_registration_command(app_id, app_icon.as_deref()).output();
}

/// Builds the --execute command string for grrr, inlining focus-session.sh logic with absolute binary paths.
pub fn build_focus_command(session: &str, thread_id: &str, terminal: Option<&str>) -> String {
    let tmux_bin = which_bin("tmux").unwrap_or_else(|| "/usr/local/bin/tmux".to_string());
    let grrr_bin = which_bin("grrr").unwrap_or_else(|| "/usr/local/bin/grrr".to_string());
    let open_terminal = terminal
        .map(|app| format!("open -a '{app}' & "))
        .unwrap_or_default();

    format!(
        "{open_terminal}{grrr_bin} clear '{thread_id}' >/dev/null 2>&1 & \
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

struct GrrrNotification<'a> {
    session: Option<&'a str>,
    app_id: &'a str,
    title: &'a str,
    subtitle: &'a str,
    message: &'a str,
    sound: &'a str,
    icon_path: Option<&'a str>,
    terminal_focused: bool,
}

/// Build and return the grrr Command with all required flags.
/// Does not execute it — caller decides whether to spawn.
fn build_grrr_command(notification: GrrrNotification<'_>) -> Command {
    let GrrrNotification {
        session,
        app_id,
        title,
        subtitle,
        message,
        sound,
        icon_path,
        terminal_focused,
    } = notification;
    let mut cmd = Command::new("grrr");
    cmd.arg("send");

    cmd.args(["--appId", app_id]);
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

    let terminal = terminal_app();
    if let Some(sess) = session {
        let thread_id = format!("{}-{sess}", app_id.to_ascii_lowercase());
        cmd.args(["--threadId", &thread_id, "--identifier", &thread_id]);

        let focus_cmd = build_focus_command(sess, &thread_id, terminal.as_deref());
        cmd.args(["--execute", &focus_cmd]);
    } else if let Some(terminal) = terminal {
        cmd.args(["--execute", &format!("open -a '{terminal}'")]);
    }

    cmd.arg(message);

    cmd
}

/// Send a macOS notification via grrr.
///
/// Skips when the terminal is focused and the source tmux pane is active.
pub fn notify(
    session: Option<&str>,
    app_id: &str,
    title: &str,
    subtitle: &str,
    message: &str,
    sound: &str,
    icon_path: Option<&Path>,
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

    ensure_app_registered(app_id, icon_path);

    let mut cmd = build_grrr_command(GrrrNotification {
        session,
        app_id,
        title,
        subtitle,
        message,
        sound,
        icon_path: icon_path.and_then(Path::to_str),
        terminal_focused,
    });

    cmd.output().map_err(|e| format!("grrr failed: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::NamedTempFile;

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
        let cmd = build_focus_command("my-session", "pi-my-session", Some("Alacritty"));
        assert!(cmd.contains("pi-my-session"));
        assert!(cmd.contains("switch-client"));
        assert!(cmd.contains("open -a 'Alacritty'"));
    }

    fn env_value(vars: &[(&str, &str)], key: &str) -> Option<String> {
        vars.iter()
            .find(|(name, _)| *name == key)
            .map(|(_, value)| (*value).to_string())
    }

    #[test]
    fn terminal_app_is_unknown_without_terminal_metadata() {
        assert_eq!(terminal_app_from_env(|_| None), None);
    }

    #[test]
    fn terminal_app_prefers_explicit_override() {
        assert_eq!(
            terminal_app_from_env(|key| env_value(&[("CT_TERMINAL", "WezTerm")], key)),
            Some("WezTerm".to_string())
        );
    }

    #[test]
    fn terminal_app_detects_source_ghostty_env() {
        assert_eq!(
            terminal_app_from_env(|key| env_value(&[("TERM", "xterm-ghostty")], key)),
            Some("Ghostty".to_string())
        );
        assert_eq!(
            terminal_app_from_env(|key| env_value(&[("GHOSTTY_RESOURCES_DIR", "/app")], key)),
            Some("Ghostty".to_string())
        );
    }

    #[test]
    fn terminal_app_detects_source_wezterm_env() {
        assert_eq!(
            terminal_app_from_env(|key| env_value(
                &[("WEZTERM_EXECUTABLE", "/Applications/WezTerm.app")],
                key
            )),
            Some("WezTerm".to_string())
        );
    }

    #[test]
    fn build_grrr_command_uses_none_sound_when_terminal_focused() {
        let cmd = build_grrr_command(GrrrNotification {
            session: None,
            app_id: "Claude",
            title: "Claude Code",
            subtitle: "Ready",
            message: "Ready",
            sound: "Hero",
            icon_path: None,
            terminal_focused: true,
        });
        let args: Vec<_> = cmd.get_args().collect();
        let args: Vec<&str> = args.iter().map(|a| a.to_str().unwrap()).collect();
        let sound_pos = args.iter().position(|&a| a == "--sound").unwrap();
        assert_eq!(args[sound_pos + 1], "none");
    }

    #[test]
    fn build_grrr_command_uses_provided_sound_when_not_focused() {
        let cmd = build_grrr_command(GrrrNotification {
            session: None,
            app_id: "Claude",
            title: "Claude Code",
            subtitle: "Ready",
            message: "Ready",
            sound: "Hero",
            icon_path: None,
            terminal_focused: false,
        });
        let args: Vec<_> = cmd.get_args().collect();
        let args: Vec<&str> = args.iter().map(|a| a.to_str().unwrap()).collect();
        let sound_pos = args.iter().position(|&a| a == "--sound").unwrap();
        assert_eq!(args[sound_pos + 1], "Hero");
    }

    #[test]
    fn build_grrr_command_sets_thread_and_identifier_for_session() {
        let cmd = build_grrr_command(GrrrNotification {
            session: Some("work"),
            app_id: "Claude",
            title: "work",
            subtitle: "Done",
            message: "Done",
            sound: "Hero",
            icon_path: None,
            terminal_focused: false,
        });
        let args: Vec<_> = cmd.get_args().collect();
        let args: Vec<&str> = args.iter().map(|a| a.to_str().unwrap()).collect();
        assert!(args.contains(&"--threadId"));
        assert!(args.contains(&"claude-work"));
        assert!(args.contains(&"--identifier"));
    }

    #[test]
    fn build_grrr_command_no_thread_flags_when_no_session() {
        let cmd = build_grrr_command(GrrrNotification {
            session: None,
            app_id: "Claude",
            title: "Claude Code",
            subtitle: "Ready",
            message: "Ready",
            sound: "Hero",
            icon_path: None,
            terminal_focused: false,
        });
        let args: Vec<_> = cmd.get_args().collect();
        let args: Vec<&str> = args.iter().map(|a| a.to_str().unwrap()).collect();
        assert!(!args.contains(&"--threadId"));
        assert!(!args.contains(&"--identifier"));
    }

    #[test]
    fn build_grrr_command_skips_image_flag_when_no_icon() {
        let cmd = build_grrr_command(GrrrNotification {
            session: None,
            app_id: "Claude",
            title: "Claude Code",
            subtitle: "Ready",
            message: "Ready",
            sound: "Hero",
            icon_path: None,
            terminal_focused: false,
        });
        let args: Vec<_> = cmd.get_args().collect();
        let args: Vec<&str> = args.iter().map(|a| a.to_str().unwrap()).collect();
        assert!(!args.contains(&"--image"));
    }

    #[test]
    fn build_grrr_command_uses_pi_as_the_notification_app() {
        let cmd = build_grrr_command(GrrrNotification {
            session: None,
            app_id: "Pi",
            title: "Pi",
            subtitle: "Ready",
            message: "Ready",
            sound: "Hero",
            icon_path: None,
            terminal_focused: false,
        });
        let args: Vec<_> = cmd.get_args().collect();
        let args: Vec<&str> = args.iter().map(|arg| arg.to_str().unwrap()).collect();
        let app_id_pos = args.iter().position(|&arg| arg == "--appId").unwrap();
        assert_eq!(args[app_id_pos + 1], "Pi");
    }

    #[test]
    fn app_registration_uses_notification_icon_for_pi() {
        let icon = NamedTempFile::new().unwrap();
        let cmd = build_app_registration_command("Pi", Some(icon.path()));
        let args: Vec<_> = cmd.get_args().collect();
        let args: Vec<&str> = args.iter().map(|arg| arg.to_str().unwrap()).collect();
        let icon_pos = args.iter().position(|&arg| arg == "--appIcon").unwrap();
        assert_eq!(args[icon_pos + 1], icon.path().to_str().unwrap());
    }

    #[test]
    fn terminal_app_detects_source_alacritty_env() {
        assert_eq!(
            terminal_app_from_env(|key| env_value(&[("TERM_PROGRAM", "Alacritty")], key)),
            Some("Alacritty".to_string())
        );
    }

    #[test]
    fn terminal_app_detects_source_bootty_env() {
        assert_eq!(
            terminal_app_from_env(|key| {
                env_value(
                    &[("TERM_PROGRAM", "ghostty"), ("TERM", "xterm-bootty")],
                    key,
                )
            }),
            Some("Bootty".to_string())
        );
    }
}
