use code_mode_protocol::CodeModeToolKind;
use code_mode_protocol::ParsedExecSource;
use code_mode_protocol::ToolDefinition;
use code_mode_protocol::ToolName;
use code_mode_protocol::ToolNamespaceDescription;
use code_mode_protocol::augment_tool_definition;
use code_mode_protocol::build_exec_tool_description;
use code_mode_protocol::normalize_code_mode_identifier;
use code_mode_protocol::parse_exec_source;
use pretty_assertions::assert_eq;
use serde_json::Value as JsonValue;
use serde_json::json;
use std::collections::BTreeMap;

fn mcp_call_tool_result_schema(structured_content_schema: &JsonValue) -> JsonValue {
    json!({
        "type": "object",
        "properties": {
            "content": {
                "type": "array",
                "items": {
                    "type": "object"
                }
            },
            "structuredContent": structured_content_schema,
            "isError": { "type": "boolean" },
            "_meta": { "type": "object" }
        },
        "required": ["content"],
        "additionalProperties": false
    })
}

#[test]
fn parse_exec_source_without_pragma() {
    assert_eq!(
        parse_exec_source("text('hi')").unwrap(),
        ParsedExecSource {
            code: "text('hi')".to_string(),
            yield_time_ms: None,
            max_output_tokens: None,
        }
    );
}

#[test]
fn parse_exec_source_with_pragma() {
    assert_eq!(
        parse_exec_source("// @exec: {\"yield_time_ms\": 10}\ntext('hi')").unwrap(),
        ParsedExecSource {
            code: "text('hi')".to_string(),
            yield_time_ms: Some(10),
            max_output_tokens: None,
        }
    );
}

#[test]
fn normalize_identifier_rewrites_invalid_characters() {
    assert_eq!(
        "mcp__ologs__get_profile",
        normalize_code_mode_identifier("mcp__ologs__get_profile")
    );
    assert_eq!(
        "hidden_dynamic_tool",
        normalize_code_mode_identifier("hidden-dynamic-tool")
    );
}

#[test]
fn augment_tool_definition_appends_typed_declaration() {
    let definition = ToolDefinition {
        name: "hidden_dynamic_tool".to_string(),
        tool_name: ToolName::plain("hidden_dynamic_tool"),
        description: "Test tool".to_string(),
        kind: CodeModeToolKind::Function,
        input_schema: Some(json!({
            "type": "object",
            "properties": { "city": { "type": "string" } },
            "required": ["city"],
            "additionalProperties": false
        })),
        output_schema: Some(json!({
            "type": "object",
            "properties": { "ok": { "type": "boolean" } },
            "required": ["ok"]
        })),
    };

    let description = augment_tool_definition(definition).description;
    assert!(description.contains("declare const tools"));
    assert!(
        description
            .contains("hidden_dynamic_tool(args: { city: string; }): Promise<{ ok: boolean; }>;")
    );
}

#[test]
fn augment_tool_definition_includes_property_descriptions_as_comments() {
    let definition = ToolDefinition {
        name: "weather_tool".to_string(),
        tool_name: ToolName::plain("weather_tool"),
        description: "Weather tool".to_string(),
        kind: CodeModeToolKind::Function,
        input_schema: Some(json!({
            "type": "object",
            "properties": {
                "weather": {
                    "type": "array",
                    "description": "look up weather for a given list of locations",
                    "items": {
                        "type": "object",
                        "properties": {
                            "location": { "type": "string" }
                        },
                        "required": ["location"]
                    }
                }
            },
            "required": ["weather"]
        })),
        output_schema: Some(json!({
            "type": "object",
            "properties": {
                "forecast": {
                    "type": "string",
                    "description": "human readable weather forecast"
                }
            },
            "required": ["forecast"]
        })),
    };

    let description = augment_tool_definition(definition).description;
    assert!(description.contains(
        r"weather_tool(args: {
  // look up weather for a given list of locations
  weather: Array<{ location: string; }>;
}): Promise<{
  // human readable weather forecast
  forecast: string;
}>;"
    ));
}

#[test]
fn code_mode_only_description_includes_nested_tools() {
    let description = build_exec_tool_description(
        &[ToolDefinition {
            name: "foo".to_string(),
            tool_name: ToolName::plain("foo"),
            description: "bar".to_string(),
            kind: CodeModeToolKind::Function,
            input_schema: None,
            output_schema: None,
        }],
        &[],
        &BTreeMap::new(),
        code_mode_protocol::DEFAULT_EXEC_YIELD_TIME_MS,
        /*code_mode_only*/ true,
    );
    assert!(description.contains(
        "### `foo`
bar"
    ));
    assert!(!description.contains("do not attempt to use any other tools directly"));
}

#[test]
fn exec_description_mentions_timeout_helpers() {
    let description = build_exec_tool_description(
        &[],
        &[],
        &BTreeMap::new(),
        code_mode_protocol::DEFAULT_EXEC_YIELD_TIME_MS,
        /*code_mode_only*/ false,
    );
    assert!(description.contains("`audio(audioUrlOrItem:"));
    assert!(description.contains("`setTimeout(callback: () => void, delayMs?: number)`"));
    assert!(description.contains("`clearTimeout(timeoutId?: number)`"));
}

#[test]
fn code_mode_only_description_groups_namespace_instructions_once() {
    let namespace_descriptions = BTreeMap::from([(
        "mcp__sample__".to_string(),
        ToolNamespaceDescription {
            name: "mcp__sample".to_string(),
            description: "Shared namespace guidance.".to_string(),
        },
    )]);
    let description = build_exec_tool_description(
        &[
            ToolDefinition {
                name: "mcp__sample__alpha".to_string(),
                tool_name: ToolName::namespaced("mcp__sample__", "alpha"),
                description: "First tool".to_string(),
                kind: CodeModeToolKind::Function,
                input_schema: Some(json!({
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                })),
                output_schema: Some(mcp_call_tool_result_schema(&json!({
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                }))),
            },
            ToolDefinition {
                name: "mcp__sample__beta".to_string(),
                tool_name: ToolName::namespaced("mcp__sample__", "beta"),
                description: "Second tool".to_string(),
                kind: CodeModeToolKind::Function,
                input_schema: Some(json!({
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                })),
                output_schema: Some(mcp_call_tool_result_schema(&json!({
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                }))),
            },
        ],
        &[],
        &namespace_descriptions,
        code_mode_protocol::DEFAULT_EXEC_YIELD_TIME_MS,
        /*code_mode_only*/ true,
    );
    assert_eq!(description.matches("## mcp__sample").count(), 1);
    assert!(description.contains("## mcp__sample\nShared namespace guidance."));
    assert!(description.contains(
        "declare const tools: { mcp__sample__alpha(args: {}): Promise<CallToolResult<{}>>; };"
    ));
    assert!(description.contains(
        "declare const tools: { mcp__sample__beta(args: {}): Promise<CallToolResult<{}>>; };"
    ));
}

#[test]
fn code_mode_only_description_omits_empty_namespace_sections() {
    let namespace_descriptions = BTreeMap::from([(
        "mcp__sample__".to_string(),
        ToolNamespaceDescription {
            name: "mcp__sample".to_string(),
            description: String::new(),
        },
    )]);
    let description = build_exec_tool_description(
        &[ToolDefinition {
            name: "mcp__sample__alpha".to_string(),
            tool_name: ToolName::namespaced("mcp__sample__", "alpha"),
            description: "First tool".to_string(),
            kind: CodeModeToolKind::Function,
            input_schema: Some(json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            })),
            output_schema: Some(mcp_call_tool_result_schema(&json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }))),
        }],
        &[],
        &namespace_descriptions,
        code_mode_protocol::DEFAULT_EXEC_YIELD_TIME_MS,
        /*code_mode_only*/ true,
    );

    assert!(!description.contains("## mcp__sample"));
    assert!(description.contains("### `mcp__sample__alpha`"));
}

#[test]
fn code_mode_only_description_renders_shared_mcp_types_once() {
    let first_tool = augment_tool_definition(ToolDefinition {
        name: "mcp__sample__alpha".to_string(),
        tool_name: ToolName::namespaced("mcp__sample__", "alpha"),
        description: "First tool".to_string(),
        kind: CodeModeToolKind::Function,
        input_schema: Some(json!({
            "type": "object",
            "properties": {},
            "additionalProperties": false
        })),
        output_schema: Some(json!({
            "type": "object",
            "properties": {
                "content": {
                    "type": "array",
                    "items": {
                        "type": "object"
                    }
                },
                "structuredContent": {
                    "type": "object",
                    "properties": {
                        "echo": { "type": "string" }
                    },
                    "required": ["echo"],
                    "additionalProperties": false
                },
                "isError": { "type": "boolean" },
                "_meta": { "type": "object" }
            },
            "required": ["content"],
            "additionalProperties": false
        })),
    });
    let second_tool = augment_tool_definition(ToolDefinition {
        name: "mcp__sample__beta".to_string(),
        tool_name: ToolName::namespaced("mcp__sample__", "beta"),
        description: "Second tool".to_string(),
        kind: CodeModeToolKind::Function,
        input_schema: Some(json!({
            "type": "object",
            "properties": {},
            "additionalProperties": false
        })),
        output_schema: Some(json!({
            "type": "object",
            "properties": {
                "content": {
                    "type": "array",
                    "items": {
                        "type": "object"
                    }
                },
                "structuredContent": {
                    "type": "object",
                    "properties": {
                        "count": { "type": "integer" }
                    },
                    "required": ["count"],
                    "additionalProperties": false
                },
                "isError": { "type": "boolean" },
                "_meta": { "type": "object" }
            },
            "required": ["content"],
            "additionalProperties": false
        })),
    });

    let description = build_exec_tool_description(
        &[
            ToolDefinition {
                name: first_tool.name,
                tool_name: first_tool.tool_name,
                description: "First tool".to_string(),
                kind: first_tool.kind,
                input_schema: first_tool.input_schema,
                output_schema: first_tool.output_schema,
            },
            ToolDefinition {
                name: second_tool.name,
                tool_name: second_tool.tool_name,
                description: "Second tool".to_string(),
                kind: second_tool.kind,
                input_schema: second_tool.input_schema,
                output_schema: second_tool.output_schema,
            },
        ],
        &[],
        &BTreeMap::new(),
        code_mode_protocol::DEFAULT_EXEC_YIELD_TIME_MS,
        /*code_mode_only*/ true,
    );

    assert_eq!(
        description
            .matches("type CallToolResult<TStructured = { [key: string]: unknown }>")
            .count(),
        1
    );
    assert_eq!(description.matches("Shared MCP Types:").count(), 1);
}

#[test]
fn code_mode_only_description_renders_shared_mcp_types_for_deferred_tools() {
    let deferred_tool = ToolDefinition {
        name: "mcp__sample__alpha".to_string(),
        tool_name: ToolName::namespaced("mcp__sample__", "alpha"),
        description: "Deferred tool".to_string(),
        kind: CodeModeToolKind::Function,
        input_schema: Some(json!({
            "type": "object",
            "properties": {},
            "additionalProperties": false
        })),
        output_schema: Some(mcp_call_tool_result_schema(&json!({
            "type": "object",
            "properties": {},
            "additionalProperties": false
        }))),
    };

    let description = build_exec_tool_description(
        &[],
        &[deferred_tool],
        &BTreeMap::new(),
        code_mode_protocol::DEFAULT_EXEC_YIELD_TIME_MS,
        /*code_mode_only*/ true,
    );

    assert!(description.contains("Some deferred nested tools may be omitted"));
    assert!(description.contains("Shared MCP Types:"));
    assert!(!description.contains("### `mcp__sample__alpha`"));
}

#[test]
fn exec_description_mentions_deferred_nested_tools_when_available() {
    let description = build_exec_tool_description(
        &[],
        &[ToolDefinition {
            name: "deferred_tool".to_string(),
            tool_name: ToolName::plain("deferred_tool"),
            description: "Deferred tool".to_string(),
            kind: CodeModeToolKind::Function,
            input_schema: None,
            output_schema: None,
        }],
        &BTreeMap::new(),
        code_mode_protocol::DEFAULT_EXEC_YIELD_TIME_MS,
        /*code_mode_only*/ false,
    );

    assert!(description.contains("Some deferred nested tools may be omitted"));
    assert!(description.contains("filter `ALL_TOOLS` by `name` and `description`"));
    assert!(!description.contains("do not print the full `ALL_TOOLS` array"));
}
