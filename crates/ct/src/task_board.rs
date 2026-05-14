use std::collections::HashMap;

use serde::Serialize;

use crate::task::Task;

pub(crate) const NO_EPIC_BOARD_KEY: &str = "no-epic";
pub(crate) const NO_EPIC_BOARD_TITLE: &str = "No Epic";

#[derive(Clone, Debug, Serialize)]
pub(crate) struct TicketBoardProjection {
    pub(crate) boards: Vec<TicketBoard>,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct TicketBoard {
    pub(crate) key: String,
    pub(crate) title: String,
    pub(crate) epic_label: Option<String>,
    pub(crate) priority: i64,
    pub(crate) updated_at: i64,
    pub(crate) done: usize,
    pub(crate) total: usize,
    pub(crate) lanes: Vec<TicketBoardLane>,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct TicketBoardLane {
    pub(crate) id: TicketBoardLaneId,
    pub(crate) title: &'static str,
    pub(crate) tickets: Vec<TicketBoardTicket>,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct TicketBoardTicket {
    pub(crate) task: Task,
    pub(crate) lane: TicketBoardLaneId,
    pub(crate) blocked_reasons: Vec<BlockedReason>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TicketBoardLaneId {
    Rejected,
    Ready,
    Blocked,
    InProgress,
    InReview,
    Done,
}

impl TicketBoardLaneId {
    pub(crate) fn title(self) -> &'static str {
        match self {
            Self::Rejected => "Rejected",
            Self::Ready => "Ready",
            Self::Blocked => "Blocked",
            Self::InProgress => "In Progress",
            Self::InReview => "In Review",
            Self::Done => "Done",
        }
    }

    const fn order() -> [Self; 6] {
        [
            Self::Rejected,
            Self::Ready,
            Self::Blocked,
            Self::InProgress,
            Self::InReview,
            Self::Done,
        ]
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub(crate) struct BlockedReason {
    pub(crate) kind: BlockedReasonKind,
    pub(crate) task_id: String,
    pub(crate) title: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum BlockedReasonKind {
    OpenBlocker,
    MissingBlocker,
    CanceledBlocker,
    ActiveChild,
}

pub(crate) fn project_ticket_board(tasks: &[Task]) -> TicketBoardProjection {
    let by_id = tasks
        .iter()
        .map(|task| (task.id.as_str(), task))
        .collect::<HashMap<_, _>>();
    let epics = tasks
        .iter()
        .filter(|task| task.task_type == "epic")
        .filter_map(|task| task.epic_id.as_deref().map(|label| (label, task)))
        .collect::<HashMap<_, _>>();
    let children = task_children(tasks);
    let mut grouped: HashMap<String, Vec<TicketBoardTicket>> = HashMap::new();

    for task in tasks
        .iter()
        .filter(|task| task.task_type != "epic" && !is_canceled(task))
    {
        let blocked_reasons = blocked_reasons(task, &by_id, &children);
        let lane = ticket_lane(task, &blocked_reasons);
        let key = task
            .epic_id
            .as_deref()
            .filter(|label| !label.trim().is_empty())
            .unwrap_or(NO_EPIC_BOARD_KEY)
            .to_string();
        grouped.entry(key).or_default().push(TicketBoardTicket {
            task: task.clone(),
            lane,
            blocked_reasons,
        });
    }

    let mut boards = grouped
        .into_iter()
        .map(|(key, tickets)| board_for_group(key, tickets, &epics))
        .collect::<Vec<_>>();
    boards.sort_by(|left, right| {
        right
            .priority
            .cmp(&left.priority)
            .then_with(|| right.updated_at.cmp(&left.updated_at))
            .then_with(|| left.key.cmp(&right.key))
    });
    TicketBoardProjection { boards }
}

fn board_for_group(
    key: String,
    mut tickets: Vec<TicketBoardTicket>,
    epics: &HashMap<&str, &Task>,
) -> TicketBoard {
    tickets.sort_by(|left, right| compare_tasks_for_board(&left.task, &right.task));
    let epic = (key != NO_EPIC_BOARD_KEY)
        .then(|| epics.get(key.as_str()).copied())
        .flatten();
    let priority = epic.map(|task| task.priority).unwrap_or_else(|| {
        tickets
            .iter()
            .map(|ticket| ticket.task.priority)
            .max()
            .unwrap_or_default()
    });
    let updated_at = epic.map(|task| task.updated_at).unwrap_or_else(|| {
        tickets
            .iter()
            .map(|ticket| ticket.task.updated_at)
            .max()
            .unwrap_or_default()
    });
    let title = if key == NO_EPIC_BOARD_KEY {
        NO_EPIC_BOARD_TITLE.to_string()
    } else {
        epic.map(|task| task.title.clone())
            .unwrap_or_else(|| format!("Unknown Epic: {key}"))
    };
    let done = tickets
        .iter()
        .filter(|ticket| is_done(&ticket.task))
        .count();
    let total = tickets.len();
    let lanes = TicketBoardLaneId::order()
        .into_iter()
        .filter_map(|lane_id| {
            let lane_tickets = tickets
                .iter()
                .filter(|ticket| ticket.lane == lane_id)
                .cloned()
                .collect::<Vec<_>>();
            (!lane_tickets.is_empty()).then(|| TicketBoardLane {
                id: lane_id,
                title: lane_id.title(),
                tickets: lane_tickets,
            })
        })
        .collect();
    TicketBoard {
        key: key.clone(),
        title,
        epic_label: (key != NO_EPIC_BOARD_KEY).then_some(key),
        priority,
        updated_at,
        done,
        total,
        lanes,
    }
}

fn task_children(tasks: &[Task]) -> HashMap<&str, Vec<&Task>> {
    let mut children: HashMap<&str, Vec<&Task>> = HashMap::new();
    for task in tasks {
        let Some(parent_id) = task.parent_id.as_deref() else {
            continue;
        };
        children.entry(parent_id).or_default().push(task);
    }
    children
}

fn blocked_reasons(
    task: &Task,
    by_id: &HashMap<&str, &Task>,
    children: &HashMap<&str, Vec<&Task>>,
) -> Vec<BlockedReason> {
    let mut reasons = Vec::new();
    for blocker_id in &task.blocked_by {
        match by_id.get(blocker_id.as_str()).copied() {
            Some(blocker) if is_canceled(blocker) => reasons.push(BlockedReason {
                kind: BlockedReasonKind::CanceledBlocker,
                task_id: blocker.id.clone(),
                title: Some(blocker.title.clone()),
            }),
            Some(blocker) if !is_done(blocker) => reasons.push(BlockedReason {
                kind: BlockedReasonKind::OpenBlocker,
                task_id: blocker.id.clone(),
                title: Some(blocker.title.clone()),
            }),
            Some(_) => {}
            None => reasons.push(BlockedReason {
                kind: BlockedReasonKind::MissingBlocker,
                task_id: blocker_id.clone(),
                title: None,
            }),
        }
    }
    if let Some(task_children) = children.get(task.id.as_str()) {
        reasons.extend(
            task_children
                .iter()
                .copied()
                .filter(|child| is_active(child))
                .map(|child| BlockedReason {
                    kind: BlockedReasonKind::ActiveChild,
                    task_id: child.id.clone(),
                    title: Some(child.title.clone()),
                }),
        );
    }
    reasons
}

fn ticket_lane(task: &Task, blocked_reasons: &[BlockedReason]) -> TicketBoardLaneId {
    if !blocked_reasons.is_empty() {
        return TicketBoardLaneId::Blocked;
    }
    match task.status.as_str() {
        "rejected" => TicketBoardLaneId::Rejected,
        "in_progress" => TicketBoardLaneId::InProgress,
        "in_review" => TicketBoardLaneId::InReview,
        status if status == "done" || status == "completed" => TicketBoardLaneId::Done,
        _ => TicketBoardLaneId::Ready,
    }
}

pub(crate) fn is_done(task: &Task) -> bool {
    task.status == "done" || task.status == "completed"
}

pub(crate) fn is_canceled(task: &Task) -> bool {
    task.status == "canceled"
}

pub(crate) fn is_active_status(status: &str) -> bool {
    !matches!(status, "done" | "completed" | "canceled")
}

fn is_active(task: &Task) -> bool {
    is_active_status(&task.status)
}

pub(crate) fn compare_tasks_for_board(left: &Task, right: &Task) -> std::cmp::Ordering {
    right
        .priority
        .cmp(&left.priority)
        .then_with(|| right.updated_at.cmp(&left.updated_at))
        .then_with(|| left.id.cmp(&right.id))
}

pub(crate) fn ticket_board_order(tasks: &[Task]) -> HashMap<String, usize> {
    project_ticket_board(tasks)
        .boards
        .into_iter()
        .flat_map(|board| board.lanes.into_iter())
        .flat_map(|lane| lane.tickets.into_iter())
        .enumerate()
        .map(|(index, ticket)| (ticket.task.id, index))
        .collect()
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

    #[test]
    fn projection_shows_no_epic_board_and_explains_blocked_tickets() {
        let epic = Task {
            epic_id: Some("test-epic".to_string()),
            title: "Test Epic".to_string(),
            ..task("EPIC", "placeholder", "open", "epic")
        };
        let active = task("ACTIVE", "Active blocker", "in_progress", "feature");
        let mut blocked_rejected = task("REJECT", "Rejected but blocked", "rejected", "bug");
        blocked_rejected.blocked_by = vec!["ACTIVE".to_string(), "MISSING".to_string()];
        let mut canceled_blocker = task("CANCEL", "Canceled blocker", "canceled", "chore");
        canceled_blocker.epic_id = Some("test-epic".to_string());
        let mut canceled_blocked = task("CANCELEDREF", "References canceled", "open", "chore");
        canceled_blocked.blocked_by = vec!["CANCEL".to_string()];
        let parent = task("PARENT", "Parent", "open", "feature");
        let mut child = task("CHILD", "Child", "open", "chore");
        child.parent_id = Some("PARENT".to_string());
        let mut no_epic = task("NOEPIC", "Legacy without epic", "open", "chore");
        no_epic.epic_id = None;

        let projection = project_ticket_board(&[
            epic,
            active,
            blocked_rejected,
            canceled_blocker,
            canceled_blocked,
            parent,
            child,
            no_epic,
        ]);

        let test_epic = projection
            .boards
            .iter()
            .find(|board| board.key == "test-epic")
            .expect("test epic board");
        let blocked_ids = test_epic
            .lanes
            .iter()
            .find(|lane| lane.id == TicketBoardLaneId::Blocked)
            .expect("blocked lane")
            .tickets
            .iter()
            .map(|ticket| ticket.task.id.as_str())
            .collect::<Vec<_>>();
        assert!(blocked_ids.contains(&"REJECT"));
        assert!(blocked_ids.contains(&"CANCELEDREF"));
        assert!(blocked_ids.contains(&"PARENT"));

        let rejected = test_epic
            .lanes
            .iter()
            .flat_map(|lane| &lane.tickets)
            .find(|ticket| ticket.task.id == "REJECT")
            .expect("rejected ticket");
        assert_eq!(rejected.lane, TicketBoardLaneId::Blocked);
        assert_eq!(rejected.blocked_reasons.len(), 2);
        assert!(
            rejected
                .blocked_reasons
                .iter()
                .any(|reason| reason.kind == BlockedReasonKind::OpenBlocker)
        );
        assert!(
            rejected
                .blocked_reasons
                .iter()
                .any(|reason| reason.kind == BlockedReasonKind::MissingBlocker)
        );

        let no_epic_board = projection
            .boards
            .iter()
            .find(|board| board.key == "no-epic")
            .expect("no epic board");
        assert_eq!(no_epic_board.title, "No Epic");
        assert_eq!(
            no_epic_board.lanes[0].tickets[0].task.title,
            "Legacy without epic"
        );
    }
}
