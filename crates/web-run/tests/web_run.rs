use pretty_assertions::assert_eq;
use proptest::prelude::*;
use proptest_derive::Arbitrary;
use reqwest::header::{HeaderMap, HeaderValue};
use rstest::rstest;
use serde_json::{json, Value};

use web_run::{
    allowed_cookie_name, bearer_from_json, bounded_error_body, cloudflare_challenge,
    is_chatgpt_url, output_body, request_body, search_url_from_base, WebRunInput,
    MAX_ERROR_BODY_CHARS,
};

#[test]
fn preserves_all_supported_operations() {
    let input: WebRunInput = serde_json::from_value(json!({
        "id": "session-1",
        "model": "gpt-5.6-luna",
        "search_query": [{"q": "rust", "recency": 2}],
        "image_query": [{"q": "rust logo"}],
        "open": [{"ref_id": "turn0search0", "lineno": 10}],
        "click": [{"ref_id": "turn0search0", "id": 3}],
        "find": [{"ref_id": "turn0search0", "pattern": "Rust"}],
        "screenshot": [{"ref_id": "turn0search0", "pageno": 1}],
        "finance": [{"ticker": "AAPL", "type": "equity", "market": "USA"}],
        "weather": [{"location": "London", "duration": 3}],
        "sports": [{"fn": "schedule", "league": "nba", "team": "LAL"}],
        "time": [{"utc_offset": "+00:00"}],
        "response_length": "short"
    }))
    .expect("typed input");
    let body = serde_json::to_value(request_body(input)).expect("request body");
    let commands = body.get("commands").expect("commands");
    assert_eq!(
        commands
            .get("search_query")
            .and_then(|value| value[0].get("q"))
            .and_then(Value::as_str),
        Some("rust")
    );
    assert!(commands.get("screenshot").is_some());
    assert_eq!(body["settings"]["allowed_callers"], json!(["direct"]));
}

#[test]
fn returns_structured_output() {
    assert_eq!(
        output_body(&json!({"output": "done", "results": [{"ref_id": "turn0search0"}]})),
        json!({"output_text": "done", "search_results": [{"ref_id": "turn0search0"}]})
    );
}

#[rstest]
#[case(
    "https://chatgpt.com/backend-api/codex",
    "https://chatgpt.com/backend-api/codex/alpha/search"
)]
#[case(
    "https://proxy.example/api/codex/responses",
    "https://proxy.example/api/codex/alpha/search"
)]
fn derives_alpha_search_endpoint(#[case] base: &str, #[case] expected: &str) {
    assert_eq!(search_url_from_base(base), expected);
}

#[test]
fn rejects_invalid_inputs() {
    assert!(bearer_from_json(&json!({
        "openai-codex": { "access": "", "accountId": "account" }
    }))
    .is_err());
    assert!(bearer_from_json(&json!({
        "openai-codex": { "access": "token", "accountId": "" }
    }))
    .is_err());
    assert!(serde_json::from_str::<WebRunInput>(r#"{"reasoning": {}}"#).is_err());
    assert!(serde_json::from_str::<WebRunInput>(r#"{"click": [{"ref_id": "x"}]}"#).is_err());
    assert!(serde_json::from_str::<WebRunInput>(
        r#"{"finance": [{"ticker": "AAPL", "type": "bond"}]}"#
    )
    .is_err());
}

#[test]
fn limits_cookie_hosts_and_names() {
    assert!(is_chatgpt_url(
        &"https://chatgpt.com/api".parse().expect("url")
    ));
    assert!(!is_chatgpt_url(
        &"https://example.com/api".parse().expect("url")
    ));
    assert!(allowed_cookie_name("cf_clearance"));
    assert!(!allowed_cookie_name("session"));
}

#[test]
fn detects_cloudflare_challenges() {
    let mut headers = HeaderMap::new();
    headers.insert("cf-mitigated", HeaderValue::from_static("challenge"));
    assert!(cloudflare_challenge(&headers, "ignored"));
}

#[derive(Debug, Arbitrary)]
struct ErrorBody(String);

proptest! {
    // Property: error rendering is whitespace-normalized and bounded for all input bodies.
    #[test]
    fn bounded_error_body_is_safe_for_arbitrary_input(input: ErrorBody) {
        let result = bounded_error_body(&input.0);
        prop_assert!(!result.contains('\n'));
        prop_assert!(result.chars().count() <= MAX_ERROR_BODY_CHARS + 1);
    }
}
