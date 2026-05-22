use std::{
    collections::HashSet,
    fs,
    io::{self, BufRead, Write},
    process::Command,
};

use anyhow::{Context, Result};
use crossterm::{
    event::{self, Event, KeyCode, KeyEvent, KeyModifiers},
    execute,
    terminal::{EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode},
};
use serde::{Deserialize, Serialize};
use tui_textarea::{CursorMove, Input as TextInput, Key as TextKey, TextArea, WrapMode};
use tuirealm::ratatui;
use tuirealm::{
    command::{Cmd, CmdResult},
    component::Component,
    props::{AttrValue, Attribute, QueryResult},
    ratatui::{
        Terminal,
        backend::{CrosstermBackend, TestBackend},
        buffer::Cell,
        layout::Rect,
        prelude::Widget,
        style::{Color, Modifier, Style},
        text::{Line, Span},
        widgets::{Block, Borders, Paragraph, Wrap},
    },
    state::{State, StateValue},
};

use crate::task::Task;
use crate::task_board::{TicketBoardLaneId, project_ticket_board};

#[derive(Clone, Debug)]
pub(crate) struct TaskTuiState {
    selected_task_id: Option<String>,
    view: TaskTuiView,
    editor: Option<TaskEditor>,
    pending_mutation: Option<TaskTuiMutation>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum TaskTuiView {
    Board,
    Detail,
    Edit,
    Help,
}

#[derive(Clone, Debug)]
struct TaskEditor {
    original: EditableTask,
    draft: EditableTask,
    field: EditField,
    editing: bool,
    textarea: TextArea<'static>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct EditableTask {
    title: String,
    body: String,
    status: String,
    priority: i64,
    assigned_to: String,
    labels: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum EditField {
    Title,
    Body,
    Status,
    Priority,
    Assignee,
    Labels,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
struct TaskTuiMutation {
    action: &'static str,
    params: serde_json::Value,
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
    selected_task_id: Option<String>,
    input: Option<String>,
    tasks: Option<Vec<Task>>,
}

#[derive(Debug, Serialize)]
struct TaskTuiEmbedResponse {
    request_id: u64,
    lines: Vec<String>,
    selected_task_id: Option<String>,
    mutation: Option<TaskTuiMutation>,
    editing: bool,
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
            state = state.with_refreshed_tasks(&tasks);
        }
        if let Some(selected_task_id) = request.selected_task_id.as_deref() {
            state = if request.input.is_none()
                && state.selected_task_id.as_deref() != Some(selected_task_id)
            {
                TaskTuiState::with_selection(&tasks, Some(selected_task_id))
            } else {
                state.with_selected_task_id(&tasks, Some(selected_task_id))
            };
        }
        if let Some(input) = request.input.as_deref() {
            state.handle_input(&tasks, input);
        }
        let response = TaskTuiEmbedResponse {
            request_id: request.request_id,
            lines: render_task_tui_lines_with_state(&tasks, request.width, request.height, &state),
            selected_task_id: state.selected_task_id.clone(),
            mutation: state.pending_mutation.take(),
            editing: state.editor.as_ref().is_some_and(|editor| editor.editing),
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
        terminal.draw(|frame| {
            let area = frame.area();
            let mut component = TaskTuiComponent::new(tasks, state);
            component.view(frame, area);
        })?;
        if let Event::Key(key) = event::read()?
            && handle_interactive_key(state, tasks, key)
        {
            break;
        }
    }
    Ok(())
}

fn handle_interactive_key(state: &mut TaskTuiState, tasks: &[Task], key: KeyEvent) -> bool {
    if state.editor.as_ref().is_some_and(|editor| editor.editing) {
        match key.code {
            KeyCode::Esc => state.handle_input(tasks, "\u{1b}"),
            KeyCode::Enter => state.handle_input(tasks, "\n"),
            KeyCode::Backspace => state.handle_input(tasks, "backspace"),
            KeyCode::Delete => state.handle_input(tasks, "delete"),
            KeyCode::Left => state.handle_input(tasks, "left"),
            KeyCode::Right => state.handle_input(tasks, "right"),
            KeyCode::Up => state.handle_input(tasks, "up"),
            KeyCode::Down => state.handle_input(tasks, "down"),
            KeyCode::Home => state.handle_input(tasks, "home"),
            KeyCode::End => state.handle_input(tasks, "end"),
            KeyCode::Char('g') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                state.handle_input(tasks, "ctrl-g")
            }
            KeyCode::Char('s') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                state.handle_input(tasks, "ctrl-s")
            }
            KeyCode::Char('a') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                state.handle_input(tasks, "ctrl-a")
            }
            KeyCode::Char('e') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                state.handle_input(tasks, "ctrl-e")
            }
            KeyCode::Char('b') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                state.handle_input(tasks, "ctrl-b")
            }
            KeyCode::Char('f') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                state.handle_input(tasks, "ctrl-f")
            }
            KeyCode::Char('d') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                state.handle_input(tasks, "ctrl-d")
            }
            KeyCode::Char('k') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                state.handle_input(tasks, "ctrl-k")
            }
            KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                state.handle_input(tasks, "ctrl-u")
            }
            KeyCode::Char('p') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                state.handle_input(tasks, "ctrl-p")
            }
            KeyCode::Char('n') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                state.handle_input(tasks, "ctrl-n")
            }
            KeyCode::Char(ch) => state.handle_input(tasks, &ch.to_string()),
            _ => {}
        }
        return false;
    }
    match key.code {
        KeyCode::Esc => {
            state.handle_input(tasks, "esc");
            false
        }
        KeyCode::Char('q') => true,
        KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => true,
        KeyCode::Char('g') if key.modifiers.contains(KeyModifiers::CONTROL) => {
            state.handle_input(tasks, "ctrl-g");
            false
        }
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
        KeyCode::Enter => {
            state.handle_input(tasks, "\n");
            false
        }
        KeyCode::Backspace => {
            state.handle_input(tasks, "backspace");
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
            view: TaskTuiView::Board,
            editor: None,
            pending_mutation: None,
        }
    }

    fn with_selection(tasks: &[Task], selected_task_id: Option<&str>) -> Self {
        let selectable = selectable_task_ids(tasks);
        let ids: HashSet<&str> = selectable.iter().map(String::as_str).collect();
        if let Some(id) = selected_task_id.filter(|id| ids.contains(id)) {
            Self {
                selected_task_id: Some(id.to_string()),
                view: TaskTuiView::Detail,
                editor: None,
                pending_mutation: None,
            }
        } else {
            Self::new(tasks)
        }
    }

    fn with_refreshed_tasks(&self, tasks: &[Task]) -> Self {
        let mut next = Self::with_selection(tasks, self.selected_task_id.as_deref());
        next.view = self.view.clone();
        next.editor = self.editor.clone();
        next.pending_mutation = self.pending_mutation.clone();
        next
    }

    fn with_selected_task_id(&self, tasks: &[Task], selected_task_id: Option<&str>) -> Self {
        let selectable = selectable_task_ids(tasks);
        let ids: HashSet<&str> = selectable.iter().map(String::as_str).collect();
        let selected_task_id = selected_task_id
            .filter(|id| ids.contains(id))
            .map(ToOwned::to_owned)
            .or_else(|| first_selectable_task(tasks).map(|task| task.id.clone()));
        Self {
            selected_task_id,
            view: self.view.clone(),
            editor: self.editor.clone(),
            pending_mutation: self.pending_mutation.clone(),
        }
    }

    fn handle_input(&mut self, tasks: &[Task], input: &str) {
        if self.view == TaskTuiView::Edit && self.handle_editor_input(tasks, input) {
            return;
        }
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
        match input {
            "?" => {
                self.view = TaskTuiView::Help;
                return;
            }
            "esc" => {
                self.view = TaskTuiView::Board;
                self.editor = None;
                return;
            }
            "e" => {
                self.view = TaskTuiView::Edit;
                self.ensure_editor(tasks);
                return;
            }
            "enter" | "\n" | "\r" | "o" => {
                self.view = TaskTuiView::Detail;
                return;
            }
            "b" | "list" => {
                self.view = TaskTuiView::Board;
                self.editor = None;
                return;
            }
            _ => {}
        }
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

    fn ensure_editor(&mut self, tasks: &[Task]) {
        if self.editor.is_some() {
            return;
        }
        if let Some(task) = self.selected_task(tasks) {
            self.editor = Some(TaskEditor::new(task));
        }
    }

    fn selected_task<'a>(&self, tasks: &'a [Task]) -> Option<&'a Task> {
        self.selected_task_id
            .as_deref()
            .and_then(|id| tasks.iter().find(|task| task.id == id))
    }

    fn handle_editor_input(&mut self, tasks: &[Task], input: &str) -> bool {
        self.ensure_editor(tasks);
        let Some(editor) = self.editor.as_mut() else {
            return false;
        };
        if editor.editing {
            match input {
                "ctrl-g" => editor.open_buffer_in_external_editor(),
                "\n" | "\r" | "enter" if editor.field == EditField::Body => {
                    editor.handle_text_input(TextInput {
                        key: TextKey::Enter,
                        ctrl: false,
                        alt: false,
                        shift: false,
                    });
                }
                "\n" | "\r" | "enter" | "ctrl-s" => editor.commit_buffer(),
                "\u{1b}" | "esc" => editor.cancel_buffer(),
                _ if let Some(text_input) = text_input_from_bridge(input) => {
                    editor.handle_text_input(text_input);
                }
                _ => {}
            }
            return true;
        }
        match input {
            "j" | "down" | "\u{1b}[B" => editor.next_field(),
            "k" | "up" | "\u{1b}[A" => editor.previous_field(),
            "t" => editor.select_field(EditField::Title),
            "b" => editor.select_field(EditField::Body),
            "x" | "esc" => {
                self.view = TaskTuiView::Board;
                self.editor = None;
            }
            "o" | "\n" | "\r" | "enter" => editor.begin_edit(),
            "ctrl-g" => editor.open_field_in_external_editor(),
            "s" => {
                if let Some(id) = self.selected_task_id.clone() {
                    self.pending_mutation = Some(editor.mutation(&id));
                }
            }
            "?" => self.view = TaskTuiView::Help,
            _ => return false,
        }
        true
    }
}

impl TaskEditor {
    fn new(task: &Task) -> Self {
        let editable = EditableTask {
            title: task.title.clone(),
            body: task.body.clone(),
            status: task.status.clone(),
            priority: task.priority,
            assigned_to: task.assigned_to.clone().unwrap_or_default(),
            labels: task.labels.join(", "),
        };
        Self {
            original: editable.clone(),
            draft: editable,
            field: EditField::Title,
            editing: false,
            textarea: TextArea::default(),
        }
    }

    fn begin_edit(&mut self) {
        self.textarea = textarea_from_text(&self.field_value(self.field));
        self.textarea.move_cursor(CursorMove::Bottom);
        self.textarea.move_cursor(CursorMove::End);
        self.editing = true;
    }

    fn commit_buffer(&mut self) {
        let buffer = self.buffer_text();
        match self.field {
            EditField::Title => self.draft.title = buffer.trim().to_string(),
            EditField::Body => self.draft.body = buffer,
            EditField::Status => self.draft.status = buffer.trim().to_string(),
            EditField::Priority => {
                if let Ok(priority) = buffer.trim().parse::<i64>() {
                    self.draft.priority = priority;
                }
            }
            EditField::Assignee => self.draft.assigned_to = buffer.trim().to_string(),
            EditField::Labels => self.draft.labels = buffer.trim().to_string(),
        }
        self.editing = false;
        self.textarea = TextArea::default();
    }

    fn cancel_buffer(&mut self) {
        self.editing = false;
        self.textarea = TextArea::default();
    }

    fn open_field_in_external_editor(&mut self) {
        self.begin_edit();
        self.open_buffer_in_external_editor();
        self.commit_buffer();
    }

    fn open_buffer_in_external_editor(&mut self) {
        if let Ok(edited) = edit_text_with_external_editor(&self.buffer_text()) {
            self.textarea = textarea_from_text(&edited);
            self.textarea.move_cursor(CursorMove::Bottom);
            self.textarea.move_cursor(CursorMove::End);
        }
    }

    fn display_value(&self, field: EditField) -> String {
        if self.editing && self.field == field {
            return self.buffer_text();
        }
        self.field_value(field)
    }

    fn handle_text_input(&mut self, input: TextInput) {
        self.textarea.input(input);
    }

    fn buffer_text(&self) -> String {
        self.textarea.lines().join("\n")
    }

    fn cursor_line_and_column(&self) -> (usize, usize) {
        self.textarea.cursor()
    }

    fn next_field(&mut self) {
        self.field = match self.field {
            EditField::Title => EditField::Body,
            EditField::Body => EditField::Status,
            EditField::Status => EditField::Priority,
            EditField::Priority => EditField::Assignee,
            EditField::Assignee => EditField::Labels,
            EditField::Labels => EditField::Title,
        };
    }

    fn previous_field(&mut self) {
        self.field = match self.field {
            EditField::Title => EditField::Labels,
            EditField::Body => EditField::Title,
            EditField::Status => EditField::Body,
            EditField::Priority => EditField::Status,
            EditField::Assignee => EditField::Priority,
            EditField::Labels => EditField::Assignee,
        };
    }

    fn select_field(&mut self, field: EditField) {
        self.field = field;
        self.begin_edit();
    }

    fn value(&self, field: EditField) -> &str {
        match field {
            EditField::Title => &self.draft.title,
            EditField::Body => &self.draft.body,
            EditField::Status => &self.draft.status,
            EditField::Priority => "",
            EditField::Assignee => &self.draft.assigned_to,
            EditField::Labels => &self.draft.labels,
        }
    }

    fn field_value(&self, field: EditField) -> String {
        match field {
            EditField::Priority => self.draft.priority.to_string(),
            _ => self.value(field).to_string(),
        }
    }

    fn mutation(&self, id: &str) -> TaskTuiMutation {
        let labels: Vec<String> = self
            .draft
            .labels
            .split(',')
            .map(str::trim)
            .filter(|label| !label.is_empty())
            .map(ToOwned::to_owned)
            .collect();
        let mut params = serde_json::json!({
            "id": id,
            "title": self.draft.title,
            "body": self.draft.body,
            "status": self.draft.status,
            "priority": self.draft.priority,
            "labels": labels,
        });
        if let Some(object) = params.as_object_mut() {
            if self.draft.assigned_to.is_empty() {
                object.insert("clear_assignee".to_string(), serde_json::Value::Bool(true));
            } else {
                object.insert(
                    "assigned_to".to_string(),
                    serde_json::Value::String(self.draft.assigned_to.clone()),
                );
            }
        }
        TaskTuiMutation {
            action: "update",
            params,
        }
    }
}

impl EditableTask {
    fn field_value(&self, field: EditField) -> String {
        match field {
            EditField::Title => self.title.clone(),
            EditField::Body => self.body.clone(),
            EditField::Status => self.status.clone(),
            EditField::Priority => self.priority.to_string(),
            EditField::Assignee => self.assigned_to.clone(),
            EditField::Labels => self.labels.clone(),
        }
    }
}

impl EditField {
    fn label(self) -> &'static str {
        match self {
            EditField::Title => "Title",
            EditField::Body => "Body",
            EditField::Status => "Status",
            EditField::Priority => "Priority",
            EditField::Assignee => "Assignee",
            EditField::Labels => "Labels",
        }
    }
}

fn edit_text_with_external_editor(text: &str) -> Result<String> {
    let mut file = tempfile::NamedTempFile::new().context("create editor temp file")?;
    file.write_all(text.as_bytes())
        .context("write editor temp file")?;
    file.flush().context("flush editor temp file")?;
    let path = file.path().to_path_buf();
    let editor = std::env::var("VISUAL")
        .or_else(|_| std::env::var("EDITOR"))
        .unwrap_or_else(|_| "vi".to_string());
    let mut parts = editor.split_whitespace();
    let command = parts.next().unwrap_or("vi");
    let status = Command::new(command)
        .args(parts)
        .arg(&path)
        .status()
        .context("launch $EDITOR")?;
    if !status.success() {
        return Ok(text.to_string());
    }
    fs::read_to_string(path).context("read editor temp file")
}

fn textarea_from_text(text: &str) -> TextArea<'static> {
    TextArea::new(text.split('\n').map(ToOwned::to_owned).collect())
}

fn text_input_from_bridge(input: &str) -> Option<TextInput> {
    let key = match input {
        "\u{7f}" | "backspace" => TextKey::Backspace,
        "delete" => TextKey::Delete,
        "left" => TextKey::Left,
        "right" => TextKey::Right,
        "up" => TextKey::Up,
        "down" => TextKey::Down,
        "home" => TextKey::Home,
        "end" => TextKey::End,
        "\n" | "\r" | "enter" => TextKey::Enter,
        "ctrl-a" => return Some(ctrl_text_input('a')),
        "ctrl-b" => return Some(ctrl_text_input('b')),
        "ctrl-d" => return Some(ctrl_text_input('d')),
        "ctrl-e" => return Some(ctrl_text_input('e')),
        "ctrl-f" => return Some(ctrl_text_input('f')),
        "ctrl-k" => return Some(ctrl_text_input('k')),
        "ctrl-n" => return Some(ctrl_text_input('n')),
        "ctrl-p" => return Some(ctrl_text_input('p')),
        "ctrl-u" => return Some(ctrl_text_input('u')),
        _ if input.chars().count() == 1 => TextKey::Char(input.chars().next()?),
        _ => return None,
    };
    Some(TextInput {
        key,
        ctrl: false,
        alt: false,
        shift: false,
    })
}

fn ctrl_text_input(ch: char) -> TextInput {
    TextInput {
        key: TextKey::Char(ch),
        ctrl: true,
        alt: false,
        shift: false,
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
        .draw(|frame| {
            let area = frame.area();
            let mut component = TaskTuiComponent::new(tasks, state);
            component.view(frame, area);
        })
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

struct TaskTuiComponent<'a> {
    tasks: &'a [Task],
    state: &'a TaskTuiState,
}

impl<'a> TaskTuiComponent<'a> {
    fn new(tasks: &'a [Task], state: &'a TaskTuiState) -> Self {
        Self { tasks, state }
    }
}

impl Component for TaskTuiComponent<'_> {
    fn view(&mut self, frame: &mut tuirealm::ratatui::Frame, area: Rect) {
        render_task_tui(area, frame.buffer_mut(), self.tasks, self.state);
    }

    fn query<'a>(&'a self, _attr: Attribute) -> Option<QueryResult<'a>> {
        None
    }

    fn attr(&mut self, _attr: Attribute, _value: AttrValue) {}

    fn state(&self) -> State {
        State::Single(StateValue::String(
            self.state.selected_task_id.clone().unwrap_or_default(),
        ))
    }

    fn perform(&mut self, _cmd: Cmd) -> CmdResult {
        CmdResult::NoChange
    }
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
        Paragraph::new(vec![
            Line::from(Span::styled(
                "Tasks",
                Style::default()
                    .fg(Color::Cyan)
                    .add_modifier(Modifier::BOLD),
            )),
            Line::from(""),
            Line::from("No tasks"),
        ])
        .render(inner, buffer);
        return;
    }

    let selected_task = state
        .selected_task_id
        .as_deref()
        .and_then(|id| tasks.iter().find(|task| task.id == id));

    match (&state.view, selected_task) {
        (TaskTuiView::Detail, Some(task)) => {
            render_task_detail_first(inner, buffer, task);
            return;
        }
        (TaskTuiView::Edit, Some(task)) => {
            render_task_edit(inner, buffer, task, state.editor.as_ref());
            return;
        }
        (TaskTuiView::Help, _) => {
            render_task_help(inner, buffer);
            return;
        }
        _ => {}
    }

    render_task_list(inner, buffer, &groups, state, None);
}

fn render_task_detail_first(area: Rect, buffer: &mut ratatui::buffer::Buffer, task: &Task) {
    let inner = area;

    let mut lines = vec![
        Line::from(Span::styled(
            format!("Task {} — {}", task.id, task.title),
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        )),
        Line::from(""),
        Line::from(vec![
            Span::styled("Status: ", Style::default().fg(Color::DarkGray)),
            Span::raw(task.status.clone()),
            Span::styled("   Priority: ", Style::default().fg(Color::DarkGray)),
            Span::raw(task.priority.to_string()),
            Span::styled("   Assignee: ", Style::default().fg(Color::DarkGray)),
            Span::raw(
                task.assigned_label
                    .as_ref()
                    .or(task.assigned_to.as_ref())
                    .map(|value| compact(value, 28))
                    .unwrap_or_else(|| "none".to_string()),
            ),
        ]),
        Line::from(vec![
            Span::styled("Blockers: ", Style::default().fg(Color::DarkGray)),
            Span::raw(if task.blocked_by.is_empty() {
                "none".to_string()
            } else {
                task.blocked_by.join(", ")
            }),
        ]),
    ];
    if !task.body.trim().is_empty() {
        lines.push(Line::from(""));
        lines.extend(task_body_lines(&task.body));
    }

    Paragraph::new(lines)
        .wrap(Wrap { trim: false })
        .render(inner, buffer);
}

fn render_task_edit(
    area: Rect,
    buffer: &mut ratatui::buffer::Buffer,
    task: &Task,
    editor: Option<&TaskEditor>,
) {
    let inner = area;
    let Some(editor) = editor else {
        Paragraph::new("No editable task selected").render(inner, buffer);
        return;
    };
    let mut y = inner.y;
    let bottom = inner.y.saturating_add(inner.height);
    let header = vec![
        Line::from(Span::styled(
            format!("Edit Task {}", task.id),
            Style::default()
                .fg(Color::Yellow)
                .add_modifier(Modifier::BOLD),
        )),
        Line::from(""),
        Line::from(Span::styled(
            task.title.clone(),
            Style::default()
                .fg(Color::Yellow)
                .add_modifier(Modifier::BOLD),
        )),
        Line::from(Span::styled(
            if editor.editing {
                "Typing: Enter inserts newline in Body, Ctrl-S saves field, Ctrl-G opens $EDITOR"
            } else {
                "j/k move, Enter edits, Ctrl-G opens $EDITOR, s saves task, Esc returns"
            },
            Style::default().fg(Color::DarkGray),
        )),
        Line::from(""),
    ];
    let header_height = header.len().min(bottom.saturating_sub(y) as usize) as u16;
    Paragraph::new(header).render(
        Rect {
            x: inner.x,
            y,
            width: inner.width,
            height: header_height,
        },
        buffer,
    );
    y = y.saturating_add(header_height);
    for field in [
        EditField::Title,
        EditField::Body,
        EditField::Status,
        EditField::Priority,
        EditField::Assignee,
        EditField::Labels,
    ] {
        if y >= bottom {
            break;
        }
        if editor.field == field && editor.editing {
            let used = render_active_edit_field(inner, y, bottom, buffer, editor, field);
            y = y.saturating_add(used);
        } else {
            let rows = edit_field_lines(editor, field);
            let height = rows.len().min(bottom.saturating_sub(y) as usize) as u16;
            Paragraph::new(rows).render(
                Rect {
                    x: inner.x,
                    y,
                    width: inner.width,
                    height,
                },
                buffer,
            );
            y = y.saturating_add(height);
        }
    }
    if y < bottom {
        let footer = vec![
            Line::from(""),
            Line::from(vec![
                Span::styled("Save: ", Style::default().fg(Color::Green)),
                Span::raw("s"),
                Span::raw("   "),
                Span::styled("Cancel: ", Style::default().fg(Color::Red)),
                Span::raw("Esc/x returns without saving"),
            ]),
        ];
        Paragraph::new(footer).render(
            Rect {
                x: inner.x,
                y,
                width: inner.width,
                height: 2.min(bottom.saturating_sub(y)),
            },
            buffer,
        );
    }
}

fn render_active_edit_field(
    area: Rect,
    y: u16,
    bottom: u16,
    buffer: &mut ratatui::buffer::Buffer,
    editor: &TaskEditor,
    field: EditField,
) -> u16 {
    let label_width = 14.min(area.width);
    let text_width = area.width.saturating_sub(label_width);
    let style = Style::default()
        .fg(Color::LightYellow)
        .add_modifier(Modifier::BOLD);
    let label = Line::from(Span::styled(format!(" › {:<9} ", field.label()), style));
    Paragraph::new(label).render(
        Rect {
            x: area.x,
            y,
            width: label_width,
            height: 1,
        },
        buffer,
    );
    if text_width == 0 {
        return 1;
    }
    let mut textarea = editor.textarea.clone();
    textarea.set_style(style);
    textarea.set_cursor_line_style(Style::default());
    textarea.set_cursor_style(Style::default().fg(Color::Black).bg(Color::LightYellow));
    textarea.set_wrap_mode(WrapMode::WordOrGlyph);
    let measured = textarea.measure(text_width);
    let available = bottom.saturating_sub(y).max(1);
    let height = measured.preferred_rows.min(available).max(1);
    Widget::render(
        &textarea,
        Rect {
            x: area.x.saturating_add(label_width),
            y,
            width: text_width,
            height,
        },
        buffer,
    );
    height
}

fn edit_field_lines(editor: &TaskEditor, field: EditField) -> Vec<Line<'static>> {
    let selected = editor.field == field;
    let marker = if selected { "›" } else { " " };
    let value = editor.display_value(field);
    let changed = editor.original.field_value(field) != editor.draft.field_value(field);
    let style = if selected {
        Style::default()
            .fg(Color::LightYellow)
            .add_modifier(Modifier::BOLD)
    } else if changed {
        Style::default().fg(Color::LightGreen)
    } else {
        Style::default()
    };
    let mut rows = Vec::new();
    let value_lines: Vec<&str> = value.split('\n').collect();
    for (index, value_line) in value_lines.iter().enumerate() {
        let label = if index == 0 {
            format!(" {marker} {:<9}", field.label())
        } else {
            "             ".to_string()
        };
        rows.push(Line::from(vec![
            Span::styled(label, style),
            Span::raw(" "),
            Span::styled(compact(value_line, 92), style),
        ]));
    }
    rows
}

fn render_task_help(area: Rect, buffer: &mut ratatui::buffer::Buffer) {
    let inner = area;
    let lines = vec![
        Line::from(Span::styled(
            "Task management keys",
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        )),
        Line::from(""),
        Line::from("  j/k or ↓/↑      move selection"),
        Line::from("  g / G           first / last task"),
        Line::from("  Enter or o      open selected task details"),
        Line::from("  e               edit selected task"),
        Line::from("  b               return to board"),
        Line::from("  ?               show this help"),
        Line::from("  Esc             back to board"),
        Line::from("  q               close"),
        Line::from(""),
        Line::from(
            "Task details show the full structured body so acceptance criteria and delivery evidence",
        ),
        Line::from("are reviewable directly from `/tasks <id>`."),
    ];
    Paragraph::new(lines)
        .wrap(Wrap { trim: false })
        .render(inner, buffer);
}

fn render_task_list(
    area: Rect,
    buffer: &mut ratatui::buffer::Buffer,
    groups: &[TaskGroup],
    state: &TaskTuiState,
    selected_task: Option<&Task>,
) {
    let inner = area;

    let (mut lines, selected_row) = render_groups(groups, state, selected_task);
    lines.insert(
        0,
        Line::from(Span::styled(
            "Task List",
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        )),
    );
    lines.insert(1, Line::from(""));
    let selected_row = selected_row.map(|row| row + 2);
    let scroll = selected_row
        .and_then(|row| {
            let visible_height = inner.height as usize;
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
    selected_task: Option<&Task>,
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
    if let Some(task) = selected_task {
        lines.push(Line::from(""));
        lines.extend(task_detail_lines(task));
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

fn task_detail_lines(task: &Task) -> Vec<Line<'static>> {
    let mut lines = vec![
        Line::from(Span::styled(
            "Details",
            Style::default()
                .fg(Color::Blue)
                .add_modifier(Modifier::BOLD),
        )),
        Line::from(format!(
            "  Status: {}   Priority: {}",
            task.status, task.priority
        )),
        Line::from(format!(
            "  Assignee: {}",
            task.assigned_label
                .as_ref()
                .or(task.assigned_to.as_ref())
                .map(String::as_str)
                .unwrap_or("none")
        )),
        Line::from(format!(
            "  Blockers: {}",
            if task.blocked_by.is_empty() {
                "none".to_string()
            } else {
                task.blocked_by.join(", ")
            }
        )),
    ];
    if !task.body.trim().is_empty() {
        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled(
            "Body:",
            Style::default()
                .fg(Color::DarkGray)
                .add_modifier(Modifier::BOLD),
        )));
        lines.extend(task_body_lines(&task.body));
    }
    lines
}

fn task_body_lines(body: &str) -> Vec<Line<'static>> {
    body.trim()
        .lines()
        .map(|line| {
            let trimmed = line.trim_end();
            if trimmed.is_empty() {
                Line::from("")
            } else if is_body_heading(trimmed) {
                Line::from(Span::styled(
                    trimmed.trim_start_matches('#').trim().to_string(),
                    Style::default()
                        .fg(Color::Blue)
                        .add_modifier(Modifier::BOLD),
                ))
            } else if let Some(item) = trimmed.trim_start().strip_prefix("- ") {
                Line::from(vec![
                    Span::styled("  • ", Style::default().fg(Color::DarkGray)),
                    Span::raw(item.to_string()),
                ])
            } else {
                Line::from(trimmed.to_string())
            }
        })
        .collect()
}

fn compact(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_string();
    }
    let keep = max.saturating_sub(1);
    let mut output: String = value.chars().take(keep).collect();
    output.push('…');
    output
}

fn is_body_heading(line: &str) -> bool {
    let trimmed = line.trim();
    trimmed.starts_with('#') || (trimmed.ends_with(':') && trimmed.len() <= 80)
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
                view: TaskTuiView::Board,
                editor: None,
                pending_mutation: None,
            },
        )
        .join("\n");
        assert!(strip_ansi(&rendered).contains("› ★ task1 Task 1"));
        assert!(rendered.contains("\x1b["));
    }

    #[test]
    fn task_tui_selected_task_uses_detail_pane_before_long_list() {
        let mut tasks: Vec<Task> = (0..24)
            .map(|index| {
                task(
                    &format!("task{index}"),
                    &format!("Task {index}"),
                    "open",
                    "feature",
                )
            })
            .collect();
        let mut selected = task(
            "h5",
            "Make structured task bodies readable enough",
            "rejected",
            "feature",
        );
        selected.priority = 100;
        selected.body = "Context / problem:\n\nThe body must be reviewable after opening `/tasks h5`.\n\nAgent-verifiable acceptance criteria:\n- Full issue body content is visible in the TUI.\n- Long bodies wrap predictably.".to_string();
        tasks.push(selected);

        let rendered = render_task_tui_lines_with_state(
            &tasks,
            120,
            18,
            &TaskTuiState {
                selected_task_id: Some("h5".to_string()),
                view: TaskTuiView::Detail,
                editor: None,
                pending_mutation: None,
            },
        )
        .join("\n");
        let lines = strip_ansi(&rendered);
        assert!(lines.contains("Task h5"));
        assert!(lines.contains("structured task bodies readable enough"));
        assert!(!lines.contains("Task List"));
        assert!(lines.contains("Agent-verifiable acceptance criteria"));
        assert!(lines.contains("Full issue body content"));
    }

    #[test]
    fn task_tui_help_mentions_pi_editor_body_editing() {
        let selected = task(
            "h5",
            "Make structured task bodies readable enough",
            "open",
            "feature",
        );
        let tasks = vec![selected];
        let mut state = TaskTuiState::with_selection(&tasks, Some("h5"));
        state.handle_input(&tasks, "?");
        let help = strip_ansi(&render_task_tui_lines_with_state(&tasks, 90, 14, &state).join("\n"));
        assert!(help.contains("Task management keys"));
        assert!(help.contains("Enter or o"));
        assert!(help.contains("e               edit selected task"));

        state.handle_input(&tasks, "esc");
        let board =
            strip_ansi(&render_task_tui_lines_with_state(&tasks, 90, 14, &state).join("\n"));
        assert!(board.contains("Task List"));
        assert!(board.contains("› ★ h5 Make structured task bodies readable enough"));
    }

    #[test]
    fn task_tui_edit_view_edits_fields_and_emits_save_mutation() {
        let selected = task("h5", "Old title", "open", "feature");
        let tasks = vec![selected];
        let mut state = TaskTuiState::with_selection(&tasks, Some("h5"));

        state.handle_input(&tasks, "e");
        state.handle_input(&tasks, "\n");
        for _ in 0.."Old title".len() {
            state.handle_input(&tasks, "backspace");
        }
        for ch in "New title".chars() {
            state.handle_input(&tasks, &ch.to_string());
        }
        state.handle_input(&tasks, "\n");

        let edit =
            strip_ansi(&render_task_tui_lines_with_state(&tasks, 100, 16, &state).join("\n"));
        assert!(edit.contains("New title"));
        state.handle_input(&tasks, "s");
        let mutation = state.pending_mutation.as_ref().expect("save mutation");
        assert_eq!(mutation.action, "update");
        assert_eq!(mutation.params["id"], "h5");
        assert_eq!(mutation.params["title"], "New title");
    }

    #[test]
    fn task_tui_edit_cursor_does_not_insert_synthetic_caret_row() {
        let selected = task("h5", "enough", "open", "feature");
        let tasks = vec![selected];
        let mut state = TaskTuiState::with_selection(&tasks, Some("h5"));

        state.handle_input(&tasks, "e");
        state.handle_input(&tasks, "\n");
        state.handle_input(&tasks, "ctrl-a");
        state.handle_input(&tasks, "right");
        state.handle_input(&tasks, "right");

        let rendered =
            strip_ansi(&render_task_tui_lines_with_state(&tasks, 100, 16, &state).join("\n"));
        assert!(rendered.contains("enough"));
        assert!(!rendered.contains("\n              │"));
        assert!(!rendered.contains("en▏ough"));
    }

    #[test]
    fn task_tui_edit_textarea_keys_move_between_lines() {
        let mut selected = task("h5", "Title", "open", "feature");
        selected.body = "alpha\nbeta\ncharlie".to_string();
        let tasks = vec![selected];
        let mut state = TaskTuiState::with_selection(&tasks, Some("h5"));

        state.handle_input(&tasks, "e");
        state.handle_input(&tasks, "j");
        state.handle_input(&tasks, "\n");
        state.handle_input(&tasks, "ctrl-a");
        state.handle_input(&tasks, "ctrl-p");
        state.handle_input(&tasks, "ctrl-p");
        state.handle_input(&tasks, "ctrl-e");
        state.handle_input(&tasks, "X");
        state.handle_input(&tasks, "down");
        state.handle_input(&tasks, "Y");
        state.handle_input(&tasks, "ctrl-s");
        state.handle_input(&tasks, "s");

        let mutation = state.pending_mutation.as_ref().expect("save mutation");
        assert_eq!(mutation.params["body"], "alphaX\nbetaY\ncharlie");
    }

    #[test]
    fn task_tui_edit_active_field_does_not_compact_long_body() {
        let mut selected = task("h5", "Title", "open", "feature");
        selected.body = "Delivery evidence:\n\n- To be filled by `$implement` after running the full relevant verification and explaining exactly what changed.".to_string();
        let tasks = vec![selected];
        let mut state = TaskTuiState::with_selection(&tasks, Some("h5"));

        state.handle_input(&tasks, "e");
        state.handle_input(&tasks, "j");
        state.handle_input(&tasks, "\n");

        let rendered =
            strip_ansi(&render_task_tui_lines_with_state(&tasks, 80, 18, &state).join("\n"));
        assert!(rendered.contains("Delivery evidence:"));
        assert!(rendered.contains("full relevant"), "{rendered}");
        assert!(
            rendered.contains("verification and explaining"),
            "{rendered}"
        );
        assert!(!rendered.contains("…"));
        assert!(!rendered.contains("\n              │"));
    }

    #[test]
    fn task_tui_board_navigation_stays_on_task_list() {
        let tasks = vec![
            task("a", "First", "open", "feature"),
            task("b", "Second", "open", "feature"),
        ];
        let mut state = TaskTuiState::new(&tasks);
        state.handle_input(&tasks, "j");

        assert_eq!(state.view, TaskTuiView::Board);
        assert_eq!(state.selected_task_id.as_deref(), Some("b"));
        let rendered =
            strip_ansi(&render_task_tui_lines_with_state(&tasks, 80, 12, &state).join("\n"));
        assert!(rendered.contains("Task List"));
        assert!(!rendered.contains("Task b — Second"));
    }

    #[test]
    fn task_tui_embed_selection_sync_does_not_open_detail_on_navigation() {
        let tasks = vec![
            task("a", "First", "open", "feature"),
            task("b", "Second", "open", "feature"),
        ];
        let mut state = TaskTuiState::new(&tasks);

        state = state.with_selected_task_id(&tasks, Some("a"));
        state.handle_input(&tasks, "j");

        assert_eq!(state.view, TaskTuiView::Board);
        assert_eq!(state.selected_task_id.as_deref(), Some("b"));
    }

    #[test]
    fn task_tui_escape_backs_out_before_closing() {
        let tasks = vec![task(
            "h5",
            "Make structured task bodies readable enough",
            "open",
            "feature",
        )];
        let mut state = TaskTuiState::with_selection(&tasks, Some("h5"));

        assert!(!handle_interactive_key(
            &mut state,
            &tasks,
            KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE),
        ));
        assert_eq!(state.view, TaskTuiView::Board);

        assert!(!handle_interactive_key(
            &mut state,
            &tasks,
            KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE),
        ));
        assert!(handle_interactive_key(
            &mut state,
            &tasks,
            KeyEvent::new(KeyCode::Char('q'), KeyModifiers::NONE),
        ));
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
