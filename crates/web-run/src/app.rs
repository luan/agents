use std::env;
use std::io::Read;

use crate::types::{SearchRequest, WebRunInput};
use anyhow::{Context, Result};
use futures_util::StreamExt;
use serde_json::{json, Value};
use uuid::Uuid;

const DEFAULT_BASE_URL: &str = "https://chatgpt.com/backend-api/codex";
const DEFAULT_MODEL: &str = "gpt-5.6-luna";
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

async fn read_response_body(response: reqwest::Response) -> Result<String> {
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("failed to read web_run response")?;
        if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            anyhow::bail!("web_run response exceeded {MAX_RESPONSE_BYTES} bytes")
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).context("web_run response was not UTF-8")
}

fn read_stdin() -> Result<String> {
    let mut input = String::new();
    std::io::stdin()
        .read_to_string(&mut input)
        .context("failed to read web_run JSON arguments from stdin")?;
    if input.trim().is_empty() {
        anyhow::bail!("web_run requires JSON arguments")
    }
    Ok(input)
}

pub fn search_url_from_base(base: &str) -> String {
    let base = base.trim_end_matches('/');
    if base.ends_with("/alpha/search") {
        base.to_owned()
    } else if let Some(base) = base.strip_suffix("/responses") {
        format!("{base}/alpha/search")
    } else if base.ends_with("/api/codex")
        || base.ends_with("/backend-api/codex")
        || base.ends_with("/codex")
    {
        format!("{base}/alpha/search")
    } else if base.ends_with("/api") || base.ends_with("/backend-api") {
        format!("{base}/codex/alpha/search")
    } else {
        format!("{base}/api/codex/alpha/search")
    }
}

fn search_url() -> String {
    env::var("PI_CODEX_SEARCH_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            let base = env::var("PI_CODEX_BASE_URL")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| DEFAULT_BASE_URL.to_owned());
            search_url_from_base(&base)
        })
}

pub fn request_body(input: WebRunInput) -> SearchRequest {
    let model = env::var("PI_CODEX_MODEL")
        .ok()
        .filter(|model| !model.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_MODEL.to_owned());
    input.into_request(model, Uuid::new_v4().to_string())
}

pub fn output_body(response: &Value) -> Value {
    let output = response
        .get("output")
        .cloned()
        .unwrap_or(Value::String(String::new()));
    let results = response
        .get("results")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    json!({ "output_text": output, "search_results": results })
}

async fn run(input: WebRunInput) -> Result<Value> {
    let auth = crate::auth::read().await?;
    let url = search_url();
    let response = crate::http::client()?
        .post(&url)
        .headers(crate::http::auth_headers(&auth)?)
        .json(&request_body(input))
        .send()
        .await
        .with_context(|| format!("web_run search request failed for `{url}`"))?;
    let status = response.status();
    let headers = response.headers().clone();
    let body = read_response_body(response).await?;
    if !status.is_success() {
        if status.as_u16() == 403
            && (crate::http::cloudflare_challenge(&headers, &body)
                || body.to_ascii_lowercase().contains("cloudflare"))
        {
            anyhow::bail!("web_run search failed for `{url}`: HTTP 403 Cloudflare challenge")
        }
        if status.as_u16() == 404 && body.contains("\"Not Found\"") {
            anyhow::bail!(
                "web_run search failed for `{url}`: HTTP 404 Not Found (Codex search endpoint unavailable for this account or backend)"
            )
        }
        let detail = crate::http::bounded_error_body(&body);
        anyhow::bail!("web_run search failed for `{url}`: HTTP {status} {detail}")
    }
    let response: Value =
        serde_json::from_str(&body).context("failed to decode web_run response")?;
    Ok(output_body(&response))
}

pub async fn run_main() -> Result<()> {
    let mut args = env::args().skip(1);
    let input = match args.next() {
        None => read_stdin()?,
        Some(value) if value == "-" => {
            if args.next().is_some() {
                anyhow::bail!("web_run accepts a single JSON argument or stdin")
            }
            read_stdin()?
        }
        Some(value) => {
            if args.next().is_some() {
                anyhow::bail!("web_run accepts a single JSON argument or stdin")
            }
            value
        }
    };
    let input: WebRunInput =
        serde_json::from_str(input.trim()).context("failed to parse web_run JSON arguments")?;
    let output = serde_json::to_string(&run(input).await?)?;
    println!("{output}");
    Ok(())
}
