use clap::CommandFactory;
use clap_complete::{Shell, generate};

use super::Cli;
use crate::usage_bars::{RenderRequest, Window, render};

fn apply_patch_telemetry_for(cwd_path: &std::path::Path) -> Option<crate::apply_patch::Telemetry> {
    let telemetry_root = cwd_path
        .canonicalize()
        .unwrap_or_else(|_| cwd_path.to_path_buf());
    let project_name = vlt::artifact::project_name(&telemetry_root.to_string_lossy());
    crate::apply_patch::Telemetry::open(&project_name).ok()
}

pub fn run_completion(shell: Shell) -> Result<(), Box<dyn std::error::Error>> {
    generate(shell, &mut Cli::command(), "ct", &mut std::io::stdout());
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
            let tel = apply_patch_telemetry_for(&cwd_path);
            let artifacts = crate::apply_patch::repair::handle_failure(
                tel.as_ref(),
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
    if let Some(tel) = apply_patch_telemetry_for(&cwd_path)
        && let Err(e) = crate::apply_patch::repair::record_success(
            &tel,
            &outcome,
            start.elapsed().as_micros() as u64,
            &patch_sha,
            &patch,
        )
    {
        eprintln!("apply-patch telemetry: {e}");
    }
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

    let mut req: RenderRequest =
        serde_json::from_str(&buf).map_err(|e| format!("usage-bar: invalid JSON: {e}"))?;
    req.width = width;

    for line in render(&req) {
        println!("{line}");
    }
    Ok(())
}

pub fn run_usage_bars(
    width: usize,
    sidebar: bool,
    watch: bool,
    interval_ms: u64,
) -> Result<(), Box<dyn std::error::Error>> {
    if watch {
        let interval = std::time::Duration::from_millis(interval_ms.max(100));
        loop {
            for line in render_usage_bars_once(width, sidebar) {
                println!("{line}");
            }
            std::thread::sleep(interval);
        }
    }

    for line in render_usage_bars_once(width, sidebar) {
        println!("{line}");
    }
    Ok(())
}

fn render_usage_bars_once(width: usize, sidebar: bool) -> Vec<String> {
    let mut requests = Vec::new();
    if let Some(last) = load_codex_usage_samples().last().copied() {
        requests.push(RenderRequest {
            provider_label: "\u{e7cf}".to_string(),
            provider_color: Some("74c7ec".to_string()),
            windows: vec![
                Window {
                    label: "5h".to_string(),
                    used_percent: last.primary_percent,
                    window_secs: 5 * 3600,
                    reset_secs: last.primary_reset - now_secs(),
                },
                Window {
                    label: "7d".to_string(),
                    used_percent: last.secondary_percent,
                    window_secs: 7 * 24 * 3600,
                    reset_secs: last.secondary_reset - now_secs(),
                },
            ],
            width,
        });
    }

    let mut lines = Vec::new();
    for request in requests {
        if sidebar {
            lines.extend(render_sidebar_usage_request(&request, width));
        } else {
            lines.extend(render(&request));
        }
    }
    lines
}

#[derive(Clone, Copy)]
struct CodexUsageSample {
    primary_percent: f64,
    primary_reset: i64,
    secondary_percent: f64,
    secondary_reset: i64,
}

fn load_codex_usage_samples() -> Vec<CodexUsageSample> {
    let path = std::env::temp_dir().join("codex-usage-log.tsv");
    let data = std::fs::read_to_string(path).unwrap_or_default();
    let mut samples = Vec::new();
    for line in data.lines() {
        let mut fields = line.split('\t');
        let (
            Some(_ts),
            Some(primary_percent),
            Some(primary_reset),
            Some(secondary_percent),
            Some(secondary_reset),
        ) = (
            fields.next(),
            fields.next(),
            fields.next(),
            fields.next(),
            fields.next(),
        )
        else {
            continue;
        };
        let (Ok(primary_percent), Ok(primary_reset), Ok(secondary_percent), Ok(secondary_reset)) = (
            primary_percent.parse::<f64>(),
            primary_reset.parse::<i64>(),
            secondary_percent.parse::<f64>(),
            secondary_reset.parse::<i64>(),
        ) else {
            continue;
        };
        samples.push(CodexUsageSample {
            primary_percent,
            primary_reset,
            secondary_percent,
            secondary_reset,
        });
    }
    samples
}

fn render_sidebar_usage_request(request: &RenderRequest, width: usize) -> Vec<String> {
    let mut lines = Vec::new();
    for window in &request.windows {
        if window.reset_secs <= 0 {
            continue;
        }
        let remaining = (100.0 - window.used_percent).clamp(0.0, 100.0).round() as i64;
        let reset = format_reset(window.reset_secs);
        let label = format!("{} {}", request.provider_label, window.label);
        lines.push(format!(
            " {label}  {remaining}%{}↺{reset} ",
            " ".repeat(width.saturating_sub(label.chars().count() + 12))
        ));
        lines.push(format!(" {} ", "░".repeat(width.saturating_sub(2))));
    }
    lines
}

fn now_secs() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn format_reset(secs: i64) -> String {
    let secs = secs.max(0);
    if secs >= 86400 {
        format!(
            "{}d{:02}:{:02}",
            secs / 86400,
            (secs % 86400) / 3600,
            (secs % 3600) / 60
        )
    } else if secs >= 3600 {
        format!("{}h{:02}", secs / 3600, (secs % 3600) / 60)
    } else {
        format!("{}m", secs / 60)
    }
}
