use std::fs;
use std::path::Path;
use std::process::Command as StdCommand;

use assert_cmd::Command;
use predicates::prelude::*;
use tempfile::TempDir;

fn project_dir() -> TempDir {
    let dir = tempfile::tempdir().expect("project dir");
    run_git(dir.path(), &["init", "--initial-branch=main"]);
    dir
}

fn run_git(cwd: &Path, args: &[&str]) {
    let status = StdCommand::new("git")
        .current_dir(cwd)
        .args(args)
        .env("GIT_AUTHOR_NAME", "ct-test")
        .env("GIT_AUTHOR_EMAIL", "ct-test@example.com")
        .env("GIT_COMMITTER_NAME", "ct-test")
        .env("GIT_COMMITTER_EMAIL", "ct-test@example.com")
        .status()
        .unwrap_or_else(|e| panic!("git {args:?} failed: {e}"));
    assert!(status.success(), "git {args:?} exited {status}");
}

fn ct_cmd(project: &Path, state: &Path) -> Command {
    let mut cmd = Command::cargo_bin("ct").expect("ct binary");
    cmd.current_dir(project).env("XDG_STATE_HOME", state);
    cmd
}

#[test]
fn task_lifecycle_persists_and_supports_json() {
    let project = project_dir();
    let state = tempfile::tempdir().expect("state dir");

    let add = ct_cmd(project.path(), state.path())
        .args([
            "task",
            "add",
            "Write task docs",
            "--body",
            "Explain the persisted task workflow",
            "--json",
        ])
        .assert()
        .success();
    let add_stdout = String::from_utf8(add.get_output().stdout.clone()).expect("utf8");
    let add_json: serde_json::Value = serde_json::from_str(&add_stdout).expect("add json");
    let id = add_json["task"]["id"].as_str().expect("id").to_string();
    assert!(
        id.chars()
            .all(|c| "0123456789abcdefghjkmnpqrstvwxyz".contains(c))
    );
    assert_eq!(id.len(), 1, "single task displays minimum unique prefix");
    assert_eq!(add_json["task"]["status"], "open");

    ct_cmd(project.path(), state.path())
        .args(["task", "list"])
        .assert()
        .success()
        .stdout(predicate::str::contains(&id))
        .stdout(predicate::str::contains("Write task docs"));

    let prefix = id.as_str();
    let update = ct_cmd(project.path(), state.path())
        .args([
            "task",
            "update",
            prefix,
            "--status",
            "done",
            "--title",
            "Document task tools",
            "--json",
        ])
        .assert()
        .success();
    let update_json: serde_json::Value =
        serde_json::from_slice(&update.get_output().stdout).expect("update json");
    assert_eq!(update_json["task"]["id"], id);
    assert_eq!(update_json["task"]["status"], "done");
    assert_eq!(update_json["task"]["title"], "Document task tools");

    let show = ct_cmd(project.path(), state.path())
        .args(["task", "show", prefix, "--json"])
        .assert()
        .success();
    let show_json: serde_json::Value =
        serde_json::from_slice(&show.get_output().stdout).expect("show json");
    assert_eq!(show_json["task"]["id"], id);
    assert_eq!(
        show_json["task"]["body"],
        "Explain the persisted task workflow"
    );

    ct_cmd(project.path(), state.path())
        .args(["task", "delete", prefix, "--json"])
        .assert()
        .success()
        .stdout(predicate::str::contains("\"deleted\""));

    ct_cmd(project.path(), state.path())
        .args(["task", "show", &id, "--json"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("no task matches"));
}

#[test]
fn task_prefix_lookup_rejects_ambiguous_prefixes() {
    let project = project_dir();
    let state = tempfile::tempdir().expect("state dir");
    let db_dir = state.path().join("ct/projects/manual");
    fs::create_dir_all(&db_dir).expect("db dir");

    ct_cmd(project.path(), state.path())
        .args(["task", "add", "seed"])
        .assert()
        .success();

    let db_path = fs::read_dir(state.path().join("ct/projects"))
        .expect("projects dir")
        .filter_map(Result::ok)
        .find_map(|entry| {
            let path = entry.path().join("tasks").join("tasks.sqlite");
            path.exists().then_some(path)
        })
        .expect("tasks sqlite");

    let conn = rusqlite::Connection::open(db_path).expect("open db");
    conn.execute(
        "INSERT INTO tasks (id, title, body, status, created_at, updated_at) VALUES (?1, ?2, '', 'open', 1, 1)",
        ("ABCDEF12", "first"),
    )
    .expect("insert first");
    conn.execute(
        "INSERT INTO tasks (id, title, body, status, created_at, updated_at) VALUES (?1, ?2, '', 'open', 2, 2)",
        ("ABCDEFFF", "second"),
    )
    .expect("insert second");

    ct_cmd(project.path(), state.path())
        .args(["task", "show", "abcd"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("ambiguous task id prefix"))
        .stderr(predicate::str::contains("abcdef1  open  first"))
        .stderr(predicate::str::contains("abcdeff  open  second"));

    ct_cmd(project.path(), state.path())
        .args(["task", "show", "abcdef1"])
        .assert()
        .success()
        .stdout(predicate::str::contains("first"))
        .stdout(predicate::str::contains("abcdef1"));
}

#[test]
fn task_blocked_by_is_a_simple_id_array() {
    let project = project_dir();
    let state = tempfile::tempdir().expect("state dir");

    let blocker = ct_cmd(project.path(), state.path())
        .args(["task", "add", "Implement API", "--json"])
        .assert()
        .success();
    let blocker_json: serde_json::Value =
        serde_json::from_slice(&blocker.get_output().stdout).expect("blocker json");
    let blocker_id = blocker_json["task"]["id"].as_str().expect("blocker id");

    let blocked = ct_cmd(project.path(), state.path())
        .args([
            "task",
            "add",
            "Render DAG",
            "--blocked-by",
            blocker_id,
            "--json",
        ])
        .assert()
        .success();
    let blocked_json: serde_json::Value =
        serde_json::from_slice(&blocked.get_output().stdout).expect("blocked json");
    assert_eq!(
        blocked_json["task"]["blocked_by"]
            .as_array()
            .expect("blocked_by")
            .len(),
        1
    );

    let list = ct_cmd(project.path(), state.path())
        .args(["task", "list", "--all", "--json"])
        .assert()
        .success();
    let list_json: serde_json::Value =
        serde_json::from_slice(&list.get_output().stdout).expect("list json");
    let tasks = list_json["tasks"].as_array().expect("tasks");
    let displayed_blocker = tasks
        .iter()
        .find(|task| task["title"] == "Implement API")
        .and_then(|task| task["id"].as_str())
        .expect("displayed blocker");
    let displayed_blocked = tasks
        .iter()
        .find(|task| task["title"] == "Render DAG")
        .expect("displayed blocked");
    assert_eq!(displayed_blocked["blocked_by"][0], displayed_blocker);

    let blocked_id = displayed_blocked["id"].as_str().expect("blocked id");
    ct_cmd(project.path(), state.path())
        .args(["task", "update", blocked_id, "--clear-blockers", "--json"])
        .assert()
        .success()
        .stdout(predicate::str::contains("\"blocked_by\": []"));
}
