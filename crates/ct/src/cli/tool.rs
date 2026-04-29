use clap::CommandFactory;
use clap_complete::{Shell, generate};

use super::Cli;

pub fn run_slug(words: Vec<String>) -> Result<(), Box<dyn std::error::Error>> {
    if words.is_empty() {
        return Ok(());
    }
    let input = words.join(" ");
    let result = crate::slug::slug(&input);
    if !result.is_empty() {
        println!("{result}");
    }
    Ok(())
}

pub fn run_completion(shell: Shell) -> Result<(), Box<dyn std::error::Error>> {
    generate(shell, &mut Cli::command(), "ct", &mut std::io::stdout());
    Ok(())
}

pub fn run_cochanges(
    base: String,
    threshold: f64,
    min_commits: usize,
    max_files_str: String,
    num_commits: usize,
) -> Result<(), Box<dyn std::error::Error>> {
    let max_files = if max_files_str.to_lowercase() == "all" {
        None
    } else {
        let n: usize = max_files_str
            .parse()
            .map_err(|_| format!("invalid max-files: {max_files_str}"))?;
        if n == 0 {
            return Err("max-files must be positive or 'all'".into());
        }
        Some(n)
    };
    crate::cochanges::run(base, threshold, min_commits, max_files, num_commits)
}

pub fn run_apply_patch_stats(
    all_projects: bool,
    days: i64,
) -> Result<(), Box<dyn std::error::Error>> {
    use crate::apply_patch::telemetry::{Telemetry, stats};

    if all_projects {
        let report = stats::run_all_projects(days)?;
        println!("{report}");
        return Ok(());
    }

    let project_name = crate::artifact::project_name(&crate::artifact::current_project());
    let base = match dirs::data_local_dir() {
        Some(b) => b,
        None => {
            eprintln!("apply-patch stats: no data_local_dir available");
            std::process::exit(1);
        }
    };
    let db_path = base
        .join("ct")
        .join("projects")
        .join(&project_name)
        .join("apply_patch.db");
    if !db_path.is_file() {
        println!("(no telemetry data — database not found for project: {project_name})");
        return Ok(());
    }
    let tel = Telemetry::open(&project_name)?;
    let report = stats::run(&tel, &project_name, days)?;
    println!("{report}");
    Ok(())
}

pub fn run_apply_patch_report(
    diagnostic_id: Option<String>,
    limit: usize,
    json: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    use crate::apply_patch::telemetry::{Telemetry, diagnostics};

    let project_name = crate::artifact::project_name(&crate::artifact::current_project());
    let tel = Telemetry::open(&project_name)?;
    if let Some(diagnostic_id) = diagnostic_id {
        let Some(diagnostic) = tel.failure_diagnostic(&diagnostic_id)? else {
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "diagnostic_id": diagnostic_id,
                        "status": "not_found"
                    }))?
                );
            } else {
                println!("apply-patch diagnostic not found: {diagnostic_id}");
            }
            return Ok(());
        };
        if json {
            println!("{}", serde_json::to_string_pretty(&diagnostic)?);
        } else {
            print!("{}", diagnostics::render_diagnostic(&diagnostic));
        }
        return Ok(());
    }
    let report = tel.failure_report(limit)?;
    if json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        print!("{}", diagnostics::render_report(&report));
    }
    Ok(())
}

pub fn run_apply_patch_show(
    diagnostic_id: String,
    json: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    run_apply_patch_report(Some(diagnostic_id), 1, json)
}

pub fn run_apply_patch_prune(days: i64) -> Result<(), Box<dyn std::error::Error>> {
    use crate::apply_patch::telemetry::{Telemetry, prune};

    let project_name = crate::artifact::project_name(&crate::artifact::current_project());
    let base = match dirs::data_local_dir() {
        Some(b) => b,
        None => {
            eprintln!("apply-patch prune: no data_local_dir available");
            std::process::exit(1);
        }
    };
    let db_path = base
        .join("ct")
        .join("projects")
        .join(&project_name)
        .join("apply_patch.db");
    if !db_path.is_file() {
        println!("(no telemetry data — database not found for project: {project_name})");
        return Ok(());
    }
    let tel = Telemetry::open(&project_name)?;
    let report = prune::run(&tel, days)?;
    println!(
        "pruned: {} calls, {} anchor attempts, {} patch bodies",
        report.calls_deleted, report.anchor_attempts_deleted, report.patch_bodies_deleted
    );
    Ok(())
}

pub fn run_apply_patch_preview(
    cwd: Option<String>,
    partial: bool,
    watch: bool,
    jsonl: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    use std::io::BufRead;
    use std::io::IsTerminal;
    use std::io::Read;
    use std::path::PathBuf;

    let cwd_path = match cwd {
        Some(s) => PathBuf::from(s),
        None => std::env::current_dir()?,
    };
    if !cwd_path.is_dir() {
        println!(
            "{}",
            serde_json::to_string(&crate::apply_patch::preview::PreviewResponse {
                status: "invalid",
                complete: false,
                diff: String::new(),
                changes: Vec::new(),
                error: Some(format!("cwd is not a directory: {}", cwd_path.display())),
            })?
        );
        return Ok(());
    }

    if watch {
        if !jsonl {
            println!(
                "{}",
                serde_json::to_string(&crate::apply_patch::preview::PreviewResponse {
                    status: "invalid",
                    complete: false,
                    diff: String::new(),
                    changes: Vec::new(),
                    error: Some("--watch requires --jsonl".to_string()),
                })?
            );
            return Ok(());
        }
        #[derive(serde::Deserialize)]
        struct PreviewRequest {
            input: Option<String>,
            patch: Option<String>,
            stop: Option<bool>,
        }

        let stdin = std::io::stdin();
        let mut stdout = std::io::stdout();
        for line in stdin.lock().lines() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            let request = match serde_json::from_str::<PreviewRequest>(&line) {
                Ok(request) => request,
                Err(error) => {
                    serde_json::to_writer(
                        &mut stdout,
                        &crate::apply_patch::preview::PreviewResponse {
                            status: "invalid",
                            complete: false,
                            diff: String::new(),
                            changes: Vec::new(),
                            error: Some(format!("invalid preview request JSON: {error}")),
                        },
                    )?;
                    use std::io::Write;
                    stdout.write_all(b"\n")?;
                    stdout.flush()?;
                    continue;
                }
            };
            if request.stop.unwrap_or(false) {
                break;
            }
            let Some(patch) = request.input.or(request.patch) else {
                serde_json::to_writer(
                    &mut stdout,
                    &crate::apply_patch::preview::PreviewResponse {
                        status: "empty",
                        complete: false,
                        diff: String::new(),
                        changes: Vec::new(),
                        error: Some("preview request missing input".to_string()),
                    },
                )?;
                use std::io::Write;
                stdout.write_all(b"\n")?;
                stdout.flush()?;
                continue;
            };
            let response = if patch.len() > crate::apply_patch::MAX_PATCH_SIZE_BYTES {
                crate::apply_patch::preview::PreviewResponse {
                    status: "invalid",
                    complete: false,
                    diff: String::new(),
                    changes: Vec::new(),
                    error: Some(format!(
                        "patch exceeds {} byte limit",
                        crate::apply_patch::MAX_PATCH_SIZE_BYTES
                    )),
                }
            } else {
                crate::apply_patch::preview::preview(&patch, &cwd_path, partial)
            };
            serde_json::to_writer(&mut stdout, &response)?;
            use std::io::Write;
            stdout.write_all(b"\n")?;
            stdout.flush()?;
        }
        return Ok(());
    }

    if std::io::stdin().is_terminal() {
        println!(
            "{}",
            serde_json::to_string(&crate::apply_patch::preview::PreviewResponse {
                status: "empty",
                complete: false,
                diff: String::new(),
                changes: Vec::new(),
                error: Some("expected patch on stdin".to_string()),
            })?
        );
        return Ok(());
    }

    let limit = crate::apply_patch::MAX_PATCH_SIZE_BYTES as u64 + 1;
    let mut patch = String::new();
    std::io::stdin()
        .lock()
        .take(limit)
        .read_to_string(&mut patch)?;
    if patch.len() > crate::apply_patch::MAX_PATCH_SIZE_BYTES {
        println!(
            "{}",
            serde_json::to_string(&crate::apply_patch::preview::PreviewResponse {
                status: "invalid",
                complete: false,
                diff: String::new(),
                changes: Vec::new(),
                error: Some(format!(
                    "patch exceeds {} byte limit",
                    crate::apply_patch::MAX_PATCH_SIZE_BYTES
                )),
            })?
        );
        return Ok(());
    }

    let response = crate::apply_patch::preview::preview(&patch, &cwd_path, partial);
    println!("{}", serde_json::to_string(&response)?);
    Ok(())
}

pub fn run_apply_patch_raw(
    cwd: Option<String>,
    dry_run: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    use std::io::IsTerminal;
    use std::io::Read;
    use std::path::PathBuf;

    let cwd_path = match cwd {
        Some(s) => PathBuf::from(s),
        None => std::env::current_dir()?,
    };
    if !cwd_path.is_dir() {
        eprintln!(
            "apply-patch: cwd is not a directory: {}",
            cwd_path.display()
        );
        std::process::exit(1);
    }

    if std::io::stdin().is_terminal() {
        eprintln!("apply-patch: expected patch on stdin");
        std::process::exit(1);
    }
    let limit = crate::apply_patch::MAX_PATCH_SIZE_BYTES as u64 + 1;
    let mut patch = String::new();
    std::io::stdin()
        .lock()
        .take(limit)
        .read_to_string(&mut patch)?;
    if patch.len() > crate::apply_patch::MAX_PATCH_SIZE_BYTES {
        eprintln!(
            "apply-patch: patch exceeds {} byte limit",
            crate::apply_patch::MAX_PATCH_SIZE_BYTES
        );
        std::process::exit(1);
    }

    let patch_sha = crate::apply_patch::sha1_hex(patch.as_bytes());
    let start = std::time::Instant::now();
    let outcome = match crate::apply_patch::apply(&patch, &cwd_path, dry_run) {
        Ok(o) => o,
        Err(failure) => {
            let telemetry_root = cwd_path.canonicalize().unwrap_or_else(|_| cwd_path.clone());
            let project_name = crate::artifact::project_name(&telemetry_root.to_string_lossy());
            let tel = crate::apply_patch::Telemetry::open(&project_name).ok();
            let artifacts = crate::apply_patch::repair::handle_failure(
                tel.as_ref(),
                &cwd_path,
                &failure,
                start.elapsed().as_micros() as u64,
                &patch_sha,
                &patch,
            );
            eprintln!("{}", failure.error);
            eprintln!("{}", artifacts.repair_block.render_compact());
            std::process::exit(1);
        }
    };
    let changes = outcome.changes;

    if dry_run {
        let mut first = true;
        for change in &changes {
            if !first {
                println!();
            }
            first = false;
            print!("{}", change.unified_diff);
        }
    } else {
        let mut store = crate::lens::LensStore::open_for_project(&cwd_path)?;
        store.record_applied_changes(None, "ct_apply_patch", &changes)?;
        for change in &changes {
            match change.kind {
                crate::apply_patch::ChangeType::Add => println!("A {}", change.path),
                crate::apply_patch::ChangeType::Update => println!("M {}", change.path),
                crate::apply_patch::ChangeType::Delete => println!("D {}", change.path),
                crate::apply_patch::ChangeType::Move => {
                    let dest = change.move_path.as_deref().unwrap_or("");
                    println!("R {} \u{2192} {}", change.path, dest);
                }
            }
        }
    }
    Ok(())
}

pub fn run_usage_bar(width: usize) -> Result<(), Box<dyn std::error::Error>> {
    use std::io::IsTerminal;
    use std::io::Read;

    if std::io::stdin().is_terminal() {
        eprintln!("usage-bar: expected JSON request on stdin");
        std::process::exit(1);
    }

    let mut buf = String::new();
    std::io::stdin().lock().read_to_string(&mut buf)?;

    let mut req: usage_bars::RenderRequest =
        serde_json::from_str(&buf).map_err(|e| format!("usage-bar: invalid JSON: {e}"))?;
    req.width = width;

    for line in usage_bars::render(&req) {
        println!("{line}");
    }
    Ok(())
}
