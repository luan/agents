use std::env;
use std::fs::{self, read_to_string};
use std::path::{Path, PathBuf};

use regex::Regex;
use serde::Deserialize;

#[derive(Default, Deserialize)]
struct Permissions {
    #[serde(default)]
    deny: Vec<String>,
}

#[derive(Default, Deserialize)]
struct Settings {
    #[serde(default)]
    permissions: Permissions,
}

#[derive(Clone, Debug, Default)]
pub struct SecurityPolicy {
    pub deny: Vec<String>,
}

pub fn read_bash_policies(project_dir: Option<&str>) -> Vec<SecurityPolicy> {
    let mut policies = Vec::new();
    if let Some(project_dir) = project_dir.filter(|value| !value.is_empty()) {
        for path in [
            Path::new(project_dir).join(".pi/settings.local.json"),
            Path::new(project_dir).join(".pi/settings.json"),
        ] {
            if let Some(policy) = read_single_settings(&path, Some("Bash")) {
                policies.push(policy);
            }
        }
    }
    for path in resolve_pi_global_settings_paths() {
        if let Some(policy) = read_single_settings(&path, Some("Bash")) {
            policies.push(policy);
        }
    }
    policies
}

pub fn read_tool_deny_patterns(tool_name: &str, project_dir: Option<&str>) -> Vec<Vec<String>> {
    let mut patterns = Vec::new();
    if let Some(project_dir) = project_dir.filter(|value| !value.is_empty()) {
        for path in [
            Path::new(project_dir).join(".pi/settings.local.json"),
            Path::new(project_dir).join(".pi/settings.json"),
        ] {
            if let Some(globs) = read_tool_deny_file(&path, tool_name) {
                patterns.push(globs);
            }
        }
    }
    for path in resolve_pi_global_settings_paths() {
        if let Some(globs) = read_tool_deny_file(&path, tool_name) {
            patterns.push(globs);
        }
    }
    patterns
}

fn read_single_settings(path: &Path, tool_name: Option<&str>) -> Option<SecurityPolicy> {
    let raw = read_to_string(path).ok()?;
    let parsed = serde_json::from_str::<Settings>(&raw).ok()?;
    let deny = parsed
        .permissions
        .deny
        .into_iter()
        .filter_map(|entry| match tool_name {
            Some("Bash") => parse_bash_pattern(&entry),
            Some(tool) => parse_tool_pattern(&entry)
                .and_then(|(name, glob)| if name == tool { Some(glob) } else { None }),
            None => Some(entry),
        })
        .collect::<Vec<_>>();
    Some(SecurityPolicy { deny })
}

fn read_tool_deny_file(path: &Path, tool_name: &str) -> Option<Vec<String>> {
    let raw = read_to_string(path).ok()?;
    let parsed = serde_json::from_str::<Settings>(&raw).ok()?;
    Some(
        parsed
            .permissions
            .deny
            .into_iter()
            .filter_map(|entry| {
                parse_tool_pattern(&entry).and_then(|(name, glob)| {
                    if name == tool_name { Some(glob) } else { None }
                })
            })
            .collect(),
    )
}

fn resolve_pi_global_settings_paths() -> Vec<PathBuf> {
    vec![resolve_pi_config_dir().join("settings.json")]
}

fn resolve_pi_config_dir() -> PathBuf {
    if let Ok(value) = env::var("PI_CONFIG_DIR") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            if trimmed.starts_with('~')
                && let Some(home) = home_dir()
            {
                return home.join(
                    trimmed
                        .trim_start_matches('~')
                        .trim_start_matches(['/', '\\']),
                );
            }
            return PathBuf::from(trimmed);
        }
    }
    home_dir().unwrap_or_else(|| PathBuf::from(".")).join(".pi")
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("USERPROFILE").map(PathBuf::from))
}

fn parse_bash_pattern(pattern: &str) -> Option<String> {
    let captures = Regex::new(r"^Bash\((.+)\)$")
        .expect("bash pattern regex")
        .captures(pattern)?;
    Some(captures.get(1)?.as_str().to_string())
}

fn parse_tool_pattern(pattern: &str) -> Option<(String, String)> {
    let captures = Regex::new(r"^(\w+)\((.+)\)$")
        .expect("tool pattern regex")
        .captures(pattern)?;
    Some((
        captures.get(1)?.as_str().to_string(),
        captures.get(2)?.as_str().to_string(),
    ))
}

fn glob_to_regex(glob: &str, case_insensitive: bool) -> Regex {
    let regex = if let Some(colon_idx) = glob.find(':') {
        let command = regex::escape(&glob[..colon_idx]);
        let args = convert_glob_part(&glob[colon_idx + 1..]);
        format!("^{command}(\\s{args})?$")
    } else if let Some(prefix) = glob.strip_suffix(" *") {
        let prefix = convert_glob_part(prefix);
        format!("^{prefix}(?:\\s.*)?$")
    } else {
        format!("^{}$", convert_glob_part(glob))
    };
    Regex::new(&if case_insensitive {
        format!("(?i){regex}")
    } else {
        regex
    })
    .expect("glob regex")
}

fn convert_glob_part(glob: &str) -> String {
    let mut out = String::new();
    for ch in glob.chars() {
        if ch == '*' {
            out.push_str(".*");
        } else {
            out.push_str(&regex::escape(&ch.to_string()));
        }
    }
    out
}

fn file_glob_to_regex(glob: &str, case_insensitive: bool) -> Regex {
    let mut regex = String::from("^");
    let chars = glob.chars().collect::<Vec<_>>();
    let mut i = 0usize;
    while i < chars.len() {
        match chars[i] {
            '*' if i + 1 < chars.len() && chars[i + 1] == '*' => {
                if i + 2 < chars.len() && chars[i + 2] == '/' {
                    regex.push_str("(.*/)?");
                    i += 3;
                } else {
                    regex.push_str(".*");
                    i += 2;
                }
            }
            '*' => {
                regex.push_str("[^/]*");
                i += 1;
            }
            '?' => {
                regex.push_str("[^/]");
                i += 1;
            }
            ch => {
                regex.push_str(&regex::escape(&ch.to_string()));
                i += 1;
            }
        }
    }
    regex.push('$');
    Regex::new(&if case_insensitive {
        format!("(?i){regex}")
    } else {
        regex
    })
    .expect("file glob regex")
}

pub fn split_chained_commands(command: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let mut in_backtick = false;
    let chars = command.chars().collect::<Vec<_>>();
    let mut i = 0usize;
    while i < chars.len() {
        let ch = chars[i];
        let prev = if i > 0 { chars[i - 1] } else { '\0' };
        if ch == '\'' && !in_double && !in_backtick && prev != '\\' {
            in_single = !in_single;
            current.push(ch);
        } else if ch == '"' && !in_single && !in_backtick && prev != '\\' {
            in_double = !in_double;
            current.push(ch);
        } else if ch == '`' && !in_single && !in_double && prev != '\\' {
            in_backtick = !in_backtick;
            current.push(ch);
        } else if !in_single && !in_double && !in_backtick {
            if ch == ';' {
                push_segment(&mut parts, &mut current);
            } else if matches!(ch, '|' | '&') && i + 1 < chars.len() && chars[i + 1] == ch {
                push_segment(&mut parts, &mut current);
                i += 1;
            } else if ch == '|' {
                push_segment(&mut parts, &mut current);
            } else {
                current.push(ch);
            }
        } else {
            current.push(ch);
        }
        i += 1;
    }
    push_segment(&mut parts, &mut current);
    parts
}

fn push_segment(parts: &mut Vec<String>, current: &mut String) {
    let trimmed = current.trim();
    if !trimmed.is_empty() {
        parts.push(trimmed.to_string());
    }
    current.clear();
}

pub fn evaluate_command_deny_only(
    command: &str,
    policies: &[SecurityPolicy],
    case_insensitive: bool,
) -> Option<String> {
    for segment in split_chained_commands(command) {
        for policy in policies {
            for pattern in &policy.deny {
                if glob_to_regex(pattern, case_insensitive).is_match(&segment) {
                    return Some(pattern.clone());
                }
            }
        }
    }
    None
}

pub fn evaluate_file_path(
    file_path: &str,
    deny_globs: &[Vec<String>],
    case_insensitive: bool,
    project_root: Option<&str>,
) -> Option<String> {
    let mut candidates = vec![file_path.replace('\\', "/")];
    if let Some(project_root) = project_root.filter(|value| !value.is_empty()) {
        let lexical = if Path::new(file_path).is_absolute() {
            PathBuf::from(file_path)
        } else {
            Path::new(project_root).join(file_path)
        };
        candidates.push(lexical.to_string_lossy().replace('\\', "/"));
        if let Ok(relative) = lexical.strip_prefix(project_root) {
            candidates.push(relative.to_string_lossy().replace('\\', "/"));
        }
        if let Ok(real) = fs::canonicalize(&lexical) {
            candidates.push(real.to_string_lossy().replace('\\', "/"));
            if let Ok(relative) = real.strip_prefix(project_root) {
                candidates.push(relative.to_string_lossy().replace('\\', "/"));
            }
        }
    }

    for globs in deny_globs {
        for glob in globs {
            let regex = file_glob_to_regex(&glob.replace('\\', "/"), case_insensitive);
            for candidate in &candidates {
                if regex.is_match(candidate) {
                    return Some(glob.clone());
                }
            }
        }
    }

    None
}

pub fn extract_shell_commands(code: &str, language: &str) -> Vec<String> {
    let mut commands = Vec::new();
    for pattern in patterns_for_language(language) {
        for captures in pattern.captures_iter(code) {
            for index in 1..captures.len() {
                if let Some(command) = captures
                    .get(index)
                    .filter(|group| !group.as_str().is_empty())
                {
                    commands.push(command.as_str().to_string());
                    break;
                }
            }
        }
    }
    if language == "python" {
        let list_pattern = Regex::new(
            r#"subprocess\.(?:run|call|Popen|check_output|check_call)\(\s*\[([^\]]+)\]"#,
        )
        .expect("python subprocess list regex");
        let arg_pattern = Regex::new(r#""([^"]*)"|'([^']*)'"#).expect("python arg regex");
        for captures in list_pattern.captures_iter(code) {
            let list_content = captures.get(1).map(|m| m.as_str()).unwrap_or("");
            let args = arg_pattern
                .captures_iter(list_content)
                .filter_map(|m| {
                    m.get(1)
                        .or_else(|| m.get(2))
                        .map(|group| group.as_str().to_string())
                })
                .collect::<Vec<_>>();
            if !args.is_empty() {
                commands.push(args.join(" "));
            }
        }
    }
    commands
}

fn patterns_for_language(language: &str) -> Vec<Regex> {
    let raw_patterns = match language {
        "python" => vec![
            r#"os\.system\(\s*(?:"([^"]*)"|'([^']*)')\s*\)"#,
            r#"subprocess\.(?:run|call|Popen|check_output|check_call)\(\s*(?:"([^"]*)"|'([^']*)')"#,
        ],
        "javascript" | "typescript" => vec![
            r#"exec(?:Sync|File|FileSync)?\(\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)"#,
            r#"spawn(?:Sync)?\(\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)"#,
        ],
        "ruby" => vec![r#"system\(\s*(?:"([^"]*)"|'([^']*)')"#, r#"`(.*?)`"#],
        "go" => vec![r#"exec\.Command\(\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)"#],
        "php" => vec![
            r#"shell_exec\(\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)"#,
            r#"(?:^|[^.])exec\(\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)"#,
            r#"(?:^|[^.])system\(\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)"#,
            r#"passthru\(\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)"#,
            r#"proc_open\(\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)"#,
        ],
        "rust" => vec![r#"Command::new\(\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)"#],
        _ => Vec::new(),
    };
    raw_patterns
        .into_iter()
        .map(|pattern| Regex::new(pattern).expect("shell escape regex"))
        .collect()
}
