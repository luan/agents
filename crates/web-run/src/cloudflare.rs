use std::sync::{Arc, LazyLock};

use reqwest::cookie::{CookieStore, Jar};
use reqwest::header::HeaderValue;

pub static COOKIE_STORE: LazyLock<Arc<CloudflareCookieStore>> =
    LazyLock::new(|| Arc::new(CloudflareCookieStore::default()));

#[derive(Debug, Default)]
pub struct CloudflareCookieStore {
    jar: Jar,
}

impl CookieStore for CloudflareCookieStore {
    fn set_cookies(
        &self,
        cookie_headers: &mut dyn Iterator<Item = &HeaderValue>,
        url: &reqwest::Url,
    ) {
        if !is_chatgpt_url(url) {
            return;
        }
        let mut allowed = cookie_headers.filter(|header| allowed_set_cookie(header));
        self.jar.set_cookies(&mut allowed, url);
    }

    fn cookies(&self, url: &reqwest::Url) -> Option<HeaderValue> {
        if !is_chatgpt_url(url) {
            return None;
        }
        self.jar
            .cookies(url)
            .and_then(|header| only_cloudflare_cookies(&header))
    }
}

pub fn is_chatgpt_url(url: &reqwest::Url) -> bool {
    if url.scheme() != "https" {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    matches!(
        host,
        "chatgpt.com" | "chat.openai.com" | "chatgpt-staging.com"
    ) || host.ends_with(".chatgpt.com")
        || host.ends_with(".chatgpt-staging.com")
}

fn allowed_set_cookie(header: &HeaderValue) -> bool {
    header
        .to_str()
        .ok()
        .and_then(|value| value.split_once('=').map(|(name, _)| name.trim()))
        .is_some_and(allowed_cookie_name)
}

fn only_cloudflare_cookies(header: &HeaderValue) -> Option<HeaderValue> {
    let cookies = header
        .to_str()
        .ok()?
        .split(';')
        .filter_map(|cookie| {
            let cookie = cookie.trim();
            let name = cookie.split_once('=')?.0.trim();
            allowed_cookie_name(name).then_some(cookie)
        })
        .collect::<Vec<_>>()
        .join("; ");
    (!cookies.is_empty())
        .then(|| HeaderValue::from_str(&cookies).ok())
        .flatten()
}

pub fn allowed_cookie_name(name: &str) -> bool {
    matches!(
        name,
        "__cf_bm"
            | "__cflb"
            | "__cfruid"
            | "__cfseq"
            | "__cfwaitingroom"
            | "_cfuvid"
            | "cf_clearance"
            | "cf_ob_info"
            | "cf_use_ob"
    ) || name.starts_with("cf_chl_")
}
