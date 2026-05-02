use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow, bail};
use rusqlite::{Connection, OptionalExtension, params, params_from_iter};
use serde::Serialize;
use sha1::{Digest, Sha1};

use crate::cli::TaskAction;

const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const VALID_STATUSES: [&str; 6] = ["open", "in_progress", "blocked", "todo", "done", "canceled"];

#[derive(Debug, Serialize)]
struct Task {
    id: String,
    title: String,
    body: String,
    status: String,
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
            json,
        } => {
            let task = store.add(&title, body.as_deref().unwrap_or(""), &status)?;
            print_task(&task, json)?;
        }
        TaskAction::List { status, all, json } => {
            let tasks = store.list(status.as_deref(), all)?;
            print_tasks(&tasks, json)?;
        }
        TaskAction::Show { id, json } => {
            let task = store.show(&id)?;
            print_task(&task, json)?;
        }
        TaskAction::Update {
            id,
            title,
            body,
            status,
            json,
        } => {
            let task = store.update(&id, title.as_deref(), body.as_deref(), status.as_deref())?;
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
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_tasks_status_updated ON tasks(status, updated_at DESC);",
        )?;
        Ok(Self { conn })
    }

    fn add(&self, title: &str, body: &str, status: &str) -> Result<Task> {
        validate_title(title)?;
        validate_status(status)?;
        let now = now_ms();
        let id = self.new_id()?;
        self.conn.execute(
            "INSERT INTO tasks (id, title, body, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![id, title.trim(), body, status, now],
        )?;
        self.get_exact(&id)
    }

    fn list(&self, status: Option<&str>, all: bool) -> Result<Vec<Task>> {
        if let Some(status) = status {
            validate_status(status)?;
            return self.query_tasks(
                "SELECT id, title, body, status, created_at, updated_at FROM tasks WHERE status = ?1 ORDER BY updated_at DESC",
                &[status],
            );
        }
        if all {
            return self.query_tasks(
                "SELECT id, title, body, status, created_at, updated_at FROM tasks ORDER BY updated_at DESC",
                &[],
            );
        }
        let mut stmt = self.conn.prepare(
            "SELECT id, title, body, status, created_at, updated_at FROM tasks WHERE status IN ('open', 'in_progress', 'blocked', 'todo') ORDER BY updated_at DESC",
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
    ) -> Result<Task> {
        if title.is_none() && body.is_none() && status.is_none() {
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
        self.conn.execute(
            "UPDATE tasks SET title = ?1, body = ?2, status = ?3, updated_at = ?4 WHERE id = ?5",
            params![
                title.unwrap_or(&existing.title).trim(),
                body.unwrap_or(&existing.body),
                status.unwrap_or(&existing.status),
                now_ms(),
                id
            ],
        )?;
        self.get_exact(&id)
    }

    fn delete(&self, id_prefix: &str) -> Result<String> {
        let id = self.resolve_id(id_prefix)?;
        self.conn
            .execute("DELETE FROM tasks WHERE id = ?1", [&id])?;
        Ok(id)
    }

    fn resolve_id(&self, prefix: &str) -> Result<String> {
        let normalized = normalize_id(prefix)?;
        let mut stmt = self
            .conn
            .prepare("SELECT id FROM tasks WHERE id LIKE ?1 ORDER BY id LIMIT 2")?;
        let matches = stmt
            .query_map([format!("{normalized}%")], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        match matches.as_slice() {
            [] => bail!("no task matches id prefix {prefix:?}"),
            [id] => Ok(id.clone()),
            _ => bail!("ambiguous task id prefix {prefix:?}"),
        }
    }

    fn get_exact(&self, id: &str) -> Result<Task> {
        self.conn
            .query_row(
                "SELECT id, title, body, status, created_at, updated_at FROM tasks WHERE id = ?1",
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
}

fn row_task(row: &rusqlite::Row<'_>) -> rusqlite::Result<Task> {
    Ok(Task {
        id: row.get(0)?,
        title: row.get(1)?,
        body: row.get(2)?,
        status: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
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
    let normalized = id.trim().to_ascii_uppercase();
    if normalized.is_empty() {
        bail!("task id prefix must not be empty");
    }
    if !normalized
        .chars()
        .all(|c| "0123456789ABCDEFGHJKMNPQRSTVWXYZ".contains(c))
    {
        bail!("task id prefix must use Crockford Base32 characters");
    }
    Ok(normalized)
}

fn generate_id(attempt: u32) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let seed = format!(
        "{now}:{}:{attempt}:{:?}",
        std::process::id(),
        std::thread::current().id()
    );
    let digest = Sha1::digest(seed.as_bytes());
    let mut out = String::with_capacity(10);
    out.push(CROCKFORD[10 + usize::from(digest[0] % 22)] as char);
    for byte in digest.iter().skip(1).take(9) {
        out.push(CROCKFORD[usize::from(byte & 31)] as char);
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
        assert_eq!(id.len(), 10);
        assert!(
            id.chars()
                .all(|c| "0123456789ABCDEFGHJKMNPQRSTVWXYZ".contains(c))
        );
        assert!(id.chars().any(|c| c.is_ascii_alphabetic()));
    }

    #[test]
    fn invalid_prefix_characters_fail() {
        let error = normalize_id("oil").unwrap_err().to_string();
        assert!(error.contains("Crockford"));
    }
}
