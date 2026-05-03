use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow, bail};
use getrandom::fill as fill_random;
use rusqlite::{Connection, OptionalExtension, params, params_from_iter};
use serde::Serialize;

use crate::cli::TaskAction;

const CROCKFORD: &[u8; 32] = b"0123456789abcdefghjkmnpqrstvwxyz";
const ID_LENGTH: usize = 6;
const VALID_STATUSES: [&str; 6] = ["open", "in_progress", "blocked", "todo", "done", "canceled"];

#[derive(Debug, Serialize)]
struct Task {
    id: String,
    title: String,
    body: String,
    status: String,
    priority: i64,
    assigned_to: Option<String>,
    assigned_label: Option<String>,
    epic_id: Option<String>,
    epic_title: Option<String>,
    blocked_by: Vec<String>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Serialize)]
struct TaskEnvelope<'a> {
    task: &'a Task,
}

#[derive(Serialize)]
struct TaskListEnvelope<'a> {
    tasks: &'a [Task],
}

#[derive(Serialize)]
struct DeleteEnvelope<'a> {
    deleted: &'a str,
}

pub fn run_task(action: TaskAction) -> Result<(), Box<dyn std::error::Error>> {
    let store = TaskStore::open(std::env::current_dir()?)?;
    match action {
        TaskAction::Add {
            title,
            body,
            status,
            priority,
            assigned_to,
            assigned_label,
            epic_id,
            epic_title,
            blocked_by,
            json,
        } => {
            let task = store.display_task(store.add(TaskNew {
                title: &title,
                body: body.as_deref().unwrap_or(""),
                status: &status,
                priority,
                assigned_to: assigned_to.as_deref(),
                assigned_label: assigned_label.as_deref(),
                epic_id: epic_id.as_deref(),
                epic_title: epic_title.as_deref(),
                blocked_by: &blocked_by,
            })?)?;
            print_task(&task, json)?;
        }
        TaskAction::List {
            status,
            assigned_to,
            all,
            json,
        } => {
            let tasks = store.display_tasks(store.list(
                status.as_deref(),
                assigned_to.as_deref(),
                all,
            )?)?;
            print_tasks(&tasks, json)?;
        }
        TaskAction::Show { id, json } => {
            let task = store.display_task(store.show(&id)?)?;
            print_task(&task, json)?;
        }
        TaskAction::Update {
            id,
            title,
            body,
            status,
            priority,
            assigned_to,
            assigned_label,
            clear_assignee,
            epic_id,
            epic_title,
            clear_epic,
            blocked_by,
            clear_blockers,
            json,
        } => {
            let task = store.display_task(store.update(
                &id,
                TaskUpdate {
                    title: title.as_deref(),
                    body: body.as_deref(),
                    status: status.as_deref(),
                    priority,
                    assigned_to: assigned_to.as_deref(),
                    assigned_label: assigned_label.as_deref(),
                    clear_assignee,
                    epic_id: epic_id.as_deref(),
                    epic_title: epic_title.as_deref(),
                    clear_epic,
                    blocked_by: &blocked_by,
                    clear_blockers,
                },
            )?)?;
            print_task(&task, json)?;
        }
        TaskAction::Delete { id, json } => {
            let deleted = store.delete(&id)?;
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&DeleteEnvelope { deleted: &deleted })?
                );
            } else {
                println!("Deleted {deleted}");
            }
        }
    }
    Ok(())
}

struct TaskStore {
    conn: Connection,
}

struct TaskNew<'a> {
    title: &'a str,
    body: &'a str,
    status: &'a str,
    priority: i64,
    assigned_to: Option<&'a str>,
    assigned_label: Option<&'a str>,
    epic_id: Option<&'a str>,
    epic_title: Option<&'a str>,
    blocked_by: &'a [String],
}

struct TaskUpdate<'a> {
    title: Option<&'a str>,
    body: Option<&'a str>,
    status: Option<&'a str>,
    priority: Option<i64>,
    assigned_to: Option<&'a str>,
    assigned_label: Option<&'a str>,
    clear_assignee: bool,
    epic_id: Option<&'a str>,
    epic_title: Option<&'a str>,
    clear_epic: bool,
    blocked_by: &'a [String],
    clear_blockers: bool,
}

impl TaskStore {
    fn open(cwd: PathBuf) -> Result<Self> {
        let root = project_root(&cwd);
        let dir = crate::lens::paths::project_state_dir(&root)
            .map_err(|error| anyhow!("{error}"))?
            .join("tasks");
        fs::create_dir_all(&dir)?;
        let conn = Connection::open(dir.join("tasks.sqlite"))?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                body TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL,
                priority INTEGER NOT NULL DEFAULT 0,
                assigned_to TEXT,
                assigned_label TEXT,
                epic_id TEXT,
                epic_title TEXT,
                blocked_by TEXT NOT NULL DEFAULT '[]',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_tasks_status_updated ON tasks(status, updated_at DESC);",
        )?;
        ensure_blocked_by_column(&conn)?;
        ensure_priority_column(&conn)?;
        ensure_assigned_to_column(&conn)?;
        ensure_assigned_label_column(&conn)?;
        ensure_epic_id_column(&conn)?;
        ensure_epic_title_column(&conn)?;
        Ok(Self { conn })
    }

    fn add(&self, new_task: TaskNew<'_>) -> Result<Task> {
        validate_title(new_task.title)?;
        validate_status(new_task.status)?;
        let assigned_to = normalize_assignment(new_task.assigned_to)?;
        let assigned_label = normalize_assignment(new_task.assigned_label)?;
        let epic_id = normalize_epic(new_task.epic_id)?;
        let epic_title = normalize_epic(new_task.epic_title)?;
        let now = now_ms();
        let id = self.new_id()?;
        let blockers = self.resolve_blockers(new_task.blocked_by, Some(&id))?;
        let blockers_json = serde_json::to_string(&blockers)?;
        self.conn.execute(
            "INSERT INTO tasks (id, title, body, status, priority, assigned_to, assigned_label, epic_id, epic_title, blocked_by, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)",
            params![
                id,
                new_task.title.trim(),
                new_task.body,
                new_task.status,
                new_task.priority,
                assigned_to,
                assigned_label,
                epic_id,
                epic_title,
                blockers_json,
                now
            ],
        )?;
        self.get_exact(&id)
    }

    fn list(
        &self,
        status: Option<&str>,
        assigned_to: Option<&str>,
        all: bool,
    ) -> Result<Vec<Task>> {
        if let Some(status) = status {
            validate_status(status)?;
        }
        let assigned_to = normalize_assignment(assigned_to)?;
        match (status, assigned_to.as_deref(), all) {
            (Some(status), Some(assigned_to), _) => self.query_tasks(
                "SELECT id, title, body, status, priority, assigned_to, assigned_label, epic_id, epic_title, blocked_by, created_at, updated_at FROM tasks WHERE status = ?1 AND assigned_to = ?2 ORDER BY updated_at DESC",
                &[status, assigned_to],
            ),
            (Some(status), None, _) => self.query_tasks(
                "SELECT id, title, body, status, priority, assigned_to, assigned_label, epic_id, epic_title, blocked_by, created_at, updated_at FROM tasks WHERE status = ?1 ORDER BY updated_at DESC",
                &[status],
            ),
            (None, Some(assigned_to), _) => self.query_tasks(
                "SELECT id, title, body, status, priority, assigned_to, assigned_label, epic_id, epic_title, blocked_by, created_at, updated_at FROM tasks WHERE assigned_to = ?1 ORDER BY updated_at DESC",
                &[assigned_to],
            ),
            (None, None, true) => self.query_tasks(
                "SELECT id, title, body, status, priority, assigned_to, assigned_label, epic_id, epic_title, blocked_by, created_at, updated_at FROM tasks ORDER BY updated_at DESC",
                &[],
            ),
            (None, None, false) => {
                let mut stmt = self.conn.prepare(
                    "SELECT id, title, body, status, priority, assigned_to, assigned_label, epic_id, epic_title, blocked_by, created_at, updated_at FROM tasks WHERE status IN ('open', 'in_progress', 'blocked', 'todo') ORDER BY updated_at DESC",
                )?;
                let rows = stmt.query_map([], row_task)?;
                sort_tasks(rows.collect::<std::result::Result<Vec<_>, _>>()?)
            }
        }
    }

    fn show(&self, id_prefix: &str) -> Result<Task> {
        let id = self.resolve_id(id_prefix)?;
        self.get_exact(&id)
    }

    fn update(&self, id_prefix: &str, update: TaskUpdate<'_>) -> Result<Task> {
        if update.title.is_none()
            && update.body.is_none()
            && update.status.is_none()
            && update.priority.is_none()
            && update.assigned_to.is_none()
            && update.assigned_label.is_none()
            && !update.clear_assignee
            && update.epic_id.is_none()
            && update.epic_title.is_none()
            && !update.clear_epic
            && update.blocked_by.is_empty()
            && !update.clear_blockers
        {
            bail!("nothing to update");
        }
        if let Some(title) = update.title {
            validate_title(title)?;
        }
        if let Some(status) = update.status {
            validate_status(status)?;
        }
        let assigned_to = normalize_assignment(update.assigned_to)?;
        let assigned_label = normalize_assignment(update.assigned_label)?;
        let epic_id = normalize_epic(update.epic_id)?;
        let epic_title = normalize_epic(update.epic_title)?;
        let id = self.resolve_id(id_prefix)?;
        let existing = self.get_exact(&id)?;
        let blockers = if update.clear_blockers {
            Vec::new()
        } else if update.blocked_by.is_empty() {
            existing.blocked_by.clone()
        } else {
            self.resolve_blockers(update.blocked_by, Some(&id))?
        };
        let blockers_json = serde_json::to_string(&blockers)?;
        self.conn.execute(
            "UPDATE tasks SET title = ?1, body = ?2, status = ?3, priority = ?4, assigned_to = ?5, assigned_label = ?6, epic_id = ?7, epic_title = ?8, blocked_by = ?9, updated_at = ?10 WHERE id = ?11",
            params![
                update.title.unwrap_or(&existing.title).trim(),
                update.body.unwrap_or(&existing.body),
                update.status.unwrap_or(&existing.status),
                update.priority.unwrap_or(existing.priority),
                if update.clear_assignee { None } else { assigned_to.or(existing.assigned_to) },
                if update.clear_assignee { None } else { assigned_label.or(existing.assigned_label) },
                if update.clear_epic { None } else { epic_id.or(existing.epic_id) },
                if update.clear_epic { None } else { epic_title.or(existing.epic_title) },
                blockers_json,
                now_ms(),
                id
            ],
        )?;
        self.get_exact(&id)
    }

    fn delete(&self, id_prefix: &str) -> Result<String> {
        let id = self.resolve_id(id_prefix)?;
        let display_id = min_prefix(&id, &self.all_ids()?);
        self.conn
            .execute("DELETE FROM tasks WHERE id = ?1", [&id])?;
        Ok(display_id)
    }

    fn resolve_id(&self, prefix: &str) -> Result<String> {
        let normalized = normalize_id(prefix)?;
        let mut stmt = self
            .conn
            .prepare("SELECT id FROM tasks WHERE id LIKE ?1 ORDER BY id")?;
        let matches = stmt
            .query_map([format!("{normalized}%")], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        match matches.as_slice() {
            [] => bail!("no task matches id prefix {prefix:?}"),
            [id] => Ok(id.clone()),
            _ => bail!(
                "ambiguous task id prefix {prefix:?} — did you mean:\n{}",
                self.ambiguous_matches(&matches)?
            ),
        }
    }

    fn get_exact(&self, id: &str) -> Result<Task> {
        self.conn
            .query_row(
                "SELECT id, title, body, status, priority, assigned_to, assigned_label, epic_id, epic_title, blocked_by, created_at, updated_at FROM tasks WHERE id = ?1",
                [id],
                row_task,
            )
            .optional()?
            .with_context(|| format!("no task matches id {id:?}"))
    }

    fn query_tasks(&self, sql: &str, params: &[&str]) -> Result<Vec<Task>> {
        let mut stmt = self.conn.prepare(sql)?;
        let rows = stmt.query_map(params_from_iter(params.iter()), row_task)?;
        sort_tasks(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    fn new_id(&self) -> Result<String> {
        for attempt in 0..32 {
            let id = generate_id(attempt);
            let exists: Option<String> = self
                .conn
                .query_row("SELECT id FROM tasks WHERE id = ?1", [&id], |row| {
                    row.get(0)
                })
                .optional()?;
            if exists.is_none() {
                return Ok(id);
            }
        }
        bail!("could not allocate unique task id")
    }

    fn all_ids(&self) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare("SELECT id FROM tasks ORDER BY id")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    fn display_task(&self, mut task: Task) -> Result<Task> {
        let all_ids = self.all_ids()?;
        task.blocked_by = task
            .blocked_by
            .iter()
            .map(|id| min_prefix(id, &all_ids))
            .collect();
        task.id = min_prefix(&task.id, &all_ids);
        Ok(task)
    }

    fn display_tasks(&self, tasks: Vec<Task>) -> Result<Vec<Task>> {
        let all_ids = self.all_ids()?;
        Ok(tasks
            .into_iter()
            .map(|mut task| {
                task.blocked_by = task
                    .blocked_by
                    .iter()
                    .map(|id| min_prefix(id, &all_ids))
                    .collect();
                task.id = min_prefix(&task.id, &all_ids);
                task
            })
            .collect())
    }

    fn resolve_blockers(&self, blockers: &[String], self_id: Option<&str>) -> Result<Vec<String>> {
        let mut resolved = Vec::with_capacity(blockers.len());
        for blocker in blockers {
            let id = self.resolve_id(blocker)?;
            if Some(id.as_str()) == self_id {
                bail!("task cannot block itself");
            }
            if !resolved.contains(&id) {
                resolved.push(id);
            }
        }
        Ok(resolved)
    }

    fn ambiguous_matches(&self, ids: &[String]) -> Result<String> {
        let mut lines = Vec::with_capacity(ids.len());
        for id in ids {
            let short = min_prefix(id, ids);
            match self.get_exact(id) {
                Ok(task) => lines.push(format!("  {short}  {}  {}", task.status, task.title)),
                Err(_) => lines.push(format!("  {short}")),
            }
        }
        Ok(lines.join("\n"))
    }
}

fn row_task(row: &rusqlite::Row<'_>) -> rusqlite::Result<Task> {
    let blocked_by_json: String = row.get(9)?;
    let blocked_by = serde_json::from_str(&blocked_by_json).unwrap_or_default();
    Ok(Task {
        id: row.get(0)?,
        title: row.get(1)?,
        body: row.get(2)?,
        status: row.get(3)?,
        priority: row.get(4)?,
        assigned_to: row.get(5)?,
        assigned_label: row.get(6)?,
        epic_id: row.get(7)?,
        epic_title: row.get(8)?,
        blocked_by,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

fn sort_tasks(mut tasks: Vec<Task>) -> Result<Vec<Task>> {
    let statuses = tasks
        .iter()
        .map(|task| (task.id.clone(), task.status.clone()))
        .collect::<std::collections::HashMap<_, _>>();
    tasks.sort_by(|left, right| {
        has_open_blockers(left, &statuses)
            .cmp(&has_open_blockers(right, &statuses))
            .then_with(|| right.priority.cmp(&left.priority))
            .then_with(|| right.updated_at.cmp(&left.updated_at))
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(tasks)
}

fn has_open_blockers(task: &Task, statuses: &std::collections::HashMap<String, String>) -> bool {
    task.blocked_by.iter().any(|id| {
        statuses
            .get(id)
            .is_none_or(|status| status != "done" && status != "completed")
    })
}

fn ensure_blocked_by_column(conn: &Connection) -> Result<()> {
    let has_column = conn
        .prepare("PRAGMA table_info(tasks)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<std::result::Result<Vec<_>, _>>()?
        .iter()
        .any(|column| column == "blocked_by");
    if !has_column {
        conn.execute(
            "ALTER TABLE tasks ADD COLUMN blocked_by TEXT NOT NULL DEFAULT '[]'",
            [],
        )?;
    }
    Ok(())
}

fn ensure_priority_column(conn: &Connection) -> Result<()> {
    let has_column = conn
        .prepare("PRAGMA table_info(tasks)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<std::result::Result<Vec<_>, _>>()?
        .iter()
        .any(|column| column == "priority");
    if !has_column {
        conn.execute(
            "ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }
    Ok(())
}

fn ensure_assigned_to_column(conn: &Connection) -> Result<()> {
    let has_column = conn
        .prepare("PRAGMA table_info(tasks)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<std::result::Result<Vec<_>, _>>()?
        .iter()
        .any(|column| column == "assigned_to");
    if !has_column {
        conn.execute("ALTER TABLE tasks ADD COLUMN assigned_to TEXT", [])?;
    }
    Ok(())
}

fn ensure_assigned_label_column(conn: &Connection) -> Result<()> {
    let has_column = conn
        .prepare("PRAGMA table_info(tasks)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<std::result::Result<Vec<_>, _>>()?
        .iter()
        .any(|column| column == "assigned_label");
    if !has_column {
        conn.execute("ALTER TABLE tasks ADD COLUMN assigned_label TEXT", [])?;
    }
    Ok(())
}

fn ensure_epic_id_column(conn: &Connection) -> Result<()> {
    let has_column = conn
        .prepare("PRAGMA table_info(tasks)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<std::result::Result<Vec<_>, _>>()?
        .iter()
        .any(|column| column == "epic_id");
    if !has_column {
        conn.execute("ALTER TABLE tasks ADD COLUMN epic_id TEXT", [])?;
    }
    Ok(())
}

fn ensure_epic_title_column(conn: &Connection) -> Result<()> {
    let has_column = conn
        .prepare("PRAGMA table_info(tasks)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<std::result::Result<Vec<_>, _>>()?
        .iter()
        .any(|column| column == "epic_title");
    if !has_column {
        conn.execute("ALTER TABLE tasks ADD COLUMN epic_title TEXT", [])?;
    }
    Ok(())
}

fn validate_title(title: &str) -> Result<()> {
    if title.trim().is_empty() {
        bail!("task title must not be empty");
    }
    Ok(())
}

fn validate_status(status: &str) -> Result<()> {
    if VALID_STATUSES.contains(&status) {
        return Ok(());
    }
    bail!(
        "invalid task status {status:?}; expected one of {}",
        VALID_STATUSES.join(", ")
    )
}

fn normalize_assignment(value: Option<&str>) -> Result<Option<String>> {
    let Some(value) = value else {
        return Ok(None);
    };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        bail!("assignment must not be empty");
    }
    Ok(Some(trimmed.to_string()))
}

fn normalize_epic(value: Option<&str>) -> Result<Option<String>> {
    let Some(value) = value else {
        return Ok(None);
    };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        bail!("epic metadata must not be empty");
    }
    Ok(Some(trimmed.to_string()))
}

fn normalize_id(id: &str) -> Result<String> {
    let normalized = id.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        bail!("task id prefix must not be empty");
    }
    if !normalized
        .chars()
        .all(|c| "0123456789abcdefghjkmnpqrstvwxyz".contains(c))
    {
        bail!("task id prefix must use Crockford Base32 characters");
    }
    Ok(normalized)
}

fn min_prefix(id: &str, all_ids: &[String]) -> String {
    let normalized = id.to_ascii_lowercase();
    let normalized_ids = all_ids
        .iter()
        .map(|id| id.to_ascii_lowercase())
        .collect::<Vec<_>>();
    for length in 1..normalized.len() {
        let prefix = &normalized[..length];
        if normalized_ids
            .iter()
            .all(|other| other == &normalized || !other.starts_with(prefix))
        {
            return prefix.to_string();
        }
    }
    normalized
}

fn generate_id(_attempt: u32) -> String {
    let mut bytes = [0_u8; ID_LENGTH];
    if fill_random(&mut bytes).is_err() {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let fallback = now.to_le_bytes();
        bytes.copy_from_slice(&fallback[..ID_LENGTH]);
    }
    let mut out = String::with_capacity(ID_LENGTH);
    for byte in bytes {
        out.push(CROCKFORD[usize::from(byte) % CROCKFORD.len()] as char);
    }
    out
}

fn project_root(cwd: &Path) -> PathBuf {
    let output = Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(cwd)
        .output();
    if let Ok(output) = output
        && output.status.success()
    {
        let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !text.is_empty() {
            return PathBuf::from(text);
        }
    }
    cwd.to_path_buf()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}

fn print_task(task: &Task, json: bool) -> Result<()> {
    if json {
        println!("{}", serde_json::to_string_pretty(&TaskEnvelope { task })?);
    } else {
        println!("{} [{}] {}", task.id, task.status, task.title);
        if !task.body.is_empty() {
            println!("{}", task.body);
        }
    }
    Ok(())
}

fn print_tasks(tasks: &[Task], json: bool) -> Result<()> {
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&TaskListEnvelope { tasks })?
        );
        return Ok(());
    }
    if tasks.is_empty() {
        println!("No tasks");
        return Ok(());
    }
    for task in tasks {
        println!("{} [{}] {}", task.id, task.status, task.title);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_ids_are_crockford_base32() {
        let id = generate_id(0);
        assert_eq!(id.len(), 6);
        assert!(
            id.chars()
                .all(|c| "0123456789abcdefghjkmnpqrstvwxyz".contains(c))
        );
    }

    #[test]
    fn min_prefix_uses_shortest_unique_prefix() {
        let ids = vec![
            "abc123".to_string(),
            "abd456".to_string(),
            "xyz789".to_string(),
        ];
        assert_eq!(min_prefix("abc123", &ids), "abc");
        assert_eq!(min_prefix("xyz789", &ids), "x");
    }

    #[test]
    fn invalid_prefix_characters_fail() {
        let error = normalize_id("oil").unwrap_err().to_string();
        assert!(error.contains("Crockford"));
    }

    #[test]
    fn epic_columns_are_added_to_existing_task_tables() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE tasks (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                body TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL,
                priority INTEGER NOT NULL DEFAULT 0,
                assigned_to TEXT,
                assigned_label TEXT,
                blocked_by TEXT NOT NULL DEFAULT '[]',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );",
        )
        .unwrap();

        ensure_epic_id_column(&conn).unwrap();
        ensure_epic_title_column(&conn).unwrap();
        conn.execute(
            "INSERT INTO tasks (id, title, body, status, blocked_by, created_at, updated_at)
             VALUES ('abc123', 'Old task', '', 'open', '[]', 1, 1)",
            [],
        )
        .unwrap();

        let task = conn
            .query_row(
                "SELECT id, title, body, status, priority, assigned_to, assigned_label, epic_id, epic_title, blocked_by, created_at, updated_at FROM tasks WHERE id = 'abc123'",
                [],
                row_task,
            )
            .unwrap();
        assert_eq!(task.title, "Old task");
        assert!(task.epic_id.is_none());
        assert!(task.epic_title.is_none());
    }
}
