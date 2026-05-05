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
            "--type",
            "chore",
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
    assert_eq!(add_json["task"]["type"], "chore");
    assert_eq!(
        add_json["task"]["labels"].as_array().expect("labels").len(),
        0
    );

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
fn task_type_and_labels_persist_update_and_filter() {
    let project = project_dir();
    let state = tempfile::tempdir().expect("state dir");

    ct_cmd(project.path(), state.path())
        .args(["task", "add", "Missing type"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("task type is required"));

    ct_cmd(project.path(), state.path())
        .args(["task", "add", "Bad type", "--type", "story"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("invalid task type"));

    ct_cmd(project.path(), state.path())
        .args([
            "task",
            "add",
            "Bad label",
            "--type",
            "feature",
            "--label",
            "Not Kebab",
        ])
        .assert()
        .failure()
        .stderr(predicate::str::contains("invalid task label"));

    ct_cmd(project.path(), state.path())
        .args([
            "task",
            "add",
            "Task board epic",
            "--type",
            "epic",
            "--epic-id",
            "task-board",
        ])
        .assert()
        .success();
    ct_cmd(project.path(), state.path())
        .args([
            "task",
            "add",
            "Other epic",
            "--type",
            "epic",
            "--epic-id",
            "other-epic",
        ])
        .assert()
        .success();

    let add = ct_cmd(project.path(), state.path())
        .args([
            "task",
            "add",
            "Implement labels",
            "--type",
            "feature",
            "--label",
            "setup",
            "--label",
            "agent-ui",
            "--label",
            "setup",
            "--epic-id",
            "task-board",
            "--json",
        ])
        .assert()
        .success();
    let add_json: serde_json::Value =
        serde_json::from_slice(&add.get_output().stdout).expect("add json");
    let id = add_json["task"]["id"].as_str().expect("id");
    assert_eq!(add_json["task"]["type"], "feature");
    assert_eq!(
        add_json["task"]["labels"],
        serde_json::json!(["setup", "agent-ui"])
    );

    let update = ct_cmd(project.path(), state.path())
        .args([
            "task",
            "update",
            id,
            "--type",
            "bug",
            "--label",
            "regression",
            "--json",
        ])
        .assert()
        .success();
    let update_json: serde_json::Value =
        serde_json::from_slice(&update.get_output().stdout).expect("update json");
    assert_eq!(update_json["task"]["type"], "bug");
    assert_eq!(
        update_json["task"]["labels"],
        serde_json::json!(["regression"])
    );

    ct_cmd(project.path(), state.path())
        .args([
            "task",
            "add",
            "Other feature",
            "--type",
            "feature",
            "--label",
            "regression",
            "--epic-id",
            "other-epic",
            "--json",
        ])
        .assert()
        .success();

    let filtered = ct_cmd(project.path(), state.path())
        .args([
            "task",
            "list",
            "--all",
            "--type",
            "bug",
            "--label",
            "regression",
            "--epic-id",
            "task-board",
            "--json",
        ])
        .assert()
        .success();
    let filtered_json: serde_json::Value =
        serde_json::from_slice(&filtered.get_output().stdout).expect("filtered json");
    let tasks = filtered_json["tasks"].as_array().expect("tasks");
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0]["title"], "Implement labels");
}

#[test]
fn task_legacy_rows_without_type_or_labels_display_as_chores() {
    let project = project_dir();
    let state = tempfile::tempdir().expect("state dir");

    ct_cmd(project.path(), state.path())
        .args(["task", "add", "Seed", "--type", "chore"])
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
    conn.execute("ALTER TABLE tasks RENAME TO tasks_new", [])
        .expect("rename table");
    conn.execute(
        "CREATE TABLE tasks (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            body TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL,
            priority INTEGER NOT NULL DEFAULT 0,
            assigned_to TEXT,
            assigned_label TEXT,
            epic_id TEXT,
            epic_title TEXT,
            parent_id TEXT,
            blocked_by TEXT NOT NULL DEFAULT '[]',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )",
        [],
    )
    .expect("create legacy table");
    conn.execute(
        "INSERT INTO tasks (id, title, body, status, created_at, updated_at) VALUES (?1, ?2, '', 'open', 1, 1)",
        ("ABCDEF", "legacy task"),
    )
    .expect("insert legacy");
    drop(conn);

    let list = ct_cmd(project.path(), state.path())
        .args(["task", "list", "--all", "--json"])
        .assert()
        .success();
    let list_json: serde_json::Value =
        serde_json::from_slice(&list.get_output().stdout).expect("list json");
    let legacy = list_json["tasks"]
        .as_array()
        .expect("tasks")
        .iter()
        .find(|task| task["title"] == "legacy task")
        .expect("legacy task");
    assert_eq!(legacy["type"], "chore");
    assert_eq!(legacy["labels"], serde_json::json!([]));
}

#[test]
fn task_epic_labels_are_required_unique_and_validate_membership() {
    let project = project_dir();
    let state = tempfile::tempdir().expect("state dir");

    ct_cmd(project.path(), state.path())
        .args(["task", "add", "Epic without label", "--type", "epic"])
        .assert()
        .failure()
        .stderr(predicate::str::contains("epic tasks require --epic-id"));

    ct_cmd(project.path(), state.path())
        .args([
            "task",
            "add",
            "Bad epic label",
            "--type",
            "epic",
            "--epic-id",
            "Not Kebab",
        ])
        .assert()
        .failure()
        .stderr(predicate::str::contains("invalid epic label"));

    let epic = ct_cmd(project.path(), state.path())
        .args([
            "task",
            "add",
            "Task Board",
            "--type",
            "epic",
            "--epic-id",
            "task-board",
            "--json",
        ])
        .assert()
        .success();
    let epic_json: serde_json::Value =
        serde_json::from_slice(&epic.get_output().stdout).expect("epic json");
    let epic_id = epic_json["task"]["id"].as_str().expect("epic id");

    ct_cmd(project.path(), state.path())
        .args([
            "task",
            "add",
            "Duplicate Epic",
            "--type",
            "epic",
            "--epic-id",
            "task-board",
        ])
        .assert()
        .failure()
        .stderr(predicate::str::contains("already exists"));

    ct_cmd(project.path(), state.path())
        .args([
            "task",
            "add",
            "Orphan child",
            "--type",
            "feature",
            "--epic-id",
            "missing-epic",
        ])
        .assert()
        .failure()
        .stderr(predicate::str::contains("no epic task has label"));

    ct_cmd(project.path(), state.path())
        .args([
            "task",
            "add",
            "Feature child",
            "--type",
            "feature",
            "--epic-id",
            "task-board",
            "--json",
        ])
        .assert()
        .success()
        .stdout(predicate::str::contains("\"epic_id\": \"task-board\""));

    let parent = ct_cmd(project.path(), state.path())
        .args(["task", "add", "Parent", "--type", "chore", "--json"])
        .assert()
        .success();
    let parent_json: serde_json::Value =
        serde_json::from_slice(&parent.get_output().stdout).expect("parent json");
    let parent_id = parent_json["task"]["id"].as_str().expect("parent id");
    ct_cmd(project.path(), state.path())
        .args(["task", "update", epic_id, "--parent-id", parent_id])
        .assert()
        .failure()
        .stderr(predicate::str::contains("epic tasks cannot have a parent"));
}

#[test]
fn task_legacy_orphan_epic_references_remain_listable() {
    let project = project_dir();
    let state = tempfile::tempdir().expect("state dir");

    ct_cmd(project.path(), state.path())
        .args(["task", "add", "Seed", "--type", "chore"])
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
        "INSERT INTO tasks (id, title, body, status, task_type, epic_id, labels, created_at, updated_at) VALUES (?1, ?2, '', 'open', 'feature', 'missing-epic', '[]', 1, 1)",
        ("ABCDEF", "legacy orphan"),
    )
    .expect("insert orphan");
    drop(conn);

    let list = ct_cmd(project.path(), state.path())
        .args(["task", "list", "--all", "--json"])
        .assert()
        .success();
    let list_json: serde_json::Value =
        serde_json::from_slice(&list.get_output().stdout).expect("list json");
    let orphan = list_json["tasks"]
        .as_array()
        .expect("tasks")
        .iter()
        .find(|task| task["title"] == "legacy orphan")
        .expect("legacy orphan");
    assert_eq!(orphan["epic_id"], "missing-epic");
}

#[test]
fn task_review_statuses_and_accept_reject_are_feature_bug_only() {
    let project = project_dir();
    let state = tempfile::tempdir().expect("state dir");

    ct_cmd(project.path(), state.path())
        .args([
            "task",
            "add",
            "Review epic",
            "--type",
            "epic",
            "--epic-id",
            "review",
        ])
        .assert()
        .success();

    ct_cmd(project.path(), state.path())
        .args([
            "task",
            "add",
            "Reviewable feature",
            "--type",
            "feature",
            "--epic-id",
            "review",
            "--status",
            "in_review",
            "--json",
        ])
        .assert()
        .success()
        .stdout(predicate::str::contains("\"status\": \"in_review\""));

    let bug = ct_cmd(project.path(), state.path())
        .args([
            "task",
            "add",
            "Reviewable bug",
            "--type",
            "bug",
            "--epic-id",
            "review",
            "--status",
            "in_review",
            "--json",
        ])
        .assert()
        .success();
    let bug_json: serde_json::Value =
        serde_json::from_slice(&bug.get_output().stdout).expect("bug json");
    let bug_id = bug_json["task"]["id"].as_str().expect("bug id");

    ct_cmd(project.path(), state.path())
        .args([
            "task",
            "add",
            "Chore cannot review",
            "--type",
            "chore",
            "--status",
            "in_review",
        ])
        .assert()
        .failure()
        .stderr(predicate::str::contains(
            "status in_review is only valid for feature or bug tasks",
        ));

    let reject = ct_cmd(project.path(), state.path())
        .args(["task", "reject", bug_id, "needs", "tests", "--json"])
        .assert()
        .success();
    let reject_json: serde_json::Value =
        serde_json::from_slice(&reject.get_output().stdout).expect("reject json");
    assert_eq!(reject_json["task"]["status"], "rejected");
    assert!(
        reject_json["task"]["body"]
            .as_str()
            .expect("body")
            .contains("## Rejection notes")
    );
    assert!(
        reject_json["task"]["body"]
            .as_str()
            .expect("body")
            .contains("needs tests")
    );

    ct_cmd(project.path(), state.path())
        .args(["task", "accept", bug_id])
        .assert()
        .failure()
        .stderr(predicate::str::contains("must be in_review"));

    ct_cmd(project.path(), state.path())
        .args(["task", "update", bug_id, "--status", "in_review"])
        .assert()
        .success();
    ct_cmd(project.path(), state.path())
        .args(["task", "accept", bug_id, "--json"])
        .assert()
        .success()
        .stdout(predicate::str::contains("\"status\": \"done\""));
}

#[test]
fn task_rejected_status_is_active() {
    let project = project_dir();
    let state = tempfile::tempdir().expect("state dir");

    ct_cmd(project.path(), state.path())
        .args([
            "task",
            "add",
            "Rejected bug",
            "--type",
            "bug",
            "--status",
            "rejected",
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
    assert_eq!(list_json["tasks"].as_array().expect("tasks").len(), 1);
    assert_eq!(list_json["tasks"][0]["title"], "Rejected bug");
}

#[test]
fn task_prefix_lookup_rejects_ambiguous_prefixes() {
    let project = project_dir();
    let state = tempfile::tempdir().expect("state dir");
    let db_dir = state.path().join("ct/projects/manual");
    fs::create_dir_all(&db_dir).expect("db dir");

    ct_cmd(project.path(), state.path())
        .args(["task", "add", "seed", "--type", "chore"])
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
        .args([
            "task",
            "add",
            "Implement API",
            "--type",
            "feature",
            "--json",
        ])
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
            "--type",
            "feature",
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
        .args(["task", "add", "First", "--type", "chore", "--json"])
        .assert()
        .success();
    let first_json: serde_json::Value =
        serde_json::from_slice(&first.get_output().stdout).expect("first json");
    let first_id = first_json["task"]["id"].as_str().expect("first id");

    let second = ct_cmd(project.path(), state.path())
        .args([
            "task",
            "add",
            "Second",
            "--type",
            "chore",
            "--blocked-by",
            first_id,
            "--json",
        ])
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

    ct_cmd(project.path(), state.path())
        .args([
            "task",
            "add",
            "Task Board Epic",
            "--type",
            "epic",
            "--epic-id",
            "task-board",
        ])
        .assert()
        .success();
    ct_cmd(project.path(), state.path())
        .args([
            "task",
            "add",
            "Task Board V2 Epic",
            "--type",
            "epic",
            "--epic-id",
            "task-board-v2",
        ])
        .assert()
        .success();

    let add = ct_cmd(project.path(), state.path())
        .args([
            "task",
            "add",
            "Build board",
            "--type",
            "chore",
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
fn task_parent_metadata_persists_clears_and_blocks_parent_delete() {
    let project = project_dir();
    let state = tempfile::tempdir().expect("state dir");

    let parent = ct_cmd(project.path(), state.path())
        .args(["task", "add", "Parent", "--type", "chore", "--json"])
        .assert()
        .success();
    let parent_json: serde_json::Value =
        serde_json::from_slice(&parent.get_output().stdout).expect("parent json");
    let parent_id = parent_json["task"]["id"].as_str().expect("parent id");

    let child = ct_cmd(project.path(), state.path())
        .args([
            "task",
            "add",
            "Child",
            "--type",
            "chore",
            "--parent-id",
            parent_id,
            "--json",
        ])
        .assert()
        .success();
    let child_json: serde_json::Value =
        serde_json::from_slice(&child.get_output().stdout).expect("child json");
    let child_id = child_json["task"]["id"].as_str().expect("child id");
    let parent_ref = child_json["task"]["parent_id"]
        .as_str()
        .expect("parent ref");
    assert!(parent_ref.starts_with(parent_id));

    ct_cmd(project.path(), state.path())
        .args(["task", "delete", parent_ref])
        .assert()
        .failure()
        .stderr(predicate::str::contains("parent of"));

    ct_cmd(project.path(), state.path())
        .args(["task", "update", parent_ref, "--parent-id", child_id])
        .assert()
        .failure()
        .stderr(predicate::str::contains(
            "dependencies cannot create a cycle",
        ));

    ct_cmd(project.path(), state.path())
        .args(["task", "update", child_id, "--blocked-by", parent_ref])
        .assert()
        .failure()
        .stderr(predicate::str::contains(
            "dependencies cannot create a cycle",
        ));

    ct_cmd(project.path(), state.path())
        .args(["task", "update", child_id, "--clear-parent", "--json"])
        .assert()
        .success()
        .stdout(predicate::str::contains("\"parent_id\": null"));
}

#[test]
fn task_blocked_status_is_rejected_and_existing_rows_migrate_to_open() {
    let project = project_dir();
    let state = tempfile::tempdir().expect("state dir");

    ct_cmd(project.path(), state.path())
        .args([
            "task",
            "add",
            "Invalid blocked",
            "--type",
            "chore",
            "--status",
            "blocked",
        ])
        .assert()
        .failure()
        .stderr(predicate::str::contains("invalid task status"));

    ct_cmd(project.path(), state.path())
        .args(["task", "add", "Seed", "--type", "chore"])
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
        "INSERT INTO tasks (id, title, body, status, created_at, updated_at) VALUES (?1, ?2, '', 'blocked', 1, 1)",
        ("ABCDEF", "old blocked"),
    )
    .expect("insert old blocked");
    drop(conn);

    let list = ct_cmd(project.path(), state.path())
        .args(["task", "list", "--all", "--json"])
        .assert()
        .success();
    let list_json: serde_json::Value =
        serde_json::from_slice(&list.get_output().stdout).expect("list json");
    let old = list_json["tasks"]
        .as_array()
        .expect("tasks")
        .iter()
        .find(|task| task["title"] == "old blocked")
        .expect("old blocked");
    assert_eq!(old["status"], "open");
}

#[test]
fn task_list_sorts_ready_tasks_before_blocked_then_by_priority() {
    let project = project_dir();
    let state = tempfile::tempdir().expect("state dir");

    let blocker = ct_cmd(project.path(), state.path())
        .args([
            "task",
            "add",
            "Ready blocker",
            "--type",
            "chore",
            "--priority",
            "0",
            "--json",
        ])
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
            "--type",
            "chore",
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
            "--type",
            "chore",
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
            "--type",
            "chore",
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
        .args(["task", "add", "Done blocker", "--type", "chore", "--json"])
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
            "--type",
            "chore",
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
            "--type",
            "chore",
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
        .args(["task", "add", "Other work", "--type", "chore", "--json"])
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
    let filtered_id = tasks[0]["id"].as_str().expect("filtered assigned id");

    ct_cmd(project.path(), state.path())
        .args(["task", "update", filtered_id, "--status", "done"])
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
