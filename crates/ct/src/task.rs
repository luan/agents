use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow, bail};
use getrandom::fill as fill_random;
use rusqlite::{Connection, OptionalExtension, params, params_from_iter};
use serde::Serialize;

use crate::cli::TaskAction;

const CROCKFORD: &[u8; 32] = b"0123456789abcdefghjkmnpqrstvwxyz";
const ID_LENGTH: usize = 6;
const VALID_STATUSES: [&str; 7] = [
    "open",
    "in_progress",
    "todo",
    "in_review",
    "rejected",
    "done",
    "canceled",
];
const VALID_TASK_TYPES: [&str; 4] = ["epic", "feature", "bug", "chore"];
const TASK_SELECT_COLUMNS: &str = "id, title, body, status, priority, assigned_to, assigned_label, epic_id, epic_title, parent_id, blocked_by, task_type, labels, created_at, updated_at";

#[derive(Debug, Serialize)]
struct Task {
    id: String,
    title: String,
    body: String,
    status: String,
    #[serde(rename = "type")]
    task_type: String,
    labels: Vec<String>,
    priority: i64,
    assigned_to: Option<String>,
    assigned_label: Option<String>,
    epic_id: Option<String>,
    epic_title: Option<String>,
    parent_id: Option<String>,
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
            task_type,
            body,
            status,
            priority,
            assigned_to,
            assigned_label,
            epic_id,
            epic_title,
            labels,
            parent_id,
            blocked_by,
            json,
        } => {
            let task = store.display_task(store.add(TaskNew {
                title: &title,
                task_type: task_type.as_deref(),
                body: body.as_deref().unwrap_or(""),
                status: &status,
                priority,
                assigned_to: assigned_to.as_deref(),
                assigned_label: assigned_label.as_deref(),
                epic_id: epic_id.as_deref(),
                epic_title: epic_title.as_deref(),
                labels: &labels,
                parent_id: parent_id.as_deref(),
                blocked_by: &blocked_by,
            })?)?;
            print_task(&task, json)?;
        }
        TaskAction::List {
            status,
            task_type,
            label,
            epic_id,
            assigned_to,
            all,
            json,
        } => {
            let tasks = store.display_tasks(store.list(
                status.as_deref(),
                task_type.as_deref(),
                label.as_deref(),
                epic_id.as_deref(),
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
            task_type,
            title,
            body,
            status,
            priority,
            assigned_to,
            assigned_label,
            clear_assignee,
            epic_id,
            epic_title,
            labels,
            clear_epic,
            parent_id,
            clear_parent,
            blocked_by,
            clear_blockers,
            json,
        } => {
            let task = store.display_task(store.update(
                &id,
                TaskUpdate {
                    title: title.as_deref(),
                    task_type: task_type.as_deref(),
                    body: body.as_deref(),
                    status: status.as_deref(),
                    priority,
                    assigned_to: assigned_to.as_deref(),
                    assigned_label: assigned_label.as_deref(),
                    clear_assignee,
                    epic_id: epic_id.as_deref(),
                    epic_title: epic_title.as_deref(),
                    labels: &labels,
                    clear_epic,
                    parent_id: parent_id.as_deref(),
                    clear_parent,
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
        TaskAction::Accept { id, json } => {
            let task = store.display_task(store.accept(&id)?)?;
            print_task(&task, json)?;
        }
        TaskAction::Reject { id, note, json } => {
            let task = store.display_task(store.reject(&id, &note.join(" "))?)?;
            print_task(&task, json)?;
        }
    }
    Ok(())
}

struct TaskStore {
    conn: Connection,
}

struct TaskNew<'a> {
    title: &'a str,
    task_type: Option<&'a str>,
    body: &'a str,
    status: &'a str,
    priority: i64,
    assigned_to: Option<&'a str>,
    assigned_label: Option<&'a str>,
    epic_id: Option<&'a str>,
    epic_title: Option<&'a str>,
    labels: &'a [String],
    parent_id: Option<&'a str>,
    blocked_by: &'a [String],
}

struct TaskUpdate<'a> {
    title: Option<&'a str>,
    task_type: Option<&'a str>,
    body: Option<&'a str>,
    status: Option<&'a str>,
    priority: Option<i64>,
    assigned_to: Option<&'a str>,
    assigned_label: Option<&'a str>,
    clear_assignee: bool,
    epic_id: Option<&'a str>,
    epic_title: Option<&'a str>,
    labels: &'a [String],
    clear_epic: bool,
    parent_id: Option<&'a str>,
    clear_parent: bool,
    blocked_by: &'a [String],
    clear_blockers: bool,
}

impl TaskStore {
    fn open(cwd: PathBuf) -> Result<Self> {
        let dir = crate::lens::paths::project_state_dir(&cwd)
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
                parent_id TEXT,
                blocked_by TEXT NOT NULL DEFAULT '[]',
                task_type TEXT NOT NULL DEFAULT 'chore',
                labels TEXT NOT NULL DEFAULT '[]',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_tasks_status_updated ON tasks(status, updated_at DESC);",
        )?;
        ensure_task_columns(&conn)?;
        Ok(Self { conn })
    }

    fn add(&self, new_task: TaskNew<'_>) -> Result<Task> {
        self.with_immediate_tx(|| self.add_inner(new_task))
    }

    fn add_inner(&self, new_task: TaskNew<'_>) -> Result<Task> {
        validate_title(new_task.title)?;
        let task_type = normalize_required_task_type(new_task.task_type)?;
        validate_status_for_type(new_task.status, &task_type)?;
        let labels = normalize_labels(new_task.labels)?;
        let assigned_to = normalize_assignment(new_task.assigned_to)?;
        let assigned_label = normalize_assignment(new_task.assigned_label)?;
        let epic_id = normalize_epic(new_task.epic_id)?;
        let epic_title = normalize_epic(new_task.epic_title)?;
        let parent_id = self.resolve_optional_parent(new_task.parent_id, None)?;
        let now = now_ms();
        let id = self.new_id()?;
        self.validate_epic_contract(
            &id,
            &task_type,
            epic_id.as_deref(),
            parent_id.as_deref(),
            true,
        )?;
        let blockers = self.resolve_blockers(new_task.blocked_by, Some(&id))?;
        self.ensure_no_dependency_cycle(&id, &blockers, parent_id.as_deref())?;
        let blockers_json = serde_json::to_string(&blockers)?;
        let labels_json = serde_json::to_string(&labels)?;
        self.conn.execute(
            "INSERT INTO tasks (id, title, body, status, priority, assigned_to, assigned_label, epic_id, epic_title, parent_id, blocked_by, task_type, labels, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14)",
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
                parent_id,
                blockers_json,
                task_type,
                labels_json,
                now
            ],
        )?;
        self.get_exact(&id)
    }

    fn list(
        &self,
        status: Option<&str>,
        task_type: Option<&str>,
        label: Option<&str>,
        epic_id: Option<&str>,
        assigned_to: Option<&str>,
        all: bool,
    ) -> Result<Vec<Task>> {
        if let Some(status) = status {
            validate_status(status)?;
        }
        let task_type = normalize_optional_task_type(task_type)?;
        let label = normalize_label_filter(label)?;
        let epic_id = normalize_epic(epic_id)?;
        let assigned_to = normalize_assignment(assigned_to)?;
        let tasks = match (status, assigned_to.as_deref(), all) {
            (Some(status), Some(assigned_to), _) => self.query_tasks(
                &format!(
                    "SELECT {TASK_SELECT_COLUMNS} FROM tasks WHERE status = ?1 AND assigned_to = ?2 ORDER BY updated_at DESC"
                ),
                &[status, assigned_to],
            ),
            (Some(status), None, _) => self.query_tasks(
                &format!("SELECT {TASK_SELECT_COLUMNS} FROM tasks WHERE status = ?1 ORDER BY updated_at DESC"),
                &[status],
            ),
            (None, Some(assigned_to), false) => {
                let tasks = self.query_tasks(
                    &format!("SELECT {TASK_SELECT_COLUMNS} FROM tasks WHERE assigned_to = ?1 ORDER BY updated_at DESC"),
                    &[assigned_to],
                )?;
                Ok(tasks.into_iter().filter(is_active_task).collect())
            }
            (None, Some(assigned_to), true) => self.query_tasks(
                &format!("SELECT {TASK_SELECT_COLUMNS} FROM tasks WHERE assigned_to = ?1 ORDER BY updated_at DESC"),
                &[assigned_to],
            ),
            (None, None, true) => self.query_tasks(
                &format!("SELECT {TASK_SELECT_COLUMNS} FROM tasks ORDER BY updated_at DESC"),
                &[],
            ),
            (None, None, false) => {
                let sql = format!("SELECT {TASK_SELECT_COLUMNS} FROM tasks ORDER BY updated_at DESC");
                let mut stmt = self.conn.prepare(&sql)?;
                let rows = stmt.query_map([], row_task)?;
                Ok(sort_tasks(rows.collect::<std::result::Result<Vec<_>, _>>()?)?
                    .into_iter()
                    .filter(is_active_task)
                    .collect())
            }
        }?;
        Ok(tasks
            .into_iter()
            .filter(|task| {
                task_type
                    .as_deref()
                    .is_none_or(|value| task.task_type == value)
            })
            .filter(|task| {
                label
                    .as_deref()
                    .is_none_or(|value| task.labels.iter().any(|candidate| candidate == value))
            })
            .filter(|task| {
                epic_id
                    .as_deref()
                    .is_none_or(|value| task.epic_id.as_deref() == Some(value))
            })
            .collect())
    }

    fn show(&self, id_prefix: &str) -> Result<Task> {
        let id = self.resolve_id(id_prefix)?;
        self.get_exact(&id)
    }

    fn update(&self, id_prefix: &str, update: TaskUpdate<'_>) -> Result<Task> {
        self.with_immediate_tx(|| self.update_inner(id_prefix, update))
    }

    fn update_inner(&self, id_prefix: &str, update: TaskUpdate<'_>) -> Result<Task> {
        if update.title.is_none()
            && update.task_type.is_none()
            && update.body.is_none()
            && update.status.is_none()
            && update.priority.is_none()
            && update.assigned_to.is_none()
            && update.assigned_label.is_none()
            && !update.clear_assignee
            && update.epic_id.is_none()
            && update.epic_title.is_none()
            && update.labels.is_empty()
            && !update.clear_epic
            && update.parent_id.is_none()
            && !update.clear_parent
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
        let task_type = normalize_optional_task_type(update.task_type)?;
        let labels = if update.labels.is_empty() {
            None
        } else {
            Some(normalize_labels(update.labels)?)
        };
        let assigned_to = normalize_assignment(update.assigned_to)?;
        let assigned_label = normalize_assignment(update.assigned_label)?;
        let epic_id = normalize_epic(update.epic_id)?;
        let epic_title = normalize_epic(update.epic_title)?;
        let id = self.resolve_id(id_prefix)?;
        let existing = self.get_exact(&id)?;
        let final_task_type = task_type.unwrap_or(existing.task_type);
        let final_status = update.status.unwrap_or(&existing.status);
        validate_status_for_type(final_status, &final_task_type)?;
        let parent_id = self.resolve_optional_parent(update.parent_id, Some(&id))?;
        let blockers = if update.clear_blockers {
            Vec::new()
        } else if update.blocked_by.is_empty() {
            existing.blocked_by.clone()
        } else {
            self.resolve_blockers(update.blocked_by, Some(&id))?
        };
        let final_parent_id = if update.clear_parent {
            None
        } else {
            parent_id.or(existing.parent_id.clone())
        };
        let final_epic_id = if update.clear_epic {
            None
        } else {
            epic_id.or(existing.epic_id.clone())
        };
        self.validate_epic_contract(
            &id,
            &final_task_type,
            final_epic_id.as_deref(),
            final_parent_id.as_deref(),
            update.epic_id.is_some() || update.task_type.is_some() || update.clear_epic,
        )?;
        self.ensure_no_dependency_cycle(&id, &blockers, final_parent_id.as_deref())?;
        let blockers_json = serde_json::to_string(&blockers)?;
        let final_labels = labels.unwrap_or_else(|| existing.labels.clone());
        let labels_json = serde_json::to_string(&final_labels)?;
        self.conn.execute(
            "UPDATE tasks SET title = ?1, body = ?2, status = ?3, priority = ?4, assigned_to = ?5, assigned_label = ?6, epic_id = ?7, epic_title = ?8, parent_id = ?9, blocked_by = ?10, task_type = ?11, labels = ?12, updated_at = ?13 WHERE id = ?14",
            params![
                update.title.unwrap_or(&existing.title).trim(),
                update.body.unwrap_or(&existing.body),
                final_status,
                update.priority.unwrap_or(existing.priority),
                if update.clear_assignee { None } else { assigned_to.or(existing.assigned_to) },
                if update.clear_assignee { None } else { assigned_label.or(existing.assigned_label) },
                final_epic_id,
                if update.clear_epic { None } else { epic_title.or(existing.epic_title) },
                final_parent_id,
                blockers_json,
                final_task_type,
                labels_json,
                now_ms(),
                id
            ],
        )?;
        self.get_exact(&id)
    }

    fn accept(&self, id_prefix: &str) -> Result<Task> {
        self.with_immediate_tx(|| {
            let id = self.resolve_id(id_prefix)?;
            let task = self.get_exact(&id)?;
            ensure_review_task_in_review(&task)?;
            self.conn.execute(
                "UPDATE tasks SET status = 'done', updated_at = ?1 WHERE id = ?2",
                params![now_ms(), id],
            )?;
            self.get_exact(&id)
        })
    }

    fn reject(&self, id_prefix: &str, note: &str) -> Result<Task> {
        let note = note.trim();
        if note.is_empty() {
            bail!("rejection note must not be empty");
        }
        self.with_immediate_tx(|| {
            let id = self.resolve_id(id_prefix)?;
            let task = self.get_exact(&id)?;
            ensure_review_task_in_review(&task)?;
            let now = now_ms();
            let body = append_rejection_note(&task.body, note, now);
            self.conn.execute(
                "UPDATE tasks SET status = 'rejected', body = ?1, updated_at = ?2 WHERE id = ?3",
                params![body, now, id],
            )?;
            self.get_exact(&id)
        })
    }

    fn delete(&self, id_prefix: &str) -> Result<String> {
        self.with_immediate_tx(|| self.delete_inner(id_prefix))
    }

    fn delete_inner(&self, id_prefix: &str) -> Result<String> {
        let id = self.resolve_id(id_prefix)?;
        let all_ids = self.all_ids()?;
        let display_id = min_prefix(&id, &all_ids);
        let referenced_by = self.tasks_blocked_by(&id)?;
        if !referenced_by.is_empty() {
            let prefixes = shortest_prefixes(&all_ids);
            bail!(
                "cannot delete task {display_id}; blocked by {}",
                referenced_by
                    .iter()
                    .map(|task_id| display_prefix(task_id, &prefixes))
                    .collect::<Vec<_>>()
                    .join(", ")
            );
        }
        let children = self.tasks_with_parent(&id)?;
        if !children.is_empty() {
            let prefixes = shortest_prefixes(&all_ids);
            bail!(
                "cannot delete task {display_id}; parent of {}",
                children
                    .iter()
                    .map(|task_id| display_prefix(task_id, &prefixes))
                    .collect::<Vec<_>>()
                    .join(", ")
            );
        }
        self.conn
            .execute("DELETE FROM tasks WHERE id = ?1", [&id])?;
        Ok(display_id)
    }

    fn with_immediate_tx<T>(&self, work: impl FnOnce() -> Result<T>) -> Result<T> {
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        match work() {
            Ok(value) => {
                self.conn.execute_batch("COMMIT")?;
                Ok(value)
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
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
                &format!("SELECT {TASK_SELECT_COLUMNS} FROM tasks WHERE id = ?1"),
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
        let prefixes = shortest_prefixes(&all_ids);
        task.blocked_by = task
            .blocked_by
            .iter()
            .map(|id| display_prefix(id, &prefixes))
            .collect();
        task.parent_id = task
            .parent_id
            .as_deref()
            .map(|id| display_prefix(id, &prefixes));
        task.id = display_prefix(&task.id, &prefixes);
        Ok(task)
    }

    fn display_tasks(&self, tasks: Vec<Task>) -> Result<Vec<Task>> {
        let all_ids = self.all_ids()?;
        let prefixes = shortest_prefixes(&all_ids);
        Ok(tasks
            .into_iter()
            .map(|mut task| {
                task.blocked_by = task
                    .blocked_by
                    .iter()
                    .map(|id| display_prefix(id, &prefixes))
                    .collect();
                task.parent_id = task
                    .parent_id
                    .as_deref()
                    .map(|id| display_prefix(id, &prefixes));
                task.id = display_prefix(&task.id, &prefixes);
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

    fn tasks_blocked_by(&self, blocker_id: &str) -> Result<Vec<String>> {
        let tasks = self.query_tasks(
            &format!("SELECT {TASK_SELECT_COLUMNS} FROM tasks ORDER BY id"),
            &[],
        )?;
        Ok(tasks
            .into_iter()
            .filter(|task| task.blocked_by.iter().any(|id| id == blocker_id))
            .map(|task| task.id)
            .collect())
    }

    fn tasks_with_parent(&self, parent_id: &str) -> Result<Vec<String>> {
        let tasks = self.query_tasks(
            &format!("SELECT {TASK_SELECT_COLUMNS} FROM tasks WHERE parent_id = ?1 ORDER BY id"),
            &[parent_id],
        )?;
        Ok(tasks.into_iter().map(|task| task.id).collect())
    }

    fn validate_epic_contract(
        &self,
        task_id: &str,
        task_type: &str,
        epic_id: Option<&str>,
        parent_id: Option<&str>,
        enforce_child_reference: bool,
    ) -> Result<()> {
        match task_type {
            "epic" => {
                if parent_id.is_some() {
                    bail!("epic tasks cannot have a parent");
                }
                let Some(label) = epic_id else {
                    bail!("epic tasks require --epic-id");
                };
                validate_epic_label(label)?;
                let duplicate: Option<String> = self
                    .conn
                    .query_row(
                        "SELECT id FROM tasks WHERE task_type = 'epic' AND epic_id = ?1 AND id != ?2 LIMIT 1",
                        params![label, task_id],
                        |row| row.get(0),
                    )
                    .optional()?;
                if duplicate.is_some() {
                    bail!("epic task with label {label:?} already exists");
                }
            }
            _ => {
                if let Some(label) = epic_id {
                    validate_epic_label(label)?;
                    if enforce_child_reference && !self.epic_label_exists(label, task_id)? {
                        bail!("no epic task has label {label:?}");
                    }
                }
            }
        }
        Ok(())
    }

    fn epic_label_exists(&self, label: &str, self_id: &str) -> Result<bool> {
        let found: Option<String> = self
            .conn
            .query_row(
                "SELECT id FROM tasks WHERE task_type = 'epic' AND epic_id = ?1 AND id != ?2 LIMIT 1",
                params![label, self_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(found.is_some())
    }

    fn resolve_optional_parent(
        &self,
        parent: Option<&str>,
        self_id: Option<&str>,
    ) -> Result<Option<String>> {
        let Some(parent) = parent else {
            return Ok(None);
        };
        let parent_id = self.resolve_id(parent)?;
        if Some(parent_id.as_str()) == self_id {
            bail!("task cannot be its own parent");
        }
        Ok(Some(parent_id))
    }

    fn dependency_graph(
        &self,
        self_id: &str,
        blockers: &[String],
        parent_id: Option<&str>,
    ) -> Result<HashMap<String, Vec<String>>> {
        let tasks = self.query_tasks(
            &format!("SELECT {TASK_SELECT_COLUMNS} FROM tasks ORDER BY id"),
            &[],
        )?;
        let mut graph: HashMap<String, Vec<String>> = HashMap::new();
        let mut has_self = false;
        for task in tasks {
            has_self |= task.id == self_id;
            let task_blockers = if task.id == self_id {
                blockers.to_vec()
            } else {
                task.blocked_by.clone()
            };
            graph
                .entry(task.id.clone())
                .or_default()
                .extend(task_blockers);
            let task_parent = if task.id == self_id {
                parent_id.map(str::to_string)
            } else {
                task.parent_id.clone()
            };
            if let Some(parent_id) = task_parent {
                graph.entry(parent_id).or_default().push(task.id);
            }
        }
        if !has_self {
            graph
                .entry(self_id.to_string())
                .or_default()
                .extend(blockers.iter().cloned());
            if let Some(parent_id) = parent_id {
                graph
                    .entry(parent_id.to_string())
                    .or_default()
                    .push(self_id.to_string());
            }
        }
        Ok(graph)
    }

    fn ensure_no_dependency_cycle(
        &self,
        self_id: &str,
        blockers: &[String],
        parent_id: Option<&str>,
    ) -> Result<()> {
        let graph = self.dependency_graph(self_id, blockers, parent_id)?;
        let mut stack = graph.get(self_id).cloned().unwrap_or_default();
        let mut seen = HashSet::new();
        while let Some(id) = stack.pop() {
            if id == self_id {
                bail!("task dependencies cannot create a cycle");
            }
            if !seen.insert(id.clone()) {
                continue;
            }
            if let Some(next) = graph.get(&id) {
                stack.extend(next.iter().cloned());
            }
        }
        Ok(())
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
    let blocked_by_json: String = row.get(10)?;
    let blocked_by = serde_json::from_str(&blocked_by_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(10, rusqlite::types::Type::Text, Box::new(error))
    })?;
    let task_type: String = row.get(11)?;
    let labels_json: String = row.get(12)?;
    let labels = serde_json::from_str(&labels_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(12, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(Task {
        id: row.get(0)?,
        title: row.get(1)?,
        body: row.get(2)?,
        status: row.get(3)?,
        task_type,
        labels,
        priority: row.get(4)?,
        assigned_to: row.get(5)?,
        assigned_label: row.get(6)?,
        epic_id: row.get(7)?,
        epic_title: row.get(8)?,
        parent_id: row.get(9)?,
        blocked_by,
        created_at: row.get(13)?,
        updated_at: row.get(14)?,
    })
}

fn is_active_task(task: &Task) -> bool {
    is_active_status(&task.status)
}

fn sort_tasks(mut tasks: Vec<Task>) -> Result<Vec<Task>> {
    let statuses = tasks
        .iter()
        .map(|task| (task.id.clone(), task.status.clone()))
        .collect::<std::collections::HashMap<_, _>>();
    let mut children_by_parent = HashMap::<String, Vec<String>>::new();
    for task in &tasks {
        if let Some(parent_id) = &task.parent_id {
            children_by_parent
                .entry(parent_id.clone())
                .or_default()
                .push(task.id.clone());
        }
    }
    tasks.sort_by(|left, right| {
        has_open_dependencies(left, &statuses, &children_by_parent)
            .cmp(&has_open_dependencies(
                right,
                &statuses,
                &children_by_parent,
            ))
            .then_with(|| right.priority.cmp(&left.priority))
            .then_with(|| right.updated_at.cmp(&left.updated_at))
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(tasks)
}

fn has_open_dependencies(
    task: &Task,
    statuses: &std::collections::HashMap<String, String>,
    children_by_parent: &HashMap<String, Vec<String>>,
) -> bool {
    has_open_blockers(task, statuses)
        || children_by_parent.get(&task.id).is_some_and(|children| {
            children.iter().any(|id| {
                statuses
                    .get(id)
                    .is_some_and(|status| is_active_status(status))
            })
        })
}

fn has_open_blockers(task: &Task, statuses: &std::collections::HashMap<String, String>) -> bool {
    task.blocked_by.iter().any(|id| {
        statuses
            .get(id)
            .is_none_or(|status| status != "done" && status != "completed")
    })
}

fn is_active_status(status: &str) -> bool {
    matches!(
        status,
        "open" | "in_progress" | "todo" | "in_review" | "rejected"
    )
}

fn ensure_task_columns(conn: &Connection) -> Result<()> {
    let existing = conn
        .prepare("PRAGMA table_info(tasks)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<std::result::Result<HashSet<_>, _>>()?;
    for (column, sql) in [
        (
            "blocked_by",
            "ALTER TABLE tasks ADD COLUMN blocked_by TEXT NOT NULL DEFAULT '[]'",
        ),
        (
            "priority",
            "ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 0",
        ),
        (
            "assigned_to",
            "ALTER TABLE tasks ADD COLUMN assigned_to TEXT",
        ),
        (
            "assigned_label",
            "ALTER TABLE tasks ADD COLUMN assigned_label TEXT",
        ),
        ("epic_id", "ALTER TABLE tasks ADD COLUMN epic_id TEXT"),
        ("epic_title", "ALTER TABLE tasks ADD COLUMN epic_title TEXT"),
        ("parent_id", "ALTER TABLE tasks ADD COLUMN parent_id TEXT"),
        (
            "task_type",
            "ALTER TABLE tasks ADD COLUMN task_type TEXT NOT NULL DEFAULT 'chore'",
        ),
        (
            "labels",
            "ALTER TABLE tasks ADD COLUMN labels TEXT NOT NULL DEFAULT '[]'",
        ),
    ] {
        if !existing.contains(column) {
            conn.execute(sql, [])?;
        }
    }
    conn.execute(
        "UPDATE tasks SET status = 'open' WHERE status = 'blocked'",
        [],
    )?;
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

fn validate_status_for_type(status: &str, task_type: &str) -> Result<()> {
    validate_status(status)?;
    if matches!(status, "in_review" | "rejected") && !matches!(task_type, "feature" | "bug") {
        bail!("status {status} is only valid for feature or bug tasks");
    }
    Ok(())
}

fn ensure_review_task_in_review(task: &Task) -> Result<()> {
    if !matches!(task.task_type.as_str(), "feature" | "bug") {
        bail!("task must be a feature or bug");
    }
    if task.status != "in_review" {
        bail!("task must be in_review");
    }
    Ok(())
}

fn append_rejection_note(body: &str, note: &str, timestamp_ms: i64) -> String {
    let trimmed_body = body.trim_end();
    let entry = format!("- {timestamp_ms}: {}", note.trim());
    if trimmed_body.contains("\n## Rejection notes\n") || trimmed_body == "## Rejection notes" {
        format!("{trimmed_body}\n{entry}")
    } else if trimmed_body.is_empty() {
        format!("## Rejection notes\n\n{entry}")
    } else {
        format!("{trimmed_body}\n\n## Rejection notes\n\n{entry}")
    }
}

fn validate_task_type(task_type: &str) -> Result<()> {
    if VALID_TASK_TYPES.contains(&task_type) {
        return Ok(());
    }
    bail!(
        "invalid task type {task_type:?}; expected one of {}",
        VALID_TASK_TYPES.join(", ")
    )
}

fn normalize_required_task_type(value: Option<&str>) -> Result<String> {
    let Some(value) = value else {
        bail!("task type is required; pass --type epic, feature, bug, or chore");
    };
    let normalized = value.trim();
    validate_task_type(normalized)?;
    Ok(normalized.to_string())
}

fn normalize_optional_task_type(value: Option<&str>) -> Result<Option<String>> {
    let Some(value) = value else {
        return Ok(None);
    };
    let normalized = value.trim();
    validate_task_type(normalized)?;
    Ok(Some(normalized.to_string()))
}

fn validate_label(value: &str) -> Result<()> {
    let valid = !value.is_empty()
        && !value.starts_with('-')
        && !value.ends_with('-')
        && value
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !value.contains("--");
    if valid {
        return Ok(());
    }
    bail!("invalid task label {value:?}; expected a kebab-case token")
}

fn normalize_labels(labels: &[String]) -> Result<Vec<String>> {
    let mut normalized = Vec::new();
    for label in labels {
        let label = label.trim();
        validate_label(label)?;
        if !normalized.iter().any(|existing| existing == label) {
            normalized.push(label.to_string());
        }
    }
    Ok(normalized)
}

fn validate_epic_label(value: &str) -> Result<()> {
    validate_label(value).with_context(|| "invalid epic label")?;
    let length = value.chars().count();
    if !(2..=32).contains(&length) {
        bail!("invalid epic label {value:?}; expected 2 to 32 characters");
    }
    Ok(())
}

fn normalize_label_filter(label: Option<&str>) -> Result<Option<String>> {
    let Some(label) = label else {
        return Ok(None);
    };
    let label = label.trim();
    validate_label(label)?;
    Ok(Some(label.to_string()))
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
        .all(|c| c.is_ascii() && CROCKFORD.contains(&(c as u8)))
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

fn shortest_prefixes(ids: &[String]) -> HashMap<String, String> {
    ids.iter()
        .map(|id| (id.clone(), min_prefix(id, ids)))
        .collect()
}

fn display_prefix(id: &str, prefixes: &HashMap<String, String>) -> String {
    prefixes
        .get(id)
        .cloned()
        .unwrap_or_else(|| id.to_ascii_lowercase())
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
    fn metadata_columns_are_added_to_existing_task_tables_and_blocked_migrates() {
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

        ensure_task_columns(&conn).unwrap();
        conn.execute(
            "INSERT INTO tasks (id, title, body, status, blocked_by, created_at, updated_at)
             VALUES ('abc123', 'Old task', '', 'open', '[]', 1, 1)",
            [],
        )
        .unwrap();

        let task = conn
            .query_row(
                &format!("SELECT {TASK_SELECT_COLUMNS} FROM tasks WHERE id = 'abc123'"),
                [],
                row_task,
            )
            .unwrap();
        assert_eq!(task.title, "Old task");
        assert_eq!(task.task_type, "chore");
        assert!(task.labels.is_empty());
        assert!(task.epic_id.is_none());
        assert!(task.epic_title.is_none());
        assert!(task.parent_id.is_none());

        conn.execute(
            "INSERT INTO tasks (id, title, body, status, blocked_by, created_at, updated_at)
             VALUES ('def456', 'Blocked task', '', 'blocked', '[]', 1, 1)",
            [],
        )
        .unwrap();
        ensure_task_columns(&conn).unwrap();
        let status: String = conn
            .query_row("SELECT status FROM tasks WHERE id = 'def456'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(status, "open");
    }
}
