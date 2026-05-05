use std::collections::{HashMap, HashSet};

use anyhow::Result;
use ratatui::{
    Terminal,
    backend::TestBackend,
    layout::Rect,
    prelude::Widget,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph},
};
use serde::Serialize;

use crate::task::Task;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TaskTuiState {
    selected_task_id: Option<String>,
}

#[derive(Debug, Serialize)]
struct TaskTuiEnvelope {
    lines: Vec<String>,
    selected_task_id: Option<String>,
}

pub(crate) fn print_task_tui(
    tasks: &[Task],
    width: u16,
    height: u16,
    selected_task_id: Option<&str>,
    input: Option<&str>,
    json: bool,
) -> Result<()> {
    let mut state = TaskTuiState::with_selection(tasks, selected_task_id);
    if let Some(input) = input {
        state.handle_input(tasks, input);
    }
    let lines = render_task_tui_lines_with_state(tasks, width, height, &state);
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&TaskTuiEnvelope {
                lines,
                selected_task_id: state.selected_task_id,
            })?
        );
    } else {
        for line in lines {
            println!("{line}");
        }
    }
    Ok(())
}

impl TaskTuiState {
    pub(crate) fn new(tasks: &[Task]) -> Self {
        Self {
            selected_task_id: first_selectable_task(tasks).map(|task| task.id.clone()),
        }
    }

    fn with_selection(tasks: &[Task], selected_task_id: Option<&str>) -> Self {
        let ids: HashSet<&str> = tasks.iter().map(|task| task.id.as_str()).collect();
        if let Some(id) = selected_task_id.filter(|id| ids.contains(id)) {
            Self {
                selected_task_id: Some(id.to_string()),
            }
        } else {
            Self::new(tasks)
        }
    }

    fn handle_input(&mut self, tasks: &[Task], input: &str) {
        let order = selectable_task_ids(tasks);
        if order.is_empty() {
            self.selected_task_id = None;
            return;
        }
        let current = self
            .selected_task_id
            .as_deref()
            .and_then(|id| order.iter().position(|candidate| candidate == id))
            .unwrap_or(0);
        let next = match input {
            "j" | "down" | "\u{1b}[B" => current.saturating_add(1).min(order.len() - 1),
            "k" | "up" | "\u{1b}[A" => current.saturating_sub(1),
            "g" | "home" => 0,
            "G" | "end" => order.len() - 1,
            _ => current,
        };
        self.selected_task_id = Some(order[next].clone());
    }
}

pub(crate) fn render_task_tui_lines(tasks: &[Task], width: u16, height: u16) -> Vec<String> {
    let state = TaskTuiState::new(tasks);
    render_task_tui_lines_with_state(tasks, width, height, &state)
}

fn render_task_tui_lines_with_state(
    tasks: &[Task],
    width: u16,
    height: u16,
    state: &TaskTuiState,
) -> Vec<String> {
    let mut terminal = Terminal::new(TestBackend::new(width, height)).expect("test backend");
    terminal
        .draw(|frame| render_task_tui(frame.area(), frame.buffer_mut(), tasks, state))
        .expect("render task tui");
    terminal
        .backend()
        .buffer()
        .content
        .chunks(width as usize)
        .map(|row| row.iter().map(|cell| cell.symbol()).collect::<String>())
        .collect()
}

fn render_task_tui(
    area: Rect,
    buffer: &mut ratatui::buffer::Buffer,
    tasks: &[Task],
    state: &TaskTuiState,
) {
    let block = Block::new()
        .title(" Tasks ")
        .title_style(
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        )
        .borders(Borders::ALL);
    let inner = block.inner(area);
    block.render(area, buffer);

    let groups = task_groups(tasks);
    if groups.is_empty() {
        Paragraph::new("No tasks").render(inner, buffer);
        return;
    }

    let lines = render_groups(&groups, state);
    Paragraph::new(lines).render(inner, buffer);
}

fn render_groups(groups: &[TaskGroup], state: &TaskTuiState) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    for (index, group) in groups.iter().enumerate() {
        if index > 0 {
            lines.push(Line::from(""));
        }
        lines.push(Line::from(vec![
            Span::styled(
                "Epic: ",
                Style::default()
                    .fg(Color::Blue)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                group.title.clone(),
                Style::default().add_modifier(Modifier::BOLD),
            ),
            Span::raw(" "),
            Span::styled(
                group.label.clone(),
                Style::default()
                    .fg(Color::Green)
                    .add_modifier(Modifier::ITALIC),
            ),
            Span::raw(format!("  {}/{}", group.done, group.total)),
        ]));
        for lane in group.lanes.iter().filter(|lane| !lane.tasks.is_empty()) {
            lines.push(Line::from(Span::styled(
                format!("  {} ({})", lane.title, lane.tasks.len()),
                Style::default().fg(lane.color),
            )));
            for task in &lane.tasks {
                lines.push(task_line(
                    task,
                    state.selected_task_id.as_deref() == Some(task.id.as_str()),
                ));
            }
        }
    }
    lines
}

fn task_line(task: &Task, selected: bool) -> Line<'static> {
    let marker = if selected { "›" } else { " " };
    let labels = if task.labels.is_empty() {
        String::new()
    } else {
        format!(" [{}]", task.labels.join(","))
    };
    let assignee = task
        .assigned_label
        .as_ref()
        .or(task.assigned_to.as_ref())
        .map(|label| format!(" @{label}"))
        .unwrap_or_default();
    Line::from(vec![
        Span::raw(format!("  {marker} ")),
        Span::styled(type_icon(task), Style::default().fg(type_color(task))),
        Span::raw(format!(" {} {}{}{}", task.id, task.title, labels, assignee)),
    ])
}

#[derive(Debug)]
struct TaskGroup {
    title: String,
    label: String,
    priority: i64,
    updated_at: i64,
    done: usize,
    total: usize,
    lanes: Vec<TaskLane>,
}

#[derive(Debug)]
struct TaskLane {
    title: &'static str,
    color: Color,
    tasks: Vec<Task>,
}

fn task_groups(tasks: &[Task]) -> Vec<TaskGroup> {
    let epics: HashMap<&str, &Task> = tasks
        .iter()
        .filter(|task| task.task_type == "epic")
        .filter_map(|task| task.epic_id.as_deref().map(|label| (label, task)))
        .collect();
    let mut grouped: HashMap<Option<String>, Vec<Task>> = HashMap::new();
    for task in tasks
        .iter()
        .filter(|task| task.task_type != "epic" && task.status != "canceled")
    {
        grouped
            .entry(task.epic_id.clone())
            .or_default()
            .push(task.clone());
    }

    let blocked_ids = blocked_task_ids(tasks);
    let by_id: HashMap<&str, &Task> = tasks.iter().map(|task| (task.id.as_str(), task)).collect();
    let mut groups: Vec<TaskGroup> = grouped
        .into_iter()
        .map(|(label, group_tasks)| {
            let label_text = label.unwrap_or_default();
            let epic = epics.get(label_text.as_str()).copied();
            let title = if label_text.is_empty() {
                "No Epic".to_string()
            } else {
                epic.map(|task| task.title.clone())
                    .unwrap_or_else(|| format!("Unknown Epic: {label_text}"))
            };
            let total = group_tasks.len();
            let done = group_tasks.iter().filter(|task| is_done(task)).count();
            let priority = epic.map(|task| task.priority).unwrap_or_else(|| {
                group_tasks
                    .iter()
                    .map(|task| task.priority)
                    .max()
                    .unwrap_or_default()
            });
            let updated_at = epic.map(|task| task.updated_at).unwrap_or_else(|| {
                group_tasks
                    .iter()
                    .map(|task| task.updated_at)
                    .max()
                    .unwrap_or_default()
            });
            TaskGroup {
                title,
                label: label_text,
                priority,
                updated_at,
                done,
                total,
                lanes: lanes(group_tasks, &blocked_ids, &by_id),
            }
        })
        .collect();
    groups.sort_by(|left, right| {
        if left.label.is_empty() != right.label.is_empty() {
            return left.label.is_empty().cmp(&right.label.is_empty());
        }
        right
            .priority
            .cmp(&left.priority)
            .then_with(|| right.updated_at.cmp(&left.updated_at))
            .then_with(|| left.label.cmp(&right.label))
    });
    groups
}

fn lanes(
    tasks: Vec<Task>,
    blocked_ids: &HashSet<String>,
    by_id: &HashMap<&str, &Task>,
) -> Vec<TaskLane> {
    let mut rejected = Vec::new();
    let mut ready = Vec::new();
    let mut blocked = Vec::new();
    let mut in_progress = Vec::new();
    let mut in_review = Vec::new();
    let mut done = Vec::new();
    let mut sorted = tasks;
    sorted.sort_by(|left, right| {
        right
            .priority
            .cmp(&left.priority)
            .then_with(|| right.updated_at.cmp(&left.updated_at))
            .then_with(|| left.id.cmp(&right.id))
    });
    for task in sorted {
        if blocked_ids.contains(&task.id)
            || task
                .blocked_by
                .iter()
                .any(|id| by_id.get(id.as_str()).is_some_and(|task| !is_done(task)))
        {
            blocked.push(task);
        } else if task.status == "rejected" {
            rejected.push(task);
        } else if task.status == "in_progress" {
            in_progress.push(task);
        } else if task.status == "in_review" {
            in_review.push(task);
        } else if is_done(&task) {
            done.push(task);
        } else {
            ready.push(task);
        }
    }
    vec![
        TaskLane {
            title: "Rejected",
            color: Color::Red,
            tasks: rejected,
        },
        TaskLane {
            title: "Ready",
            color: Color::Blue,
            tasks: ready,
        },
        TaskLane {
            title: "Blocked",
            color: Color::DarkGray,
            tasks: blocked,
        },
        TaskLane {
            title: "In Progress",
            color: Color::Yellow,
            tasks: in_progress,
        },
        TaskLane {
            title: "In Review",
            color: Color::Magenta,
            tasks: in_review,
        },
        TaskLane {
            title: "Done",
            color: Color::Green,
            tasks: done,
        },
    ]
}

fn blocked_task_ids(tasks: &[Task]) -> HashSet<String> {
    tasks
        .iter()
        .filter(|task| task.parent_id.is_some())
        .filter(|task| !is_done(task) && task.status != "canceled")
        .filter_map(|task| task.parent_id.clone())
        .collect()
}

fn first_selectable_task(tasks: &[Task]) -> Option<&Task> {
    let first_id = selectable_task_ids(tasks).into_iter().next()?;
    tasks.iter().find(|task| task.id == first_id)
}

fn selectable_task_ids(tasks: &[Task]) -> Vec<String> {
    task_groups(tasks)
        .into_iter()
        .flat_map(|group| group.lanes.into_iter())
        .flat_map(|lane| lane.tasks.into_iter())
        .map(|task| task.id)
        .collect()
}

fn is_done(task: &Task) -> bool {
    task.status == "done" || task.status == "completed"
}

fn type_icon(task: &Task) -> &'static str {
    match task.task_type.as_str() {
        "feature" => "★",
        "bug" => "✖",
        "epic" => "⚑",
        _ => "⚙",
    }
}

fn type_color(task: &Task) -> Color {
    match task.task_type.as_str() {
        "feature" => Color::Yellow,
        "bug" => Color::Red,
        "epic" => Color::Cyan,
        _ => Color::DarkGray,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(id: &str, title: &str, status: &str, task_type: &str) -> Task {
        Task {
            id: id.to_string(),
            title: title.to_string(),
            body: String::new(),
            status: status.to_string(),
            task_type: task_type.to_string(),
            labels: Vec::new(),
            priority: 0,
            assigned_to: None,
            assigned_label: None,
            epic_id: None,
            epic_title: None,
            parent_id: None,
            blocked_by: Vec::new(),
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn task_tui_renders_empty_state() {
        let lines = render_task_tui_lines(&[], 40, 8).join("\n");
        assert!(lines.contains("Tasks"));
        assert!(lines.contains("No tasks"));
    }

    #[test]
    fn task_tui_renders_epics_as_outer_sections() {
        let mut epic = task("epic", "Ratatui Overlay", "open", "epic");
        epic.epic_id = Some("ratatui-overlay".to_string());
        epic.priority = 10;
        let mut feature = task("feat", "Render board", "open", "feature");
        feature.epic_id = Some("ratatui-overlay".to_string());
        feature.labels = vec!["ui".to_string(), "test".to_string()];
        let mut bug = task("bug", "Fix selection", "rejected", "bug");
        bug.epic_id = Some("ratatui-overlay".to_string());
        bug.priority = 5;

        let lines = render_task_tui_lines(&[epic, feature, bug], 80, 16).join("\n");
        assert!(lines.contains("Epic: Ratatui Overlay"));
        assert!(lines.contains("ratatui-overlay"));
        assert!(lines.contains("Rejected (1)"));
        assert!(lines.contains("Ready (1)"));
        assert!(lines.contains("★ feat Render board [ui,test]"));
        assert!(lines.contains("✖ bug Fix selection"));
        assert_eq!(lines.matches("Ratatui Overlay").count(), 1);
    }

    #[test]
    fn task_tui_renders_representative_statuses_and_widths() {
        let ready = task("ready", "Ready", "open", "feature");
        let mut in_review = task("review", "Review", "in_review", "feature");
        in_review.assigned_label = Some("Me".to_string());
        let in_progress = task("work", "Working", "in_progress", "chore");
        let done = task("done", "Done", "done", "bug");
        let mut blocked = task("block", "Blocked", "open", "feature");
        blocked.blocked_by = vec!["work".to_string()];

        let lines = render_task_tui_lines(&[ready, in_review, in_progress, done, blocked], 52, 18)
            .join("\n");
        assert!(lines.contains("No Epic"));
        assert!(lines.contains("Ready (1)"));
        assert!(lines.contains("Blocked (1)"));
        assert!(lines.contains("In Progress (1)"));
        assert!(lines.contains("In Review (1)"));
        assert!(lines.contains("Done (1)"));
        assert!(lines.contains("@Me"));
    }

    #[test]
    fn task_tui_state_selects_from_model_not_rendered_rows() {
        let mut low = task("low", "Low", "open", "feature");
        low.priority = 1;
        let mut high = task("high", "High", "rejected", "bug");
        high.priority = 100;

        let state = TaskTuiState::new(&[low, high]);
        assert_eq!(state.selected_task_id.as_deref(), Some("high"));
    }
}
