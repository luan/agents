use crate::cli::args::TuiAction;

pub fn run_tui(action: TuiAction) -> Result<(), Box<dyn std::error::Error>> {
    match action {
        TuiAction::UsageBar { width } => super::tool::run_usage_bar(width),
        TuiAction::UsageBars {
            width,
            sidebar,
            watch,
            interval_ms,
        } => super::tool::run_usage_bars(width, sidebar, watch, interval_ms),
    }
}
