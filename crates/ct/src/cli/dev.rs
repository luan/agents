use crate::cli::args::{DevAction, DevDebugAction};

pub fn run_dev(action: DevAction) -> Result<(), Box<dyn std::error::Error>> {
    match action {
        DevAction::Slug { words } => super::tool::run_slug(words),
        DevAction::Phases { file } => crate::phases::run_phases(file),
        DevAction::Debug { action } => run_debug(action),
    }
}

fn run_debug(action: DevDebugAction) -> Result<(), Box<dyn std::error::Error>> {
    match action {
        DevDebugAction::Sym(args) => sym::run(args).map_err(|e| e.into()),
        DevDebugAction::Ast { action } => super::ast::run_ast(action),
        DevDebugAction::Lsp { action } => super::lsp::run_lsp(action),
    }
}
