//! Smart usage bar renderer for subscription quota windows.
//!
//! Pure rendering: caller supplies windows + width, library emits an ANSI line.
//! Bars include a pace tick (where you'd be at even pace), urgency-tinted fill
//! (provider color → orange → red as you fall behind), and reset countdown.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RenderRequest {
    pub provider_label: String,
    /// Optional 6-char hex (no `#`). Falls back to the muted default when absent.
    pub provider_color: Option<String>,
    pub windows: Vec<Window>,
    pub width: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Window {
    pub label: String,
    /// Used percentage [0, 100].
    pub used_percent: f64,
    /// Total window length in seconds. <= 0 disables pace tick.
    pub window_secs: i64,
    /// Seconds until reset. <= 0 disables reset display + pace.
    pub reset_secs: i64,
}

// Reset / urgency palette — semantic, not theme-bound.
const RGB_DIM: (u8, u8, u8) = (0x6c, 0x70, 0x86);
const RGB_ORANGE: (u8, u8, u8) = (0xfa, 0xb3, 0x87);
const RGB_RED: (u8, u8, u8) = (0xef, 0x44, 0x44);
const RGB_GREEN: (u8, u8, u8) = (0xa6, 0xe3, 0xa1);
const RGB_DEFAULT_PROVIDER: (u8, u8, u8) = (0xa0, 0xa8, 0xc0);

const BAR_FILLED: char = '▓';
const BAR_EMPTY: char = '░';
const BAR_TICK: char = '│';

pub fn render(req: &RenderRequest) -> Vec<String> {
    let provider_color = parse_hex(req.provider_color.as_deref()).unwrap_or(RGB_DEFAULT_PROVIDER);
    let sep = format!(" {} ", fg(RGB_DIM, ">"));
    let provider_segment = fg(provider_color, &req.provider_label);

    let mut segments = vec![provider_segment];
    for w in &req.windows {
        segments.push(fit_window(w, provider_color, req.width));
    }
    wrap_segments(&segments, req.width, &sep)
}

fn fit_window(w: &Window, provider: (u8, u8, u8), max_width: usize) -> String {
    // Try richest variant first, fall back to compact ones for narrow terminals.
    for variant in [
        render_window(w, provider, 10, true, true),
        render_window(w, provider, 8, true, true),
        render_window(w, provider, 8, false, true),
        render_window(w, provider, 6, false, true),
        render_window(w, provider, 4, false, false),
    ] {
        if visible_width(&variant) <= max_width {
            return variant;
        }
    }
    truncate_to_width(&render_window(w, provider, 4, false, false), max_width)
}

fn render_window(
    w: &Window,
    provider: (u8, u8, u8),
    bar_width: usize,
    show_pace: bool,
    show_reset: bool,
) -> String {
    let used = w.used_percent.clamp(0.0, 100.0);
    let elapsed_pct = elapsed_pct(w);
    let fill_color = quota_color(used, w.reset_secs, w.window_secs, provider);
    let bar = render_bar(bar_width, used, elapsed_pct, fill_color);

    let remaining_pct = (100.0 - used).clamp(0.0, 100.0);
    let pct_txt = format!("{}%", remaining_pct.round() as i64);
    let pct = fg(fill_color, &pct_txt);

    let label = fg(RGB_DIM, &w.label);
    let mut out = format!("{label} {bar} {pct}");

    if show_pace
        && w.window_secs > 0
        && let Some(bal) = pace_balance_secs(used, w.reset_secs, w.window_secs)
        && bal != 0
    {
        let pace_txt = fmt_pace(bal);
        out.push(' ');
        out.push_str(&fg(pace_color(bal, w.window_secs, provider), &pace_txt));
    }

    if show_reset && w.reset_secs > 0 {
        let reset = fmt_reset(w.reset_secs);
        out.push(' ');
        out.push_str(&fg(RGB_DIM, &format!("↺{reset}")));
    }

    out
}

fn render_bar(width: usize, used_pct: f64, elapsed_pct: f64, fill_color: (u8, u8, u8)) -> String {
    if width == 0 {
        return String::new();
    }
    let remaining_pct = (100.0 - used_pct).clamp(0.0, 100.0);
    let expected_remaining_pct = (100.0 - elapsed_pct).clamp(0.0, 100.0);
    let remaining_cells = ((remaining_pct / 100.0) * width as f64)
        .round()
        .clamp(0.0, width as f64) as usize;
    let tick_cell = if elapsed_pct > 0.0 {
        Some(
            ((expected_remaining_pct / 100.0) * width as f64)
                .round()
                .clamp(0.0, width.saturating_sub(1) as f64) as usize,
        )
    } else {
        None
    };

    let deficit = used_pct - elapsed_pct;
    let tick_color = if deficit <= 0.0 {
        RGB_GREEN
    } else if deficit < 3.0 {
        RGB_ORANGE
    } else {
        RGB_RED
    };

    let mut out = String::new();
    for i in 0..width {
        let is_tick = Some(i) == tick_cell;
        let filled = i < remaining_cells;
        match (filled, is_tick) {
            (true, true) => out.push_str(&fg(tick_color, &BAR_TICK.to_string())),
            (true, false) => out.push_str(&fg(fill_color, &BAR_FILLED.to_string())),
            (false, true) => out.push_str(&fg(tick_color, &BAR_TICK.to_string())),
            (false, false) => out.push_str(&fg(RGB_DIM, &BAR_EMPTY.to_string())),
        }
    }
    out
}

fn elapsed_pct(w: &Window) -> f64 {
    if w.window_secs <= 0 || w.reset_secs <= 0 {
        return 0.0;
    }
    let elapsed = (w.window_secs - w.reset_secs).max(0) as f64;
    (elapsed / w.window_secs as f64) * 100.0
}

fn pace_balance_secs(used: f64, remaining: i64, window: i64) -> Option<i64> {
    let elapsed = window - remaining;
    if elapsed < 60 {
        return None;
    }
    let bal_pct = (100.0 - used) - (remaining as f64 / window as f64) * 100.0;
    Some((bal_pct * window as f64 / 100.0) as i64)
}

fn quota_color(used: f64, remaining: i64, window: i64, provider: (u8, u8, u8)) -> (u8, u8, u8) {
    if window <= 0 || remaining <= 0 {
        let urgency = (used / 100.0).clamp(0.0, 1.0) as f32;
        return urgency_tint(provider, urgency);
    }
    let elapsed_pct = ((window - remaining) as f64 / window as f64) * 100.0;
    let ratio = if elapsed_pct > 0.0 {
        used / elapsed_pct
    } else if used > 0.0 {
        f64::INFINITY
    } else {
        1.0
    };
    let urgency = ((ratio - 1.0) / 0.5).clamp(0.0, 1.0) as f32;
    urgency_tint(provider, urgency)
}

fn pace_color(secs: i64, window: i64, provider: (u8, u8, u8)) -> (u8, u8, u8) {
    if secs >= 0 {
        return provider;
    }
    let pct = (secs.unsigned_abs() as f64) / (window as f64) * 100.0;
    let urgency = (pct / 15.0).clamp(0.0, 1.0) as f32;
    urgency_tint(provider, urgency)
}

/// urgency [0,1]: 0 = provider color, 0.5 = orange-tinted, 1 = red-tinted.
/// Keeps a 25% provider hint at the red end so each provider's "critical"
/// reads distinctly instead of converging on one shared red.
fn urgency_tint(provider: (u8, u8, u8), urgency: f32) -> (u8, u8, u8) {
    let u = urgency.clamp(0.0, 1.0);
    let red_end = blend(RGB_RED, provider, 0.25);
    if u < 0.5 {
        blend(provider, RGB_ORANGE, u * 2.0 * 0.75)
    } else {
        let mid = blend(provider, RGB_ORANGE, 0.75);
        blend(mid, red_end, (u - 0.5) * 2.0)
    }
}

fn blend(a: (u8, u8, u8), b: (u8, u8, u8), t: f32) -> (u8, u8, u8) {
    let mix = |x: u8, y: u8| ((x as f32) * (1.0 - t) + (y as f32) * t).round() as u8;
    (mix(a.0, b.0), mix(a.1, b.1), mix(a.2, b.2))
}

fn fmt_reset(secs: i64) -> String {
    let a = secs.max(0);
    if a >= 86400 {
        format!("{}d{}h", a / 86400, (a % 86400) / 3600)
    } else if a >= 3600 {
        format!("{}h{:02}m", a / 3600, (a % 3600) / 60)
    } else {
        format!("{}m", a / 60)
    }
}

fn fmt_pace(secs: i64) -> String {
    let a = secs.unsigned_abs();
    let sign = if secs >= 0 { '+' } else { '-' };
    let txt = if a >= 86400 {
        format!("{}d{}h", a / 86400, (a % 86400) / 3600)
    } else if a >= 3600 {
        format!("{}h", a / 3600)
    } else {
        format!("{}m", a / 60)
    };
    format!("{sign}{txt}")
}

fn fg(rgb: (u8, u8, u8), text: &str) -> String {
    format!("\x1b[38;2;{};{};{}m{text}\x1b[39m", rgb.0, rgb.1, rgb.2)
}

fn parse_hex(hex: Option<&str>) -> Option<(u8, u8, u8)> {
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

/// Visible-width counter that skips ANSI CSI escape sequences (`\x1b[...m`).
/// Doesn't try to handle wide chars — bars use ASCII + box drawings only.
pub fn visible_width(s: &str) -> usize {
    let mut count = 0;
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            if matches!(chars.next(), Some('[')) {
                for esc in chars.by_ref() {
                    if esc.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        count += 1;
    }
    count
}

fn truncate_to_width(s: &str, max_width: usize) -> String {
    let mut out = String::new();
    let mut count = 0;
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            out.push(c);
            if let Some(&'[') = chars.peek() {
                out.push(chars.next().unwrap());
                while let Some(&esc) = chars.peek() {
                    out.push(chars.next().unwrap());
                    if esc.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        if count >= max_width {
            break;
        }
        out.push(c);
        count += 1;
    }
    out
}

fn wrap_segments(segments: &[String], width: usize, sep: &str) -> Vec<String> {
    if segments.is_empty() {
        return Vec::new();
    }
    let safe_width = width.max(1);
    let sep_w = visible_width(sep);
    let mut lines = Vec::new();
    let mut current = String::new();
    let mut current_w = 0;

    for seg in segments {
        let seg_w = visible_width(seg);
        if current.is_empty() {
            current.push_str(seg);
            current_w = seg_w;
            continue;
        }
        if current_w + sep_w + seg_w <= safe_width {
            current.push_str(sep);
            current.push_str(seg);
            current_w += sep_w + seg_w;
        } else {
            lines.push(std::mem::take(&mut current));
            current.push_str(seg);
            current_w = seg_w;
        }
    }
    if !current.is_empty() {
        lines.push(current);
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn visible_width_skips_ansi() {
        assert_eq!(visible_width("hello"), 5);
        assert_eq!(visible_width("\x1b[31mhello\x1b[39m"), 5);
        assert_eq!(visible_width("\x1b[38;2;255;0;0mfoo\x1b[39m bar"), 7);
    }

    #[test]
    fn renders_provider_only_when_no_windows() {
        let req = RenderRequest {
            provider_label: "Anthropic".into(),
            provider_color: Some("d87b4a".into()),
            windows: vec![],
            width: 80,
        };
        let lines = render(&req);
        assert_eq!(lines.len(), 1);
        assert!(lines[0].contains("Anthropic"));
    }

    #[test]
    fn renders_window_with_bar() {
        let req = RenderRequest {
            provider_label: "Anthropic".into(),
            provider_color: Some("d87b4a".into()),
            windows: vec![Window {
                label: "5h".into(),
                used_percent: 50.0,
                window_secs: 5 * 3600,
                reset_secs: 2 * 3600,
            }],
            width: 80,
        };
        let lines = render(&req);
        assert_eq!(lines.len(), 1);
        let line = &lines[0];
        assert!(line.contains("Anthropic"));
        assert!(line.contains("5h"));
        assert!(line.contains("50%"));
        assert!(line.contains('↺'));
    }

    #[test]
    fn wraps_when_too_wide() {
        let req = RenderRequest {
            provider_label: "Anthropic".into(),
            provider_color: None,
            windows: vec![
                Window {
                    label: "5h".into(),
                    used_percent: 50.0,
                    window_secs: 5 * 3600,
                    reset_secs: 2 * 3600,
                },
                Window {
                    label: "Week".into(),
                    used_percent: 30.0,
                    window_secs: 7 * 86400,
                    reset_secs: 5 * 86400,
                },
            ],
            width: 30,
        };
        let lines = render(&req);
        assert!(lines.len() >= 2, "expected wrap, got: {lines:?}");
    }
}
