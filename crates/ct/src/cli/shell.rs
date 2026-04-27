use crate::cli::args::ShellAction;

pub fn run_shell(action: ShellAction) -> Result<(), Box<dyn std::error::Error>> {
    match action {
        ShellAction::Completion { shell } => super::tool::run_completion(shell),
    }
}
