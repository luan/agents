use std::io::Read;
use std::io::Write;

use super::path_uri::PathUri;
use serde_json::json;
use similar::TextDiff;

use super::AppliedPatchDelta;
use super::AppliedPatchFileChange;

pub fn main() -> ! {
    let exit_code = run_main();
    std::process::exit(exit_code);
}

/// We would prefer to return `std::process::ExitCode`, but its `exit_process()`
/// method is still a nightly API and we want main() to return !.
pub fn run_main() -> i32 {
    // Expect either one argument (the full apply_patch payload) or read it from stdin.
    let mut args = std::env::args_os();
    let _argv0 = args.next();

    let patch_arg = match args.next() {
        Some(arg) => match arg.into_string() {
            Ok(s) => s,
            Err(_) => {
                eprintln!("Error: apply_patch requires a UTF-8 PATCH argument.");
                return 1;
            }
        },
        None => {
            // No argument provided; attempt to read the patch from stdin.
            let mut buf = String::new();
            match std::io::stdin().read_to_string(&mut buf) {
                Ok(_) => {
                    if buf.is_empty() {
                        eprintln!("Usage: apply_patch 'PATCH'\n       echo 'PATCH' | apply_patch");
                        return 2;
                    }
                    buf
                }
                Err(err) => {
                    eprintln!("Error: Failed to read PATCH from stdin.\n{err}");
                    return 1;
                }
            }
        }
    };

    // Refuse extra args to avoid ambiguity.
    if args.next().is_some() {
        eprintln!("Error: apply_patch accepts exactly one argument.");
        return 2;
    }

    let mut stdout = std::io::stdout();
    let mut stderr = std::io::stderr();
    let native_cwd = match super::absolute_path::AbsolutePathBuf::current_dir() {
        Ok(cwd) => cwd,
        Err(err) => {
            eprintln!("Error: Failed to determine current directory.\n{err}");
            return 1;
        }
    };
    let cwd = PathUri::from_abs_path(&native_cwd);
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(err) => {
            eprintln!("Error: Failed to initialize runtime.\n{err}");
            return 1;
        }
    };
    let json_output = std::env::var_os("PI_APPLY_PATCH_JSON").is_some();
    match runtime.block_on(super::apply_patch(
        &patch_arg,
        &cwd,
        &mut stdout,
        &mut stderr,
        super::fs::LOCAL_FS.as_ref(),
        /*sandbox*/ None,
    )) {
        Ok(delta) => {
            if json_output {
                let _ = write_json_result(&mut stdout, "success", None, &cwd, &delta);
            }
            // Flush to ensure output ordering when used in pipelines.
            let _ = stdout.flush();
            0
        }
        Err(error) => {
            if json_output {
                let message = error.to_string();
                let (_, delta) = error.into_parts();
                let _ = write_json_result(&mut stdout, "failure", Some(&message), &cwd, &delta);
                let _ = stdout.flush();
            }
            1
        }
    }
}

fn write_json_result(
    out: &mut impl Write,
    status: &str,
    error: Option<&str>,
    cwd: &PathUri,
    delta: &AppliedPatchDelta,
) -> std::io::Result<()> {
    let summary = summarize_delta(cwd, delta);
    let value = json!({
        "status": status,
        "error": error,
        "exact": delta.is_exact(),
        "result": {
            "changedFiles": summary.changed_files,
            "createdFiles": summary.created_files,
            "deletedFiles": summary.deleted_files,
            "movedFiles": summary.moved_files,
            "fuzz": if delta.is_exact() { 0 } else { 1 },
            "diff": summary.unified_diffs.join("\n"),
        },
    });
    writeln!(out, "{value}")
}

struct DeltaSummary {
    changed_files: Vec<String>,
    created_files: Vec<String>,
    deleted_files: Vec<String>,
    moved_files: Vec<String>,
    unified_diffs: Vec<String>,
}

fn summarize_delta(cwd: &PathUri, delta: &AppliedPatchDelta) -> DeltaSummary {
    let mut changed_files = Vec::new();
    let mut created_files = Vec::new();
    let mut deleted_files = Vec::new();
    let mut moved_files = Vec::new();
    let mut unified_diffs = Vec::new();

    for change in delta.changes() {
        let path = display_path(cwd, &change.path);
        match &change.change {
            AppliedPatchFileChange::Add {
                content,
                overwritten_content,
            } => {
                push_unique(&mut changed_files, path.clone());
                if overwritten_content.is_none() {
                    push_unique(&mut created_files, path.clone());
                }
                unified_diffs.push(unified_diff(
                    overwritten_content.as_deref().unwrap_or_default(),
                    content,
                    overwritten_content
                        .as_ref()
                        .map(|_| format!("a/{path}"))
                        .unwrap_or_else(|| "/dev/null".to_string()),
                    format!("b/{path}"),
                ));
            }
            AppliedPatchFileChange::Delete { content } => {
                push_unique(&mut changed_files, path.clone());
                push_unique(&mut deleted_files, path.clone());
                unified_diffs.push(unified_diff(
                    content,
                    "",
                    format!("a/{path}"),
                    "/dev/null".to_string(),
                ));
            }
            AppliedPatchFileChange::Update {
                move_path,
                old_content,
                overwritten_move_content,
                new_content,
            } => {
                push_unique(&mut changed_files, path.clone());
                let move_path_display = move_path
                    .as_ref()
                    .map(|move_path| display_path(cwd, move_path));
                if let Some(move_path) = &move_path_display {
                    push_unique(&mut changed_files, move_path.clone());
                    push_unique(&mut deleted_files, path.clone());
                    if overwritten_move_content.is_none() {
                        push_unique(&mut created_files, move_path.clone());
                    }
                    push_unique(&mut moved_files, format!("{path} -> {move_path}"));
                }
                let new_path = move_path_display
                    .as_deref()
                    .unwrap_or(path.as_str())
                    .to_string();
                unified_diffs.push(unified_diff(
                    old_content,
                    new_content,
                    format!("a/{path}"),
                    format!("b/{new_path}"),
                ));
            }
        }
    }

    DeltaSummary {
        changed_files,
        created_files,
        deleted_files,
        moved_files,
        unified_diffs,
    }
}

fn unified_diff(
    old_content: &str,
    new_content: &str,
    old_path: String,
    new_path: String,
) -> String {
    let diff = TextDiff::from_lines(old_content, new_content)
        .unified_diff()
        .context_radius(1)
        .header(&old_path, &new_path)
        .to_string();
    if diff.is_empty() {
        format!("--- {old_path}\n+++ {new_path}\n")
    } else {
        diff
    }
}

pub fn display_path(cwd: &PathUri, path: &PathUri) -> String {
    path.relative_path_from(cwd)
        .unwrap_or_else(|| path.inferred_native_path_string())
}

fn push_unique(values: &mut Vec<String>, value: String) {
    if !values.contains(&value) {
        values.push(value);
    }
}
