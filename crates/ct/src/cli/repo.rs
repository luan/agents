use crate::cli::args::RepoAction;

pub fn run_repo(action: RepoAction) -> Result<(), Box<dyn std::error::Error>> {
    match action {
        RepoAction::Project => {
            crate::vault::cmd_project();
            Ok(())
        }
        RepoAction::Context {
            base,
            format,
            max_total,
            max_file,
            stat,
            cochanges,
        } => crate::gitcontext::run(base, format, max_total, max_file, stat, cochanges),
        RepoAction::CheckRefs { file, project_root } => crate::refs::run(file, project_root),
        RepoAction::Cochanges {
            base,
            threshold,
            min_commits,
            max_files,
            num_commits,
        } => super::tool::run_cochanges(base, threshold, min_commits, max_files, num_commits),
        RepoAction::Churn {
            project_root,
            since,
            min_loc,
        } => crate::churn::run(project_root, since, min_loc),
    }
}
