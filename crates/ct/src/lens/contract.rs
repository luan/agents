use serde::{Deserialize, Serialize};

pub const LENS_RESPONSE_SCHEMA_VERSION: &str = "lens.response.v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LensResponseStatus {
    Ok,
    Warning,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LensMessage {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

impl LensMessage {
    pub fn warning(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            hint: None,
        }
    }

    pub fn warning_with_hint(
        code: impl Into<String>,
        message: impl Into<String>,
        hint: impl Into<String>,
    ) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            hint: Some(hint.into()),
        }
    }

    pub fn error(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            hint: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LensEnvelope<T>
where
    T: Serialize,
{
    pub schema_version: String,
    pub status: LensResponseStatus,
    pub warnings: Vec<LensMessage>,
    pub errors: Vec<LensMessage>,
    pub data: T,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debug: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw: Option<serde_json::Value>,
}

impl<T> LensEnvelope<T>
where
    T: Serialize,
{
    pub fn ok(data: T) -> Self {
        Self::new(LensResponseStatus::Ok, data)
    }

    pub fn warning(data: T, warnings: Vec<LensMessage>) -> Self {
        Self {
            warnings,
            ..Self::new(LensResponseStatus::Warning, data)
        }
    }

    pub fn error(data: T, errors: Vec<LensMessage>) -> Self {
        Self {
            errors,
            ..Self::new(LensResponseStatus::Error, data)
        }
    }

    pub fn with_debug(mut self, debug: serde_json::Value) -> Self {
        self.debug = Some(debug);
        self
    }

    pub fn with_raw(mut self, raw: serde_json::Value) -> Self {
        self.raw = Some(raw);
        self
    }

    fn new(status: LensResponseStatus, data: T) -> Self {
        Self {
            schema_version: LENS_RESPONSE_SCHEMA_VERSION.to_string(),
            status,
            warnings: Vec::new(),
            errors: Vec::new(),
            data,
            debug: None,
            raw: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn response_schema_is_stable_and_debug_raw_are_opt_in() {
        let envelope = LensEnvelope::ok(serde_json::json!({ "answer": 42 }));
        let value = serde_json::to_value(&envelope).unwrap();

        assert_eq!(value["schema_version"], LENS_RESPONSE_SCHEMA_VERSION);
        assert_eq!(value["status"], "ok");
        assert_eq!(value["warnings"].as_array().unwrap().len(), 0);
        assert_eq!(value["errors"].as_array().unwrap().len(), 0);
        assert_eq!(value["data"]["answer"], 42);
        assert!(value.get("debug").is_none());
        assert!(value.get("raw").is_none());

        let expanded = LensEnvelope::ok(serde_json::json!({}))
            .with_debug(serde_json::json!({ "why": "test" }))
            .with_raw(serde_json::json!({ "backend": "fixture" }));
        let expanded_value = serde_json::to_value(&expanded).unwrap();
        assert_eq!(expanded_value["debug"]["why"], "test");
        assert_eq!(expanded_value["raw"]["backend"], "fixture");
    }
}
