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

#[test]
fn task_blockers_reject_cycles_and_referenced_deletes() {
    let project = project_dir();
    let state = tempfile::tempdir().expect("state dir");

    let first = ct_cmd(project.path(), state.path())
        .args(["task", "add", "First", "--json"])
        .assert()
        .success();
    let first_json: serde_json::Value =
        serde_json::from_slice(&first.get_output().stdout).expect("first json");
    let first_id = first_json["task"]["id"].as_str().expect("first id");

    let second = ct_cmd(project.path(), state.path())
        .args(["task", "add", "Second", "--blocked-by", first_id, "--json"])
        .assert()
        .success();
    let second_json: serde_json::Value =
        serde_json::from_slice(&second.get_output().stdout).expect("second json");
    let second_id = second_json["task"]["id"].as_str().expect("second id");

    ct_cmd(project.path(), state.path())
        .args(["task", "update", first_id, "--blocked-by", second_id])
        .assert()
        .failure()
        .stderr(predicate::str::contains("cycle"));

    ct_cmd(project.path(), state.path())
        .args(["task", "delete", first_id])
        .assert()
        .failure()
        .stderr(predicate::str::contains("cannot delete task"));
}

#[test]
fn task_epic_metadata_persists_updates_and_clears() {
    let project = project_dir();
    let state = tempfile::tempdir().expect("state dir");

    let add = ct_cmd(project.path(), state.path())
        .args([
            "task",
            "add",
            "Build board",
            "--epic-id",
            "task-board",
            "--epic-title",
            "Task Board",
            "--json",
        ])
        .assert()
        .success();
    let add_json: serde_json::Value =
        serde_json::from_slice(&add.get_output().stdout).expect("add json");
    let id = add_json["task"]["id"].as_str().expect("id");
    assert_eq!(add_json["task"]["epic_id"], "task-board");
    assert_eq!(add_json["task"]["epic_title"], "Task Board");

    let update = ct_cmd(project.path(), state.path())
        .args([
            "task",
            "update",
            id,
            "--epic-id",
            "task-board-v2",
            "--epic-title",
            "Task Board V2",
            "--json",
        ])
        .assert()
        .success();
    let update_json: serde_json::Value =
        serde_json::from_slice(&update.get_output().stdout).expect("update json");
    assert_eq!(update_json["task"]["epic_id"], "task-board-v2");
    assert_eq!(update_json["task"]["epic_title"], "Task Board V2");

    let list = ct_cmd(project.path(), state.path())
        .args(["task", "list", "--all", "--json"])
        .assert()
        .success();
    let list_json: serde_json::Value =
        serde_json::from_slice(&list.get_output().stdout).expect("list json");
    assert_eq!(list_json["tasks"][0]["epic_id"], "task-board-v2");

    let clear = ct_cmd(project.path(), state.path())
        .args(["task", "update", id, "--clear-epic", "--json"])
        .assert()
        .success();
    let clear_json: serde_json::Value =
        serde_json::from_slice(&clear.get_output().stdout).expect("clear json");
    assert!(clear_json["task"]["epic_id"].is_null());
    assert!(clear_json["task"]["epic_title"].is_null());
}

#[test]
fn task_list_sorts_ready_tasks_before_blocked_then_by_priority() {
    let project = project_dir();
    let state = tempfile::tempdir().expect("state dir");

    let blocker = ct_cmd(project.path(), state.path())
        .args(["task", "add", "Ready blocker", "--priority", "0", "--json"])
        .assert()
        .success();
    let blocker_json: serde_json::Value =
        serde_json::from_slice(&blocker.get_output().stdout).expect("blocker json");
    let blocker_id = blocker_json["task"]["id"].as_str().expect("blocker id");

    ct_cmd(project.path(), state.path())
        .args([
            "task",
            "add",
            "Blocked high priority",
            "--priority",
            "100",
            "--blocked-by",
            blocker_id,
            "--json",
        ])
        .assert()
        .success();
    ct_cmd(project.path(), state.path())
        .args([
            "task",
            "add",
            "Ready low priority",
            "--priority",
            "1",
            "--json",
        ])
        .assert()
        .success();
    ct_cmd(project.path(), state.path())
        .args([
            "task",
            "add",
            "Ready high priority",
            "--priority",
            "5",
            "--json",
        ])
        .assert()
        .success();

    let list = ct_cmd(project.path(), state.path())
        .args(["task", "list", "--json"])
        .assert()
        .success();
    let list_json: serde_json::Value =
        serde_json::from_slice(&list.get_output().stdout).expect("list json");
    let titles = list_json["tasks"]
        .as_array()
        .expect("tasks")
        .iter()
        .map(|task| task["title"].as_str().expect("title"))
        .collect::<Vec<_>>();

    assert_eq!(
        titles,
        vec![
            "Ready high priority",
            "Ready low priority",
            "Ready blocker",
            "Blocked high priority",
        ]
    );
    assert_eq!(list_json["tasks"][0]["priority"], 5);
}

#[test]
fn task_list_uses_full_blocker_statuses_for_default_active_view() {
    let project = project_dir();
    let state = tempfile::tempdir().expect("state dir");

    let blocker = ct_cmd(project.path(), state.path())
        .args(["task", "add", "Done blocker", "--json"])
        .assert()
        .success();
    let blocker_json: serde_json::Value =
        serde_json::from_slice(&blocker.get_output().stdout).expect("blocker json");
    let blocker_id = blocker_json["task"]["id"].as_str().expect("blocker id");

    ct_cmd(project.path(), state.path())
        .args(["task", "update", blocker_id, "--status", "done"])
        .assert()
        .success();
    ct_cmd(project.path(), state.path())
        .args([
            "task",
            "add",
            "Ready because blocker is done",
            "--blocked-by",
            blocker_id,
            "--json",
        ])
        .assert()
        .success();

    let list = ct_cmd(project.path(), state.path())
        .args(["task", "list", "--json"])
        .assert()
        .success();
    let list_json: serde_json::Value =
        serde_json::from_slice(&list.get_output().stdout).expect("list json");
    let tasks = list_json["tasks"].as_array().expect("tasks");
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0]["title"], "Ready because blocker is done");
}

#[test]
fn task_assignment_filters_and_clears() {
    let project = project_dir();
    let state = tempfile::tempdir().expect("state dir");

    let assigned = ct_cmd(project.path(), state.path())
        .args([
            "task",
            "add",
            "Assigned work",
            "--assigned-to",
            "session:abc",
            "--json",
        ])
        .assert()
        .success();
    let assigned_json: serde_json::Value =
        serde_json::from_slice(&assigned.get_output().stdout).expect("assigned json");
    let id = assigned_json["task"]["id"].as_str().expect("assigned id");
    assert_eq!(assigned_json["task"]["assigned_to"], "session:abc");

    ct_cmd(project.path(), state.path())
        .args(["task", "add", "Other work", "--json"])
        .assert()
        .success();

    let filtered = ct_cmd(project.path(), state.path())
        .args([
            "task",
            "list",
            "--assigned-to",
            "session:abc",
            "--all",
            "--json",
        ])
        .assert()
        .success();
    let filtered_json: serde_json::Value =
        serde_json::from_slice(&filtered.get_output().stdout).expect("filtered json");
    let tasks = filtered_json["tasks"].as_array().expect("tasks");
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0]["title"], "Assigned work");

    ct_cmd(project.path(), state.path())
        .args(["task", "update", id, "--status", "done"])
        .assert()
        .success();
    let active_filtered = ct_cmd(project.path(), state.path())
        .args(["task", "list", "--assigned-to", "session:abc", "--json"])
        .assert()
        .success();
    let active_filtered_json: serde_json::Value =
        serde_json::from_slice(&active_filtered.get_output().stdout).expect("active filtered json");
    assert!(
        active_filtered_json["tasks"]
            .as_array()
            .expect("tasks")
            .is_empty()
    );

    ct_cmd(project.path(), state.path())
        .args(["task", "update", id, "--clear-assignee", "--json"])
        .assert()
        .success()
        .stdout(predicate::str::contains("\"assigned_to\": null"));
}
