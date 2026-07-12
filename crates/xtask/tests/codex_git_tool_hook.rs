use std::fs;
use std::io::Write;
use std::process::{Command, Stdio};

fn run_hook(repo: &std::path::Path) -> std::process::Output {
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("codex/hooks/sync-git-tool.sh");
    let mut child = Command::new("bash")
        .arg(script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    write!(
        child.stdin.take().unwrap(),
        r#"{{"cwd":"{}"}}"#,
        repo.display()
    )
    .unwrap();
    child.wait_with_output().unwrap()
}

fn git(repo: &std::path::Path, args: &[&str]) {
    let status = Command::new("git")
        .args(["-C", repo.to_str().unwrap()])
        .args(args)
        .status()
        .unwrap();
    assert!(status.success());
}

#[test]
fn hook_selects_only_the_configured_stack_plugin_and_clears_main_repos() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path();
    git(repo, &["init", "-q"]);

    git(repo, &["config", "agents.git-tool", "git-spice"]);
    assert!(run_hook(repo).status.success());
    let config = fs::read_to_string(repo.join(".codex/config.toml")).unwrap();
    assert!(config.contains("[plugins.\"gs@agents\"]\nenabled = true"));
    assert!(config.contains("[plugins.\"gt@agents\"]\nenabled = false"));

    git(repo, &["config", "agents.git-tool", "graphite"]);
    assert!(run_hook(repo).status.success());
    let config = fs::read_to_string(repo.join(".codex/config.toml")).unwrap();
    assert!(config.contains("[plugins.\"gt@agents\"]\nenabled = true"));
    assert!(config.contains("[plugins.\"gs@agents\"]\nenabled = false"));

    git(repo, &["config", "--unset", "agents.git-tool"]);
    assert!(run_hook(repo).status.success());
    assert!(!repo.join(".codex/config.toml").exists());
}
