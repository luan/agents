use crate::cli::args::ApplyPatchArgs;

pub fn run_apply_patch(args: ApplyPatchArgs) -> Result<(), Box<dyn std::error::Error>> {
    super::tool::run_apply_patch_raw(args.cwd, args.dry_run)
}
