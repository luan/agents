use clap::CommandFactory;
use clap_complete::{Shell, generate};

use super::Cli;

fn apply_patch_telemetry_for(cwd_path: &std::path::Path) -> Option<crate::apply_patch::Telemetry> {
    let telemetry_root = cwd_path
        .canonicalize()
        .unwrap_or_else(|_| cwd_path.to_path_buf());
    let project_name = vlt::artifact::project_name(&telemetry_root.to_string_lossy());
    crate::apply_patch::Telemetry::open(&project_name).ok()
}

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

    let project_name = vlt::artifact::project_name(&vlt::artifact::current_project());
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

    let project_name = vlt::artifact::project_name(&vlt::artifact::current_project());
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

    let project_name = vlt::artifact::project_name(&vlt::artifact::current_project());
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
            let tel = apply_patch_telemetry_for(&cwd_path);
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

    let mut req: usage_bars::RenderRequest =
        serde_json::from_str(&buf).map_err(|e| format!("usage-bar: invalid JSON: {e}"))?;
    req.width = width;

    for line in usage_bars::render(&req) {
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
        return watch_usage_bars(width, sidebar, interval_ms);
    }
    for line in render_usage_bars_once(width, sidebar)? {
        println!("{line}");
    }
    Ok(())
}

fn watch_usage_bars(
    width: usize,
    sidebar: bool,
    interval_ms: u64,
) -> Result<(), Box<dyn std::error::Error>> {
    use std::io::Write;

    let interval = std::time::Duration::from_millis(interval_ms.max(100));
    let mut stdout = std::io::stdout();
    loop {
        let lines = render_usage_bars_once(width, sidebar)
            .unwrap_or_else(|err| vec![format!("usage-bars: {err}")]);
        write!(stdout, "\x1b[H\x1b[2J")?;
        for line in lines {
            writeln!(stdout, "{line}")?;
        }
        stdout.flush()?;
        std::thread::sleep(interval);
    }
}

fn render_usage_bars_once(
    width: usize,
    sidebar: bool,
) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    let providers = configured_usage_providers()?;
    poll_usage_sources(&providers);
    let requests = collect_usage_bar_requests(width, &providers);
    if sidebar {
        return Ok(render_sidebar_usage_bars(&requests, width));
    }
    let mut lines = Vec::new();
    for (i, req) in requests.iter().enumerate() {
        if i > 0 {
            lines.push(String::new());
        }
        lines.extend(usage_bars::render(req));
    }
    Ok(lines)
}

fn poll_usage_sources(providers: &[UsageProvider]) {
    if providers.contains(&UsageProvider::Codex)
        && should_poll(&codex_log(), std::time::Duration::from_secs(120))
    {
        let _ = poll_codex_usage();
    }
}

fn should_poll(path: &std::path::Path, interval: std::time::Duration) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return true;
    };
    let Ok(modified) = meta.modified() else {
        return true;
    };
    modified.elapsed().map_or(true, |age| age >= interval)
}

const FIVE_HOURS: i64 = 5 * 3600;
const SEVEN_DAYS: i64 = 7 * 24 * 3600;

const CLAUDE_GLYPH: &str = "\u{e861}";
const CODEX_GLYPH: &str = "\u{e7cf}";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum UsageProvider {
    Claude,
    Codex,
}

impl UsageProvider {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "claude" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            _ => None,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }
}

#[derive(serde::Deserialize)]
struct CtConfig {
    #[serde(alias = "usage-bars")]
    usage_bars: Option<UsageBarsConfig>,
}

#[derive(serde::Deserialize)]
struct UsageBarsConfig {
    providers: Option<Vec<String>>,
}

fn configured_usage_providers() -> Result<Vec<UsageProvider>, Box<dyn std::error::Error>> {
    let path = ct_config_path();
    if !path.is_file() {
        return Ok(default_usage_providers());
    }
    let contents = std::fs::read_to_string(&path)?;
    parse_usage_providers_config(&contents).map_err(|e| format!("{}: {e}", path.display()).into())
}

fn default_usage_providers() -> Vec<UsageProvider> {
    vec![UsageProvider::Claude, UsageProvider::Codex]
}

fn ct_config_path() -> std::path::PathBuf {
    std::env::var_os("XDG_CONFIG_HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| home().join(".config"))
        .join("ct/config.toml")
}

fn parse_usage_providers_config(
    contents: &str,
) -> Result<Vec<UsageProvider>, Box<dyn std::error::Error>> {
    let config: CtConfig = toml::from_str(contents)?;
    let Some(usage_bars) = config.usage_bars else {
        return Ok(default_usage_providers());
    };
    let Some(provider_names) = usage_bars.providers else {
        return Ok(default_usage_providers());
    };

    let mut providers = Vec::new();
    for provider_name in provider_names {
        if provider_name == "copilot" {
            continue;
        }
        let Some(provider) = UsageProvider::parse(&provider_name) else {
            let valid = default_usage_providers()
                .iter()
                .map(|provider| provider.name())
                .collect::<Vec<_>>()
                .join(", ");
            return Err(format!(
                "unknown usage_bars provider `{provider_name}`; expected one of: {valid}"
            )
            .into());
        };
        if providers.contains(&provider) {
            return Err(format!("duplicate usage_bars provider `{provider_name}`").into());
        }
        providers.push(provider);
    }
    Ok(providers)
}

#[derive(Clone, Copy)]
struct DualSample {
    ts: i64,
    p_pct: f64,
    p_reset: i64,
    s_pct: f64,
    s_reset: i64,
}

fn collect_usage_bar_requests(
    width: usize,
    providers: &[UsageProvider],
) -> Vec<usage_bars::RenderRequest> {
    let mut out = Vec::new();

    for provider in providers {
        match provider {
            UsageProvider::Claude => {
                let claude_samples = load_dual_sqlite(&claude_usage_db());
                if !claude_samples.is_empty() {
                    out.push(usage_bars::RenderRequest {
                        provider_label: CLAUDE_GLYPH.to_string(),
                        provider_color: Some("d87b4a".to_string()),
                        windows: dual_peak_windows(&claude_samples),
                        width,
                    });
                }
            }
            UsageProvider::Codex => {
                let codex_samples = load_dual_tsv(&codex_log());
                if let Some(last) = codex_samples.last() {
                    out.push(usage_bars::RenderRequest {
                        provider_label: CODEX_GLYPH.to_string(),
                        provider_color: Some("74c7ec".to_string()),
                        windows: vec![
                            usage_bars::Window {
                                label: "5h".to_string(),
                                used_percent: last.p_pct,
                                window_secs: FIVE_HOURS,
                                reset_secs: last.p_reset - now_ts(),
                            },
                            usage_bars::Window {
                                label: "7d".to_string(),
                                used_percent: last.s_pct,
                                window_secs: SEVEN_DAYS,
                                reset_secs: last.s_reset - now_ts(),
                            },
                        ],
                        width,
                    });
                }
            }
        }
    }

    out
}

fn home() -> std::path::PathBuf {
    dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."))
}

fn claude_usage_db() -> std::path::PathBuf {
    home().join(".local/state/claude-statusline/usage.db")
}

fn codex_log() -> std::path::PathBuf {
    std::env::temp_dir().join("codex-usage-log.tsv")
}

fn now_ts() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn dual_peak_windows(samples: &[DualSample]) -> Vec<usage_bars::Window> {
    let now = now_ts();
    let p_reset = samples.iter().map(|s| s.p_reset).max().unwrap_or(0);
    let s_reset = samples.iter().map(|s| s.s_reset).max().unwrap_or(0);
    let p_pct = samples
        .iter()
        .filter(|s| s.p_reset == p_reset && s.ts >= p_reset - FIVE_HOURS)
        .map(|s| s.p_pct)
        .fold(0.0_f64, f64::max);
    let s_pct = samples
        .iter()
        .filter(|s| s.s_reset == s_reset && s.ts >= s_reset - SEVEN_DAYS)
        .map(|s| s.s_pct)
        .fold(0.0_f64, f64::max);
    vec![
        usage_bars::Window {
            label: "5h".to_string(),
            used_percent: p_pct,
            window_secs: FIVE_HOURS,
            reset_secs: p_reset - now,
        },
        usage_bars::Window {
            label: "7d".to_string(),
            used_percent: s_pct,
            window_secs: SEVEN_DAYS,
            reset_secs: s_reset - now,
        },
    ]
}

fn load_dual_sqlite(path: &std::path::Path) -> Vec<DualSample> {
    use rusqlite::{Connection, OpenFlags};

    if !path.exists() {
        return Vec::new();
    }
    let Ok(conn) = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else {
        return Vec::new();
    };
    let Ok(mut stmt) = conn.prepare(
        "SELECT ts, fh_used, fh_reset, sd_used, sd_reset FROM usage_samples ORDER BY ts ASC",
    ) else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, i64>(4)?,
        ))
    }) else {
        return Vec::new();
    };

    const SANE_MAX_TS: i64 = 4_102_444_800;
    rows.flatten()
        .filter_map(|(ts, fh_used, fh_reset, sd_used, sd_reset)| {
            ((0..SANE_MAX_TS).contains(&fh_reset) && (0..SANE_MAX_TS).contains(&sd_reset))
                .then_some(DualSample {
                    ts,
                    p_pct: fh_used as f64,
                    p_reset: fh_reset,
                    s_pct: sd_used as f64,
                    s_reset: sd_reset,
                })
        })
        .collect()
}

fn load_dual_tsv(path: &std::path::Path) -> Vec<DualSample> {
    let data = std::fs::read_to_string(path).unwrap_or_default();
    let mut out = Vec::new();
    for line in data.lines() {
        let mut it = line.split('\t');
        let (Some(t), Some(pp), Some(pr), Some(sp), Some(sr)) =
            (it.next(), it.next(), it.next(), it.next(), it.next())
        else {
            continue;
        };
        let (Ok(ts), Ok(p_pct), Ok(p_reset), Ok(s_pct), Ok(s_reset)) = (
            t.parse::<i64>(),
            pp.parse::<f64>(),
            pr.parse::<i64>(),
            sp.parse::<f64>(),
            sr.parse::<i64>(),
        ) else {
            continue;
        };
        const SANE_MAX_TS: i64 = 4_102_444_800;
        if !(0..SANE_MAX_TS).contains(&p_reset) || !(0..SANE_MAX_TS).contains(&s_reset) {
            continue;
        }
        out.push(DualSample {
            ts,
            p_pct,
            p_reset,
            s_pct,
            s_reset,
        });
    }
    out
}

fn poll_codex_usage() -> Option<()> {
    let token = codex_token()?;
    let body = fetch_usage("https://chatgpt.com/backend-api/wham/usage", &token, &[])?;
    let json: serde_json::Value = serde_json::from_str(&body).ok()?;
    let rate = json.get("rate_limit")?;
    let prim = rate.get("primary_window")?;
    let sec = rate.get("secondary_window")?;
    let prim_pct = prim.get("used_percent")?.as_f64()?;
    let prim_reset = prim.get("reset_at")?.as_i64()?;
    let sec_pct = sec.get("used_percent")?.as_f64()?;
    let sec_reset = sec.get("reset_at")?.as_i64()?;
    append_snapshot(
        &codex_log(),
        &format!(
            "{}\t{}\t{}\t{}\t{}\n",
            now_ts(),
            prim_pct,
            prim_reset,
            sec_pct,
            sec_reset,
        ),
    )
}

fn codex_token() -> Option<String> {
    let raw = std::fs::read_to_string(home().join(".codex/auth.json")).ok()?;
    let json: serde_json::Value = serde_json::from_str(&raw).ok()?;
    json.get("tokens")?
        .get("access_token")?
        .as_str()
        .map(String::from)
}

fn fetch_usage(endpoint: &str, token: &str, extra_headers: &[String]) -> Option<String> {
    let mut args = vec![
        "-sS".to_string(),
        "--max-time".to_string(),
        "10".to_string(),
        "-H".to_string(),
        format!("Authorization: Bearer {token}"),
    ];
    for h in extra_headers {
        args.push("-H".to_string());
        args.push(h.clone());
    }
    args.push(endpoint.to_string());
    let out = std::process::Command::new("curl")
        .args(args)
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8(out.stdout).ok()
}

fn append_snapshot(path: &std::path::Path, line: &str) -> Option<()> {
    let existing = std::fs::read_to_string(path).unwrap_or_default();
    std::fs::write(path, format!("{existing}{line}")).ok()
}

type Rgb = (u8, u8, u8);

const RGB_DIM: Rgb = (0x6c, 0x70, 0x86);
const RGB_GREEN: Rgb = (0xa6, 0xe3, 0xa1);
const RGB_ORANGE: Rgb = (0xfa, 0xb3, 0x87);
const RGB_RED: Rgb = (0xef, 0x44, 0x44);
const RGB_TRACK: Rgb = (0x3a, 0x3d, 0x4e);

fn render_sidebar_usage_bars(reqs: &[usage_bars::RenderRequest], width: usize) -> Vec<String> {
    let mut lines = Vec::new();
    for req in reqs {
        let provider = parse_hex_rgb(req.provider_color.as_deref()).unwrap_or((0xa0, 0xa8, 0xc0));
        for window in &req.windows {
            let remaining = window.reset_secs.max(0);
            if window.reset_secs <= 0 {
                continue;
            }
            let display = format!("{} {}", req.provider_label, window.label);
            lines.push(render_sidebar_stats(
                &display, provider, window, remaining, width,
            ));
            lines.push(render_sidebar_bar(provider, window, remaining, width));
        }
    }
    lines
}

fn render_sidebar_stats(
    display: &str,
    provider: Rgb,
    window: &usage_bars::Window,
    remaining: i64,
    width: usize,
) -> String {
    let remaining_pct = (100.0 - window.used_percent).clamp(0.0, 100.0);
    let pct_txt = format!("{}%", remaining_pct.round() as i64);
    let burn = quota_rgb(window.used_percent, remaining, window.window_secs, provider);
    let pace = pace_balance_secs_ct(window.used_percent, remaining, window.window_secs);
    let pace_txt = pace.map(fmt_pace_ct).unwrap_or_default();
    let reset_txt = if remaining > 0 {
        format!("↺{}", fmt_reset_ct(remaining))
    } else {
        String::new()
    };

    let left_plain = format!(" {display}  {pct_txt}");
    let right_plain = if pace_txt.is_empty() {
        format!("{reset_txt} ")
    } else {
        format!("{pace_txt} {reset_txt} ")
    };
    let pad = width.saturating_sub(plain_width(&left_plain) + plain_width(&right_plain));

    let mut out = String::new();
    out.push(' ');
    out.push_str(&fg(provider, display));
    out.push_str("  ");
    out.push_str(&fg(burn, &pct_txt));
    out.push_str(&" ".repeat(pad));
    if let Some(p) = pace {
        out.push_str(&fg(
            pace_rgb(p, window.window_secs, provider),
            &fmt_pace_ct(p),
        ));
        out.push(' ');
    }
    out.push_str(&fg(RGB_DIM, &reset_txt));
    out.push(' ');
    out
}

fn render_sidebar_bar(
    provider: Rgb,
    window: &usage_bars::Window,
    remaining: i64,
    width: usize,
) -> String {
    let inner = width.saturating_sub(2);
    let elapsed_pct = if window.window_secs > 0 {
        ((window.window_secs - remaining) as f64 / window.window_secs as f64) * 100.0
    } else {
        0.0
    };
    let remaining_pct = (100.0 - window.used_percent).clamp(0.0, 100.0);
    let remaining_cells = ((remaining_pct / 100.0) * inner as f64)
        .round()
        .clamp(0.0, inner as f64) as usize;
    let tick_cell = ((100.0 - elapsed_pct).clamp(0.0, 100.0) / 100.0 * inner as f64)
        .round()
        .clamp(0.0, inner.saturating_sub(1) as f64) as usize;
    let deficit = window.used_percent - elapsed_pct;
    let tick = if deficit <= 0.0 {
        RGB_GREEN
    } else if deficit < 3.0 {
        RGB_ORANGE
    } else {
        RGB_RED
    };
    let fill = quota_rgb(window.used_percent, remaining, window.window_secs, provider);

    let mut out = String::from(" ");
    for i in 0..inner {
        let color = if i == tick_cell {
            tick
        } else if i < remaining_cells {
            fill
        } else {
            RGB_TRACK
        };
        let ch = if i == tick_cell {
            "│"
        } else if i < remaining_cells {
            "▓"
        } else {
            "░"
        };
        out.push_str(&fg(color, ch));
    }
    out.push(' ');
    out
}

fn plain_width(s: &str) -> usize {
    s.chars().count()
}

fn parse_hex_rgb(hex: Option<&str>) -> Option<Rgb> {
    let h = hex?.trim().trim_start_matches('#');
    if h.len() != 6 {
        return None;
    }
    Some((
        u8::from_str_radix(&h[0..2], 16).ok()?,
        u8::from_str_radix(&h[2..4], 16).ok()?,
        u8::from_str_radix(&h[4..6], 16).ok()?,
    ))
}

fn quota_rgb(used: f64, remaining: i64, window: i64, provider: Rgb) -> Rgb {
    if window <= 0 || remaining <= 0 {
        return urgency_tint_rgb(provider, (used / 100.0).clamp(0.0, 1.0) as f32);
    }
    let elapsed_pct = ((window - remaining) as f64 / window as f64) * 100.0;
    let ratio = if elapsed_pct > 0.0 {
        used / elapsed_pct
    } else if used > 0.0 {
        f64::INFINITY
    } else {
        1.0
    };
    urgency_tint_rgb(provider, ((ratio - 1.0) / 0.5).clamp(0.0, 1.0) as f32)
}

fn pace_rgb(secs: i64, window: i64, provider: Rgb) -> Rgb {
    if secs >= 0 {
        return provider;
    }
    let pct = secs.unsigned_abs() as f64 / window as f64 * 100.0;
    urgency_tint_rgb(provider, (pct / 15.0).clamp(0.0, 1.0) as f32)
}

fn urgency_tint_rgb(provider: Rgb, urgency: f32) -> Rgb {
    let u = urgency.clamp(0.0, 1.0);
    let red_end = blend_rgb(RGB_RED, provider, 0.25);
    if u < 0.5 {
        blend_rgb(provider, RGB_ORANGE, u * 2.0 * 0.75)
    } else {
        let mid = blend_rgb(provider, RGB_ORANGE, 0.75);
        blend_rgb(mid, red_end, (u - 0.5) * 2.0)
    }
}

fn blend_rgb(a: Rgb, b: Rgb, t: f32) -> Rgb {
    let mix = |x: u8, y: u8| ((x as f32) * (1.0 - t) + (y as f32) * t).round() as u8;
    (mix(a.0, b.0), mix(a.1, b.1), mix(a.2, b.2))
}

fn pace_balance_secs_ct(used: f64, remaining: i64, window: i64) -> Option<i64> {
    let elapsed = window - remaining;
    if elapsed < 60 {
        return None;
    }
    let bal_pct = (100.0 - used) - (remaining as f64 / window as f64) * 100.0;
    Some((bal_pct * window as f64 / 100.0) as i64)
}

fn fmt_reset_ct(secs: i64) -> String {
    let a = secs.max(0);
    if a >= 86400 {
        format!(
            "{}d{:02}:{:02}",
            a / 86400,
            (a % 86400) / 3600,
            (a % 3600) / 60
        )
    } else if a >= 3600 {
        format!("{}h{:02}", a / 3600, (a % 3600) / 60)
    } else {
        format!("{}m", a / 60)
    }
}

fn fmt_pace_ct(secs: i64) -> String {
    let a = secs.unsigned_abs();
    let sign = if secs >= 0 { '+' } else { '-' };
    let txt = if a >= 86400 {
        format!(
            "{}d{:02}:{:02}",
            a / 86400,
            (a % 86400) / 3600,
            (a % 3600) / 60
        )
    } else if a >= 3600 {
        format!("{}h{:02}", a / 3600, (a % 3600) / 60)
    } else {
        format!("{}m", a / 60)
    };
    format!("{sign}{txt}")
}

fn fg(rgb: Rgb, text: &str) -> String {
    format!("\x1b[38;2;{};{};{}m{text}\x1b[39m", rgb.0, rgb.1, rgb.2)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usage_provider_config_defaults_when_absent() {
        assert_eq!(
            parse_usage_providers_config("").unwrap(),
            vec![UsageProvider::Claude, UsageProvider::Codex]
        );
    }

    #[test]
    fn usage_provider_config_controls_order_and_visibility() {
        assert_eq!(
            parse_usage_providers_config("[usage_bars]\nproviders = [\"codex\", \"claude\"]\n")
                .unwrap(),
            vec![UsageProvider::Codex, UsageProvider::Claude]
        );
    }

    #[test]
    fn usage_provider_config_accepts_hyphenated_table() {
        assert_eq!(
            parse_usage_providers_config("[usage-bars]\nproviders = [\"codex\"]\n").unwrap(),
            vec![UsageProvider::Codex]
        );
    }
    #[test]
    fn usage_provider_config_ignores_legacy_copilot() {
        assert_eq!(
            parse_usage_providers_config(
                "[usage_bars]\nproviders = [\"claude\", \"copilot\", \"codex\"]\n"
            )
            .unwrap(),
            vec![UsageProvider::Claude, UsageProvider::Codex]
        );
    }

    #[test]
    fn usage_provider_config_allows_legacy_copilot_only_as_empty() {
        assert_eq!(
            parse_usage_providers_config("[usage_bars]\nproviders = [\"copilot\"]\n").unwrap(),
            Vec::<UsageProvider>::new()
        );
    }

    #[test]
    fn usage_provider_config_rejects_unknown_provider() {
        let err = parse_usage_providers_config("[usage_bars]\nproviders = [\"cursor\"]\n")
            .unwrap_err()
            .to_string();
        assert!(err.contains("unknown usage_bars provider `cursor`"));
    }

    #[test]
    fn usage_provider_config_rejects_duplicate_provider() {
        let err =
            parse_usage_providers_config("[usage_bars]\nproviders = [\"codex\", \"codex\"]\n")
                .unwrap_err()
                .to_string();
        assert!(err.contains("duplicate usage_bars provider `codex`"));
    }

    #[test]
    fn sidebar_usage_bars_skip_expired_windows() {
        let req = usage_bars::RenderRequest {
            provider_label: CODEX_GLYPH.to_string(),
            provider_color: Some("74c7ec".to_string()),
            windows: vec![
                usage_bars::Window {
                    label: "5h".to_string(),
                    used_percent: 0.0,
                    window_secs: FIVE_HOURS,
                    reset_secs: -60,
                },
                usage_bars::Window {
                    label: "7d".to_string(),
                    used_percent: 20.0,
                    window_secs: SEVEN_DAYS,
                    reset_secs: 2 * 86400 + 3 * 3600 + 4 * 60,
                },
            ],
            width: 45,
        };

        let lines = render_sidebar_usage_bars(&[req], 45);

        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("7d"));
        assert!(!lines[0].contains("5h"));
        assert!(lines[0].contains("2d03:04"));
    }

    #[test]
    fn sidebar_usage_time_labels_have_minute_granularity() {
        assert_eq!(fmt_reset_ct(3 * 86400 + 23 * 3600 + 17 * 60), "3d23:17");
        assert_eq!(fmt_reset_ct(5 * 3600), "5h00");
        assert_eq!(fmt_reset_ct(59 * 60), "59m");
        assert_eq!(fmt_pace_ct(-(2 * 86400 + 3 * 3600 + 4 * 60)), "-2d03:04");
    }
}
