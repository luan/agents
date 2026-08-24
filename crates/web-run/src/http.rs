use std::env;
use std::sync::Arc;

use anyhow::{Context, Result};
use reqwest::header::{HeaderMap, HeaderValue, CONTENT_TYPE, USER_AGENT};

use crate::auth::Auth;
use crate::cloudflare::COOKIE_STORE;

const DEFAULT_ORIGINATOR: &str = "codex_cli_rs";
pub const MAX_ERROR_BODY_CHARS: usize = 2_048;

pub fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .default_headers(default_headers())
        .cookie_provider(Arc::clone(&COOKIE_STORE))
        .build()
        .context("failed to build web_run HTTP client")
}

pub fn auth_headers(auth: &Auth) -> Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    headers.insert(
        "Authorization",
        HeaderValue::from_str(&auth.authorization_header()?)?,
    );
    headers.insert(
        "ChatGPT-Account-ID",
        HeaderValue::from_str(auth.account_id())?,
    );
    if auth.is_fedramp() {
        headers.insert("X-OpenAI-Fedramp", HeaderValue::from_static("true"));
    }
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    Ok(headers)
}

fn default_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    let originator = env::var("CODEX_INTERNAL_ORIGINATOR_OVERRIDE")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_ORIGINATOR.to_owned());
    headers.insert(
        "originator",
        HeaderValue::from_str(&originator)
            .unwrap_or_else(|_| HeaderValue::from_static(DEFAULT_ORIGINATOR)),
    );
    if let Ok(value) = HeaderValue::from_str(&user_agent(&originator)) {
        headers.insert(USER_AGENT, value);
    }
    headers.insert("version", HeaderValue::from_static("0.0.0"));
    headers
}

fn user_agent(originator: &str) -> String {
    let terminal = env::var("TERM_PROGRAM")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            env::var("TERM")
                .ok()
                .filter(|value| !value.trim().is_empty())
        })
        .unwrap_or_else(|| "unknown".to_owned());
    let os = os_info::get();
    format!(
        "{originator}/0.0.0 ({} {}; {}) {terminal}",
        os.os_type(),
        os.version(),
        os.architecture().unwrap_or("unknown")
    )
}

pub fn cloudflare_challenge(headers: &HeaderMap, body: &str) -> bool {
    let mitigated = headers
        .get("cf-mitigated")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.eq_ignore_ascii_case("challenge"));
    let cloudflare = headers
        .get("server")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.eq_ignore_ascii_case("cloudflare"));
    mitigated || (cloudflare && body.trim_start().starts_with("<html"))
}

pub fn bounded_error_body(body: &str) -> String {
    let normalized = body.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = normalized.chars();
    let bounded = chars
        .by_ref()
        .take(MAX_ERROR_BODY_CHARS)
        .collect::<String>();
    if chars.next().is_some() {
        format!("{bounded}…")
    } else {
        bounded
    }
}
