use crate::cli::args::{ApplyPatchAction, ApplyPatchArgs};

pub fn run_apply_patch(args: ApplyPatchArgs) -> Result<(), Box<dyn std::error::Error>> {
    match args.action {
        Some(ApplyPatchAction::Stats { all_projects, days }) => {
            super::tool::run_apply_patch_stats(all_projects, days)
        }
        Some(ApplyPatchAction::Report {
            diagnostic_id,
            limit,
            json,
        }) => super::tool::run_apply_patch_report(diagnostic_id, limit, json),
        Some(ApplyPatchAction::Show {
            diagnostic_id,
            json,
        }) => super::tool::run_apply_patch_show(diagnostic_id, json),
        Some(ApplyPatchAction::Prune { days }) => super::tool::run_apply_patch_prune(days),
        Some(ApplyPatchAction::Preview {
            cwd,
            partial,
            watch,
            jsonl,
        }) => super::tool::run_apply_patch_preview(cwd, partial, watch, jsonl),
        Some(ApplyPatchAction::Draft { action }) => super::patch::run_draft(action),
        None => super::tool::run_apply_patch_raw(args.cwd, args.dry_run),
    }
}
