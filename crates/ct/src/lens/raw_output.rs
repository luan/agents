use super::types::RawOutputRef;

pub const DEFAULT_RAW_OUTPUT_MAX_BYTES: usize = 64 * 1024;
pub const DEFAULT_RAW_OUTPUT_TTL_DAYS: i64 = 7;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SanitizedRawOutput {
    pub body: String,
    pub original_bytes: i64,
    pub retained_bytes: i64,
    pub truncated: bool,
    pub redacted: bool,
}

pub fn sanitize(raw: &str, max_bytes: usize) -> SanitizedRawOutput {
    let redacted_body = redact(raw);
    let redacted = redacted_body != raw;
    let original_bytes = raw.len() as i64;
    let (body, truncated) = truncate_utf8(&redacted_body, max_bytes);
    let retained_bytes = body.len() as i64;
    SanitizedRawOutput {
        body,
        original_bytes,
        retained_bytes,
        truncated,
        redacted,
    }
}

pub fn expires_at(created_at: i64, ttl_days: i64) -> i64 {
    created_at + ttl_days.max(0) * 24 * 60 * 60 * 1000
}

pub fn ref_from_row(
    id: i64,
    original_bytes: i64,
    retained_bytes: i64,
    truncated: bool,
    redacted: bool,
    expires_at: i64,
) -> RawOutputRef {
    RawOutputRef {
        id,
        original_bytes,
        retained_bytes,
        truncated,
        redacted,
        expires_at,
    }
}

fn truncate_utf8(value: &str, max_bytes: usize) -> (String, bool) {
    if value.len() <= max_bytes {
        return (value.to_string(), false);
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    (value[..end].to_string(), true)
}

fn redact(raw: &str) -> String {
    raw.lines().map(redact_line).collect::<Vec<_>>().join("\n")
}

fn redact_line(line: &str) -> String {
    let lower = line.to_ascii_lowercase();
    for marker in [
        "authorization: bearer ",
        "authorization=bearer ",
        "api_key=",
        "api-key=",
        "token=",
        "password=",
        "secret=",
    ] {
        if let Some(index) = lower.find(marker) {
            let value_start = index + marker.len();
            return format!("{}[REDACTED]", &line[..value_start]);
        }
    }
    for marker in ["api_key:", "api-key:", "token:", "password:", "secret:"] {
        if let Some(index) = lower.find(marker) {
            let value_start = index + marker.len();
            return format!("{} [REDACTED]", line[..value_start].trim_end());
        }
    }
    line.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_output_is_capped_and_redacted() {
        let sanitized = sanitize("token=abc123\nhello world", 14);
        assert!(sanitized.redacted);
        assert!(sanitized.truncated);
        assert!(!sanitized.body.contains("abc123"));
        assert!(sanitized.body.len() <= 14);
    }

    #[test]
    fn raw_output_expiry_uses_ttl_days() {
        assert_eq!(expires_at(1_000, 2), 1_000 + 2 * 24 * 60 * 60 * 1000);
    }
}
