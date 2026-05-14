use std::{
    collections::HashSet,
    io::{self, BufRead, Write},
};

use anyhow::Result;
use crossterm::{
    event::{self, Event, KeyCode, KeyEvent, KeyModifiers},
    execute,
    terminal::{EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode},
};
use ratatui::{
    Terminal,
    backend::{CrosstermBackend, TestBackend},
    buffer::Cell,
    layout::Rect,
    prelude::Widget,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph},
};
use serde::{Deserialize, Serialize};

use crate::task::Task;
use crate::task_board::{TicketBoardLaneId, project_ticket_board};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TaskTuiState {
    selected_task_id: Option<String>,
}

#[derive(Debug, Serialize)]
struct TaskTuiEnvelope {
    tasks: Vec<Task>,
    lines: Vec<String>,
    selected_task_id: Option<String>,
    board: crate::task_board::TicketBoardProjection,
}

#[derive(Debug, Deserialize)]
struct TaskTuiEmbedRequest {
    request_id: u64,
    width: u16,
    height: u16,
    input: Option<String>,
    tasks: Option<Vec<Task>>,
}

#[derive(Debug, Serialize)]
struct TaskTuiEmbedResponse {
    request_id: u64,
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
    if !json && input.is_none() {
        return run_interactive_task_tui(tasks, state);
    }
    let lines = render_task_tui_lines_with_state(tasks, width, height, &state);
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&TaskTuiEnvelope {
                tasks: tasks.to_vec(),
                lines,
                selected_task_id: state.selected_task_id,
                board: project_ticket_board(tasks),
            })?
        );
    } else {
        for line in lines {
            println!("{line}");
        }
    }
    Ok(())
}

pub(crate) fn run_task_tui_embed(initial_tasks: &[Task]) -> Result<()> {
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    let mut tasks = initial_tasks.to_vec();
    let mut state = TaskTuiState::new(&tasks);
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let request: TaskTuiEmbedRequest = serde_json::from_str(&line)?;
        if let Some(next_tasks) = request.tasks {
            tasks = next_tasks;
            state = TaskTuiState::with_selection(&tasks, state.selected_task_id.as_deref());
        }
        if let Some(input) = request.input.as_deref() {
            state.handle_input(&tasks, input);
        }
        let response = TaskTuiEmbedResponse {
            request_id: request.request_id,
            lines: render_task_tui_lines_with_state(&tasks, request.width, request.height, &state),
            selected_task_id: state.selected_task_id.clone(),
        };
        serde_json::to_writer(&mut stdout, &response)?;
        stdout.write_all(b"\n")?;
        stdout.flush()?;
    }
    Ok(())
}

fn run_interactive_task_tui(tasks: &[Task], mut state: TaskTuiState) -> Result<()> {
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen)?;
    let mut terminal = Terminal::new(CrosstermBackend::new(stdout))?;
    let result = run_interactive_loop(&mut terminal, tasks, &mut state);
    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    terminal.show_cursor()?;
    result
}

fn run_interactive_loop(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    tasks: &[Task],
    state: &mut TaskTuiState,
) -> Result<()> {
    loop {
        terminal.draw(|frame| render_task_tui(frame.area(), frame.buffer_mut(), tasks, state))?;
        if let Event::Key(key) = event::read()?
            && handle_interactive_key(state, tasks, key)
        {
            break;
        }
    }
    Ok(())
}

fn handle_interactive_key(state: &mut TaskTuiState, tasks: &[Task], key: KeyEvent) -> bool {
    match key.code {
        KeyCode::Esc | KeyCode::Char('q') => true,
        KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => true,
        KeyCode::Down | KeyCode::Right => {
            state.handle_input(tasks, "j");
            false
        }
        KeyCode::Up | KeyCode::Left => {
            state.handle_input(tasks, "k");
            false
        }
        KeyCode::Home => {
            state.handle_input(tasks, "g");
            false
        }
        KeyCode::End => {
            state.handle_input(tasks, "G");
            false
        }
        KeyCode::Char(ch) => {
            let input = ch.to_string();
            state.handle_input(tasks, &input);
            false
        }
        _ => false,
    }
}

impl TaskTuiState {
    pub(crate) fn new(tasks: &[Task]) -> Self {
        Self {
            selected_task_id: first_selectable_task(tasks).map(|task| task.id.clone()),
        }
    }

    fn with_selection(tasks: &[Task], selected_task_id: Option<&str>) -> Self {
        let selectable = selectable_task_ids(tasks);
        let ids: HashSet<&str> = selectable.iter().map(String::as_str).collect();
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
            "j" | "l" | "right" | "down" | "\u{1b}[C" | "\u{1b}[B" => {
                current.saturating_add(1).min(order.len() - 1)
            }
            "k" | "h" | "left" | "up" | "\u{1b}[D" | "\u{1b}[A" => current.saturating_sub(1),
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
        .map(render_ansi_row)
        .collect()
}

fn render_ansi_row(row: &[Cell]) -> String {
    let mut output = String::new();
    let mut current_style: Option<(Color, Color, Modifier)> = None;
    for cell in row {
        let next_style = (cell.fg, cell.bg, cell.modifier);
        let is_plain = next_style == (Color::Reset, Color::Reset, Modifier::empty());
        if is_plain && current_style.is_some() {
            output.push_str("\x1b[0m");
            current_style = None;
        } else if !is_plain && current_style != Some(next_style) {
            if current_style.is_some() {
                output.push_str("\x1b[0m");
            }
            output.push_str(&cell_style_ansi(cell));
            current_style = Some(next_style);
        }
        output.push_str(cell.symbol());
    }
    if current_style.is_some() {
        output.push_str("\x1b[0m");
    }
    output
}

fn cell_style_ansi(cell: &Cell) -> String {
    let mut codes: Vec<String> = Vec::new();
    if let Some(code) = color_ansi(cell.fg, false) {
        codes.push(code);
    }
    if let Some(code) = color_ansi(cell.bg, true) {
        codes.push(code);
    }
    if cell.modifier.contains(Modifier::BOLD) {
        codes.push("1".to_string());
    }
    if cell.modifier.contains(Modifier::ITALIC) {
        codes.push("3".to_string());
    }
    if cell.modifier.contains(Modifier::UNDERLINED) {
        codes.push("4".to_string());
    }
    if codes.is_empty() {
        String::new()
    } else {
        format!("\x1b[{}m", codes.join(";"))
    }
}

fn color_ansi(color: Color, background: bool) -> Option<String> {
    let base = if background { 40 } else { 30 };
    let bright_base = if background { 100 } else { 90 };
    let code = match color {
        Color::Reset => return None,
        Color::Black => base,
        Color::Red => base + 1,
        Color::Green => base + 2,
        Color::Yellow => base + 3,
        Color::Blue => base + 4,
        Color::Magenta => base + 5,
        Color::Cyan => base + 6,
        Color::Gray => base + 7,
        Color::DarkGray => bright_base,
        Color::LightRed => bright_base + 1,
        Color::LightGreen => bright_base + 2,
        Color::LightYellow => bright_base + 3,
        Color::LightBlue => bright_base + 4,
        Color::LightMagenta => bright_base + 5,
        Color::LightCyan => bright_base + 6,
        Color::White => bright_base + 7,
        Color::Rgb(red, green, blue) => {
            let layer = if background { 48 } else { 38 };
            return Some(format!("{layer};2;{red};{green};{blue}"));
        }
        Color::Indexed(index) => {
            let layer = if background { 48 } else { 38 };
            return Some(format!("{layer};5;{index}"));
        }
    };
    Some(code.to_string())
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

    let (lines, selected_row) = render_groups(&groups, state);
    let scroll = selected_row
        .and_then(|row| {
            let visible_height = inner.height.saturating_sub(1) as usize;
            if visible_height > 0 && row >= visible_height {
                Some((row - visible_height + 1) as u16)
            } else {
                None
            }
        })
        .unwrap_or_default();
    Paragraph::new(lines)
        .scroll((scroll, 0))
        .render(inner, buffer);
}

fn render_groups(
    groups: &[TaskGroup],
    state: &TaskTuiState,
) -> (Vec<Line<'static>>, Option<usize>) {
    let mut lines = Vec::new();
    let mut selected_row = None;
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
                if state.selected_task_id.as_deref() == Some(task.id.as_str()) {
                    selected_row = Some(lines.len());
                }
                lines.push(task_line(
                    task,
                    state.selected_task_id.as_deref() == Some(task.id.as_str()),
                ));
            }
        }
    }
    (lines, selected_row)
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
    let line = Line::from(vec![
        Span::raw(format!("  {marker} ")),
        Span::styled(type_icon(task), Style::default().fg(type_color(task))),
        Span::raw(format!(" {} {}{}{}", task.id, task.title, labels, assignee)),
    ]);
    if selected {
        line.style(
            Style::default()
                .fg(Color::White)
                .bg(Color::Blue)
                .add_modifier(Modifier::BOLD),
        )
    } else {
        line
    }
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
    project_ticket_board(tasks)
        .boards
        .into_iter()
        .map(|board| TaskGroup {
            title: board.title,
            label: board.key,
            priority: board.priority,
            updated_at: board.updated_at,
            done: board.done,
            total: board.total,
            lanes: board
                .lanes
                .into_iter()
                .map(|lane| TaskLane {
                    title: lane.title,
                    color: lane_color(lane.id),
                    tasks: lane.tickets.into_iter().map(|ticket| ticket.task).collect(),
                })
                .collect(),
        })
        .collect()
}

fn lane_color(lane: TicketBoardLaneId) -> Color {
    match lane {
        TicketBoardLaneId::Rejected => Color::Red,
        TicketBoardLaneId::Ready => Color::Blue,
        TicketBoardLaneId::Blocked => Color::DarkGray,
        TicketBoardLaneId::InProgress => Color::Yellow,
        TicketBoardLaneId::InReview => Color::Magenta,
        TicketBoardLaneId::Done => Color::Green,
    }
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
            epic_id: (task_type != "epic").then(|| "test-epic".to_string()),
            epic_title: None,
            parent_id: None,
            blocked_by: Vec::new(),
            created_at: 0,
            updated_at: 0,
        }
    }

    fn strip_ansi(input: &str) -> String {
        let mut output = String::new();
        let mut chars = input.chars();
        while let Some(ch) = chars.next() {
            if ch == '\u{1b}' {
                for escaped in chars.by_ref() {
                    if escaped.is_ascii_alphabetic() {
                        break;
                    }
                }
            } else {
                output.push(ch);
            }
        }
        output
    }

    #[test]
    fn task_tui_renders_empty_state() {
        let lines = strip_ansi(&render_task_tui_lines(&[], 40, 8).join("\n"));
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

        let rendered = render_task_tui_lines(&[epic, feature, bug], 80, 16).join("\n");
        let lines = strip_ansi(&rendered);
        assert!(rendered.contains("\x1b["));
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

        let lines = strip_ansi(
            &render_task_tui_lines(&[ready, in_review, in_progress, done, blocked], 52, 18)
                .join("\n"),
        );
        assert!(lines.contains("Unknown Epic: test-epic"));
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

    #[test]
    fn task_tui_input_moves_selection_and_scrolls_to_it() {
        let mut tasks: Vec<Task> = (0..10)
            .map(|index| {
                task(
                    &format!("task{index}"),
                    &format!("Task {index}"),
                    "open",
                    "feature",
                )
            })
            .collect();
        tasks[9].priority = 100;
        let mut state = TaskTuiState::with_selection(&tasks, Some("task0"));
        state.handle_input(&tasks, "l");
        assert_eq!(state.selected_task_id.as_deref(), Some("task1"));
        state.handle_input(&tasks, "h");
        assert_eq!(state.selected_task_id.as_deref(), Some("task0"));
        state.handle_input(&tasks, "j");
        assert_eq!(state.selected_task_id.as_deref(), Some("task1"));

        let rendered = render_task_tui_lines_with_state(
            &tasks,
            60,
            6,
            &TaskTuiState {
                selected_task_id: Some("task1".to_string()),
            },
        )
        .join("\n");
        assert!(strip_ansi(&rendered).contains("› ★ task1 Task 1"));
        assert!(rendered.contains("\x1b["));
    }

    #[test]
    fn task_tui_interactive_keys_move_and_quit() {
        let tasks: Vec<Task> = (0..3)
            .map(|index| {
                task(
                    &format!("task{index}"),
                    &format!("Task {index}"),
                    "open",
                    "feature",
                )
            })
            .collect();
        let mut state = TaskTuiState::with_selection(&tasks, Some("task0"));

        assert!(!handle_interactive_key(
            &mut state,
            &tasks,
            KeyEvent::new(KeyCode::Right, KeyModifiers::NONE),
        ));
        assert_eq!(state.selected_task_id.as_deref(), Some("task1"));
        assert!(!handle_interactive_key(
            &mut state,
            &tasks,
            KeyEvent::new(KeyCode::Char('h'), KeyModifiers::NONE),
        ));
        assert_eq!(state.selected_task_id.as_deref(), Some("task0"));
        assert!(handle_interactive_key(
            &mut state,
            &tasks,
            KeyEvent::new(KeyCode::Char('q'), KeyModifiers::NONE),
        ));
    }
}
