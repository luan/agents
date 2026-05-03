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
            blocked_by,
            json,
        } => {
            let task = store.display_task(store.add(
                &title,
                body.as_deref().unwrap_or(""),
                &status,
                &blocked_by,
            )?)?;
            print_task(&task, json)?;
        }
        TaskAction::List { status, all, json } => {
            let tasks = store.display_tasks(store.list(status.as_deref(), all)?)?;
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
            blocked_by,
            clear_blockers,
            json,
        } => {
            let task = store.display_task(store.update(
                &id,
                title.as_deref(),
                body.as_deref(),
                status.as_deref(),
                &blocked_by,
                clear_blockers,
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
                blocked_by TEXT NOT NULL DEFAULT '[]',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_tasks_status_updated ON tasks(status, updated_at DESC);",
        )?;
        ensure_blocked_by_column(&conn)?;
        Ok(Self { conn })
    }

    fn add(&self, title: &str, body: &str, status: &str, blocked_by: &[String]) -> Result<Task> {
        validate_title(title)?;
        validate_status(status)?;
        let now = now_ms();
        let id = self.new_id()?;
        let blockers = self.resolve_blockers(blocked_by, Some(&id))?;
        let blockers_json = serde_json::to_string(&blockers)?;
        self.conn.execute(
            "INSERT INTO tasks (id, title, body, status, blocked_by, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![id, title.trim(), body, status, blockers_json, now],
        )?;
        self.get_exact(&id)
    }

    fn list(&self, status: Option<&str>, all: bool) -> Result<Vec<Task>> {
        if let Some(status) = status {
            validate_status(status)?;
            return self.query_tasks(
                "SELECT id, title, body, status, blocked_by, created_at, updated_at FROM tasks WHERE status = ?1 ORDER BY updated_at DESC",
                &[status],
            );
        }
        if all {
            return self.query_tasks(
                "SELECT id, title, body, status, blocked_by, created_at, updated_at FROM tasks ORDER BY updated_at DESC",
                &[],
            );
        }
        let mut stmt = self.conn.prepare(
            "SELECT id, title, body, status, blocked_by, created_at, updated_at FROM tasks WHERE status IN ('open', 'in_progress', 'blocked', 'todo') ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map([], row_task)?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    fn show(&self, id_prefix: &str) -> Result<Task> {
        let id = self.resolve_id(id_prefix)?;
        self.get_exact(&id)
    }

    fn update(
        &self,
        id_prefix: &str,
        title: Option<&str>,
        body: Option<&str>,
        status: Option<&str>,
        blocked_by: &[String],
        clear_blockers: bool,
    ) -> Result<Task> {
        if title.is_none()
            && body.is_none()
            && status.is_none()
            && blocked_by.is_empty()
            && !clear_blockers
        {
            bail!("nothing to update");
        }
        if let Some(title) = title {
            validate_title(title)?;
        }
        if let Some(status) = status {
            validate_status(status)?;
        }
        let id = self.resolve_id(id_prefix)?;
        let existing = self.get_exact(&id)?;
        let blockers = if clear_blockers {
            Vec::new()
        } else if blocked_by.is_empty() {
            existing.blocked_by.clone()
        } else {
            self.resolve_blockers(blocked_by, Some(&id))?
        };
        let blockers_json = serde_json::to_string(&blockers)?;
        self.conn.execute(
            "UPDATE tasks SET title = ?1, body = ?2, status = ?3, blocked_by = ?4, updated_at = ?5 WHERE id = ?6",
            params![
                title.unwrap_or(&existing.title).trim(),
                body.unwrap_or(&existing.body),
                status.unwrap_or(&existing.status),
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
                "SELECT id, title, body, status, blocked_by, created_at, updated_at FROM tasks WHERE id = ?1",
                [id],
                row_task,
            )
            .optional()?
            .with_context(|| format!("no task matches id {id:?}"))
    }

    fn query_tasks(&self, sql: &str, params: &[&str]) -> Result<Vec<Task>> {
        let mut stmt = self.conn.prepare(sql)?;
        let rows = stmt.query_map(params_from_iter(params.iter()), row_task)?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
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
    let blocked_by_json: String = row.get(4)?;
    let blocked_by = serde_json::from_str(&blocked_by_json).unwrap_or_default();
    Ok(Task {
        id: row.get(0)?,
        title: row.get(1)?,
        body: row.get(2)?,
        status: row.get(3)?,
        blocked_by,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
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
}
