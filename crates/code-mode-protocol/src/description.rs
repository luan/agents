use crate::ToolName;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value as JsonValue;
use std::collections::BTreeMap;

use crate::PUBLIC_TOOL_NAME;

const MAX_JS_SAFE_INTEGER: u64 = (1_u64 << 53) - 1;
const DEFERRED_NESTED_TOOLS_GUIDANCE: &str = r"Some deferred nested tools may be omitted from this description. They are still available on the global `tools` object and listed in `ALL_TOOLS`.
To find one, filter `ALL_TOOLS` by `name` and `description`.";
const EXEC_DESCRIPTION_TEMPLATE: &str = r#"Run JavaScript code to orchestrate/compose tool calls
- Evaluates the provided JavaScript code in a fresh V8 isolate as an async module.
- All nested tools are available on the global `tools` object, for example `await tools.exec_command(...)`. Tool names are exposed as normalized JavaScript identifiers, for example `await tools.mcp__ologs__get_profile(...)`.
- Nested tool methods take either a string or an object as their input argument.
- Nested tools return either an object or a string, based on the description.
- Runs raw JavaScript -- no Node, no file system, no network access, no console.
- Accepts raw JavaScript source text, not JSON, quoted strings, or markdown code fences.
- You may optionally start the tool input with a first-line pragma like `// @exec: {"yield_time_ms": 10000, "max_output_tokens": 1000}`.
- `yield_time_ms` asks `exec` to yield early if the script is still running. Defaults to 10000 ms.
- `max_output_tokens` sets the token budget for direct `exec` results. Defaults to 10000 tokens.
- When the JS code is fully evaluated, the isolate's lifetime ends and unawaited promises are silently discarded.

- Global helpers:
- `exit()`: Immediately ends the current script successfully (like an early return from the top level).
- `text(value: string | number | boolean | undefined | null)`: Appends a text item. Non-string values are stringified with `JSON.stringify(...)` when possible.
- `image(imageUrlOrItem: string | { image_url: string; detail?: "auto" | "low" | "high" | "original" | null } | ImageContent, detail?: "auto" | "low" | "high" | "original" | null)`: Appends an image item. `image_url` should be a base64-encoded `data:` URL. To forward an MCP tool image, pass an individual `ImageContent` block from `result.content`, for example `image(result.content[0])`. MCP image blocks may request detail with `_meta: { "codex/imageDetail": "original" }`. When provided, the second `detail` argument overrides any detail embedded in the first argument.
- `audio(audioUrlOrItem: string | { audio_url: string } | AudioContent)`: Appends an audio item. `audio_url` should be a base64-encoded `data:` URL. To forward an MCP tool audio block, pass an individual `AudioContent` block from `result.content`, for example `audio(result.content[0])`.
- `generatedImage(result: { image_url: string; output_hint?: string })`: Appends an image-generation result and its optional output hint. HTTP(S) URLs are not supported.
- `store(key: string, value: any)`: stores a serializable value under a string key for later `exec` calls in the same session.
- `load(key: string)`: returns the stored value for a string key, or `undefined` if it is missing.
- `notify(value: string | number | boolean | undefined | null)`: immediately injects an extra `custom_tool_call_output` for the current `exec` call. Values are stringified like `text(...)`.
- `setTimeout(callback: () => void, delayMs?: number)`: schedules a callback to run later and returns a timeout id. Pending timeouts do not keep `exec` alive by themselves; await an explicit promise if you need to wait for one.
- `clearTimeout(timeoutId?: number)`: cancels a timeout created by `setTimeout`.
- `ALL_TOOLS`: metadata for the enabled nested tools as `{ name, description }` entries.
- `yield_control()`: yields the accumulated output to the model immediately while the script keeps running."#;
const WAIT_DESCRIPTION_TEMPLATE: &str = r"- Use `wait` only after `exec` returns `Script running with cell ID ...`.
- `cell_id` identifies the running `exec` cell to resume.
- `yield_time_ms` controls how long to wait for more output before yielding again. Defaults to 10000 ms.
- `max_tokens` limits how much new output this wait call returns. Defaults to 10000 tokens.
- `terminate: true` stops the running cell; false or omitted waits for output.
- `wait` returns only the new output since the last yield, or the final completion or termination result for that cell.
- If the cell is still running, `wait` may yield again with the same `cell_id`.
- If the cell has already finished, `wait` returns the completed result and closes the cell.";
// Based off of https://modelcontextprotocol.io/specification/draft/schema#calltoolresult
const MCP_TYPESCRIPT_PREAMBLE: &str = r#"type Role = "user" | "assistant";
type MetaObject = Record<string, unknown>;
type Annotations = {
  audience?: Role[];
  priority?: number;
  lastModified?: string;
};
type Icon = {
  src: string;
  mimeType?: string;
  sizes?: string[];
  theme?: "light" | "dark";
};
type TextResourceContents = {
  uri: string;
  mimeType?: string;
  _meta?: MetaObject;
  text: string;
};
type BlobResourceContents = {
  uri: string;
  mimeType?: string;
  _meta?: MetaObject;
  blob: string;
};
type TextContent = {
  type: "text";
  text: string;
  annotations?: Annotations;
  _meta?: MetaObject;
};
type ImageContent = {
  type: "image";
  data: string;
  mimeType: string;
  annotations?: Annotations;
  _meta?: MetaObject;
};
type AudioContent = {
  type: "audio";
  data: string;
  mimeType: string;
  annotations?: Annotations;
  _meta?: MetaObject;
};
type ResourceLink = {
  icons?: Icon[];
  name: string;
  title?: string;
  uri: string;
  description?: string;
  mimeType?: string;
  annotations?: Annotations;
  size?: number;
  _meta?: MetaObject;
  type: "resource_link";
};
type EmbeddedResource = {
  type: "resource";
  resource: TextResourceContents | BlobResourceContents;
  annotations?: Annotations;
  _meta?: MetaObject;
};
type ContentBlock =
  | TextContent
  | ImageContent
  | AudioContent
  | ResourceLink
  | EmbeddedResource;
type CallToolResult<TStructured = { [key: string]: unknown }> = {
  _meta?: MetaObject;
  content: ContentBlock[];
  isError?: boolean;
  structuredContent?: TStructured;
  [key: string]: unknown;
};"#;

pub const CODE_MODE_PRAGMA_PREFIX: &str = "// @exec:";

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CodeModeToolKind {
    Function,
    Freeform,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ToolDefinition {
    pub name: String,
    pub tool_name: ToolName,
    pub description: String,
    pub kind: CodeModeToolKind,
    pub input_schema: Option<JsonValue>,
    pub output_schema: Option<JsonValue>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolNamespaceDescription {
    pub name: String,
    pub description: String,
}

#[derive(Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct CodeModeExecPragma {
    #[serde(default)]
    yield_time_ms: Option<u64>,
    #[serde(default)]
    max_output_tokens: Option<usize>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct ParsedExecSource {
    pub code: String,
    pub yield_time_ms: Option<u64>,
    pub max_output_tokens: Option<usize>,
}

pub fn parse_exec_source(input: &str) -> Result<ParsedExecSource, String> {
    if input.trim().is_empty() {
        return Err(
            "exec expects raw JavaScript source text (non-empty). Provide JS only, optionally with first-line `// @exec: {\"yield_time_ms\": 10000, \"max_output_tokens\": 1000}`.".to_string(),
        );
    }

    let mut args = ParsedExecSource {
        code: input.to_string(),
        yield_time_ms: None,
        max_output_tokens: None,
    };

    let mut lines = input.splitn(2, '\n');
    let first_line = lines.next().unwrap_or_default();
    let rest = lines.next().unwrap_or_default();
    let trimmed = first_line.trim_start();
    let Some(pragma) = trimmed.strip_prefix(CODE_MODE_PRAGMA_PREFIX) else {
        return Ok(args);
    };

    if rest.trim().is_empty() {
        return Err(
            "exec pragma must be followed by JavaScript source on subsequent lines".to_string(),
        );
    }

    let directive = pragma.trim();
    if directive.is_empty() {
        return Err(
            "exec pragma must be a JSON object with supported fields `yield_time_ms` and `max_output_tokens`"
                .to_string(),
        );
    }

    let value: serde_json::Value = serde_json::from_str(directive).map_err(|err| {
        format!(
            "exec pragma must be valid JSON with supported fields `yield_time_ms` and `max_output_tokens`: {err}"
        )
    })?;
    let object = value.as_object().ok_or_else(|| {
        "exec pragma must be a JSON object with supported fields `yield_time_ms` and `max_output_tokens`"
            .to_string()
    })?;
    for key in object.keys() {
        match key.as_str() {
            "yield_time_ms" | "max_output_tokens" => {}
            _ => {
                return Err(format!(
                    "exec pragma only supports `yield_time_ms` and `max_output_tokens`; got `{key}`"
                ));
            }
        }
    }

    let pragma: CodeModeExecPragma = serde_json::from_value(value).map_err(|err| {
        format!(
            "exec pragma fields `yield_time_ms` and `max_output_tokens` must be non-negative safe integers: {err}"
        )
    })?;
    if pragma
        .yield_time_ms
        .is_some_and(|yield_time_ms| yield_time_ms > MAX_JS_SAFE_INTEGER)
    {
        return Err(
            "exec pragma field `yield_time_ms` must be a non-negative safe integer".to_string(),
        );
    }
    if pragma.max_output_tokens.is_some_and(|max_output_tokens| {
        u64::try_from(max_output_tokens).map_or(true, |max_output_tokens| {
            max_output_tokens > MAX_JS_SAFE_INTEGER
        })
    }) {
        return Err(
            "exec pragma field `max_output_tokens` must be a non-negative safe integer".to_string(),
        );
    }

    args.code = rest.to_string();
    args.yield_time_ms = pragma.yield_time_ms;
    args.max_output_tokens = pragma.max_output_tokens;
    Ok(args)
}

pub fn is_code_mode_nested_tool(tool_name: &str) -> bool {
    tool_name != crate::PUBLIC_TOOL_NAME && tool_name != crate::WAIT_TOOL_NAME
}

pub fn build_exec_tool_description(
    enabled_tools: &[ToolDefinition],
    deferred_tools: &[ToolDefinition],
    namespace_descriptions: &BTreeMap<String, ToolNamespaceDescription>,
    default_exec_yield_time_ms: u64,
    code_mode_only: bool,
) -> String {
    let mut sections = Vec::new();
    sections.push(EXEC_DESCRIPTION_TEMPLATE.replace(
        "Defaults to 10000 ms.",
        &format!("Defaults to {default_exec_yield_time_ms} ms."),
    ));
    if !deferred_tools.is_empty() {
        sections.push(DEFERRED_NESTED_TOOLS_GUIDANCE.to_string());
    }
    if !code_mode_only {
        return sections.join("\n\n");
    }

    let has_mcp_tools = enabled_tools
        .iter()
        .chain(deferred_tools)
        .any(|tool| mcp_structured_content_schema(tool.output_schema.as_ref()).is_some());
    if has_mcp_tools {
        sections.push(format!(
            "Shared MCP Types:\n```ts\n{MCP_TYPESCRIPT_PREAMBLE}\n```"
        ));
    }

    if !enabled_tools.is_empty() {
        let mut current_namespace: Option<&str> = None;
        let mut nested_tool_sections = Vec::with_capacity(enabled_tools.len());

        for tool in enabled_tools {
            let name = tool.name.as_str();
            let nested_description = render_code_mode_sample_for_definition(tool);
            let namespace_description = tool
                .tool_name
                .namespace
                .as_ref()
                .and_then(|namespace| namespace_descriptions.get(namespace));
            let next_namespace = namespace_description
                .map(|namespace_description| namespace_description.name.as_str());
            if next_namespace != current_namespace {
                if let Some(namespace_description) = namespace_description {
                    let namespace_description_text = namespace_description.description.trim();
                    if !namespace_description_text.is_empty() {
                        nested_tool_sections.push(format!(
                            "## {}\n{namespace_description_text}",
                            namespace_description.name
                        ));
                    }
                }
                current_namespace = next_namespace;
            }

            let global_name = normalize_code_mode_identifier(name);
            let nested_description = nested_description.trim();
            if nested_description.is_empty() {
                nested_tool_sections.push(render_tool_heading(&global_name, name));
            } else {
                nested_tool_sections.push(format!(
                    "{}\n{nested_description}",
                    render_tool_heading(&global_name, name)
                ));
            }
        }

        let nested_tool_reference = nested_tool_sections.join("\n\n");
        sections.push(nested_tool_reference);
    }

    sections.join("\n\n")
}

pub fn build_wait_tool_description() -> &'static str {
    WAIT_DESCRIPTION_TEMPLATE
}

pub fn normalize_code_mode_identifier(tool_key: &str) -> String {
    let mut identifier = String::new();

    for (index, ch) in tool_key.chars().enumerate() {
        let is_valid = if index == 0 {
            ch == '_' || ch == '$' || ch.is_ascii_alphabetic()
        } else {
            ch == '_' || ch == '$' || ch.is_ascii_alphanumeric()
        };

        if is_valid {
            identifier.push(ch);
        } else {
            identifier.push('_');
        }
    }

    if identifier.is_empty() {
        "_".to_string()
    } else {
        identifier
    }
}

pub fn augment_tool_definition(mut definition: ToolDefinition) -> ToolDefinition {
    if definition.name != PUBLIC_TOOL_NAME {
        definition.description = render_code_mode_sample_for_definition(&definition);
    }
    definition
}

pub fn enabled_tool_metadata(definition: &ToolDefinition) -> EnabledToolMetadata {
    EnabledToolMetadata {
        tool_name: definition.tool_name.clone(),
        global_name: normalize_code_mode_identifier(&definition.name),
        description: definition.description.clone(),
        kind: definition.kind,
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct EnabledToolMetadata {
    pub tool_name: ToolName,
    pub global_name: String,
    pub description: String,
    pub kind: CodeModeToolKind,
}

pub fn render_code_mode_sample(
    description: &str,
    tool_name: &str,
    input_name: &str,
    input_type: &str,
    output_type: &str,
) -> String {
    let declaration = format!(
        "declare const tools: {{ {} }};",
        render_code_mode_tool_declaration(tool_name, input_name, input_type, output_type)
    );
    format!("{description}\n\nexec tool declaration:\n```ts\n{declaration}\n```")
}

fn render_code_mode_sample_for_definition(definition: &ToolDefinition) -> String {
    let input_name = match definition.kind {
        CodeModeToolKind::Function => "args",
        CodeModeToolKind::Freeform => "input",
    };
    let input_type = match definition.kind {
        CodeModeToolKind::Function => definition
            .input_schema
            .as_ref()
            .map_or_else(|| "unknown".to_string(), render_json_schema_to_typescript),
        CodeModeToolKind::Freeform => "string".to_string(),
    };
    let output_type = if let Some(structured_content_schema) =
        mcp_structured_content_schema(definition.output_schema.as_ref())
    {
        let structured_content_type = render_json_schema_to_typescript(structured_content_schema);
        if structured_content_type == "unknown" {
            "CallToolResult".to_string()
        } else {
            format!("CallToolResult<{structured_content_type}>")
        }
    } else {
        definition
            .output_schema
            .as_ref()
            .map_or_else(|| "unknown".to_string(), render_json_schema_to_typescript)
    };
    render_code_mode_sample(
        &definition.description,
        &definition.name,
        input_name,
        &input_type,
        &output_type,
    )
}

fn render_code_mode_tool_declaration(
    tool_name: &str,
    input_name: &str,
    input_type: &str,
    output_type: &str,
) -> String {
    let tool_name = normalize_code_mode_identifier(tool_name);
    format!("{tool_name}({input_name}: {input_type}): Promise<{output_type}>;")
}

fn render_tool_heading(global_name: &str, raw_name: &str) -> String {
    if global_name == raw_name {
        format!("### `{global_name}`")
    } else {
        format!("### `{global_name}` (`{raw_name}`)")
    }
}

pub fn render_json_schema_to_typescript(schema: &JsonValue) -> String {
    render_json_schema_to_typescript_inner(schema)
}

fn mcp_structured_content_schema(output_schema: Option<&JsonValue>) -> Option<&JsonValue> {
    let output_schema = output_schema?;
    let properties = output_schema
        .get("properties")
        .and_then(JsonValue::as_object)?;
    let content_schema = properties.get("content").and_then(JsonValue::as_object)?;
    if content_schema.get("type").and_then(JsonValue::as_str) != Some("array") {
        return None;
    }

    if content_schema
        .get("items")
        .and_then(JsonValue::as_object)
        .is_none_or(|items| items.get("type").and_then(JsonValue::as_str) != Some("object"))
    {
        return None;
    }

    if properties
        .get("isError")
        .and_then(JsonValue::as_object)
        .is_none_or(|schema| schema.get("type").and_then(JsonValue::as_str) != Some("boolean"))
    {
        return None;
    }

    if properties
        .get("_meta")
        .and_then(JsonValue::as_object)
        .is_none_or(|schema| schema.get("type").and_then(JsonValue::as_str) != Some("object"))
    {
        return None;
    }

    Some(
        properties
            .get("structuredContent")
            .unwrap_or(&JsonValue::Bool(true)),
    )
}

fn render_json_schema_to_typescript_inner(schema: &JsonValue) -> String {
    match schema {
        JsonValue::Bool(false) => "never".to_string(),
        JsonValue::Object(map) => {
            if let Some(value) = map.get("const") {
                return render_json_schema_literal(value);
            }

            if let Some(values) = map.get("enum").and_then(JsonValue::as_array) {
                let rendered = values
                    .iter()
                    .map(render_json_schema_literal)
                    .collect::<Vec<_>>();
                if !rendered.is_empty() {
                    return rendered.join(" | ");
                }
            }

            for key in ["anyOf", "oneOf"] {
                if let Some(variants) = map.get(key).and_then(JsonValue::as_array) {
                    let rendered = variants
                        .iter()
                        .map(render_json_schema_to_typescript_inner)
                        .collect::<Vec<_>>();
                    if !rendered.is_empty() {
                        return rendered.join(" | ");
                    }
                }
            }

            if let Some(variants) = map.get("allOf").and_then(JsonValue::as_array) {
                let rendered = variants
                    .iter()
                    .map(render_json_schema_to_typescript_inner)
                    .collect::<Vec<_>>();
                if !rendered.is_empty() {
                    return rendered.join(" & ");
                }
            }

            if let Some(schema_type) = map.get("type") {
                if let Some(types) = schema_type.as_array() {
                    let rendered = types
                        .iter()
                        .filter_map(JsonValue::as_str)
                        .map(|schema_type| render_json_schema_type_keyword(map, schema_type))
                        .collect::<Vec<_>>();
                    if !rendered.is_empty() {
                        return rendered.join(" | ");
                    }
                }

                if let Some(schema_type) = schema_type.as_str() {
                    return render_json_schema_type_keyword(map, schema_type);
                }
            }

            if map.contains_key("properties")
                || map.contains_key("additionalProperties")
                || map.contains_key("required")
            {
                return render_json_schema_object(map);
            }

            if map.contains_key("items") || map.contains_key("prefixItems") {
                return render_json_schema_array(map);
            }

            "unknown".to_string()
        }
        _ => "unknown".to_string(),
    }
}

fn render_json_schema_type_keyword(
    map: &serde_json::Map<String, JsonValue>,
    schema_type: &str,
) -> String {
    match schema_type {
        "string" => "string".to_string(),
        "number" | "integer" => "number".to_string(),
        "boolean" => "boolean".to_string(),
        "null" => "null".to_string(),
        "array" => render_json_schema_array(map),
        "object" => render_json_schema_object(map),
        _ => "unknown".to_string(),
    }
}

fn render_json_schema_array(map: &serde_json::Map<String, JsonValue>) -> String {
    if let Some(items) = map.get("items") {
        let item_type = render_json_schema_to_typescript_inner(items);
        return format!("Array<{item_type}>");
    }

    if let Some(items) = map.get("prefixItems").and_then(JsonValue::as_array) {
        let item_types = items
            .iter()
            .map(render_json_schema_to_typescript_inner)
            .collect::<Vec<_>>();
        if !item_types.is_empty() {
            return format!("[{}]", item_types.join(", "));
        }
    }

    "unknown[]".to_string()
}

fn append_additional_properties_line(
    lines: &mut Vec<String>,
    map: &serde_json::Map<String, JsonValue>,
    properties: &serde_json::Map<String, JsonValue>,
    line_prefix: &str,
) {
    if let Some(additional_properties) = map.get("additionalProperties") {
        let property_type = match additional_properties {
            JsonValue::Bool(true) => Some("unknown".to_string()),
            JsonValue::Bool(false) => None,
            value => Some(render_json_schema_to_typescript_inner(value)),
        };

        if let Some(property_type) = property_type {
            lines.push(format!("{line_prefix}[key: string]: {property_type};"));
        }
    } else if properties.is_empty() {
        lines.push(format!("{line_prefix}[key: string]: unknown;"));
    }
}

fn has_property_description(value: &JsonValue) -> bool {
    value
        .get("description")
        .and_then(JsonValue::as_str)
        .is_some_and(|description| !description.is_empty())
}

fn render_json_schema_object_property(name: &str, value: &JsonValue, required: &[&str]) -> String {
    let optional = if required.iter().any(|required_name| required_name == &name) {
        ""
    } else {
        "?"
    };
    let property_name = render_json_schema_property_name(name);
    let property_type = render_json_schema_to_typescript_inner(value);
    format!("{property_name}{optional}: {property_type};")
}

fn render_json_schema_object(map: &serde_json::Map<String, JsonValue>) -> String {
    let required = map
        .get("required")
        .and_then(JsonValue::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(JsonValue::as_str)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let properties = map
        .get("properties")
        .and_then(JsonValue::as_object)
        .cloned()
        .unwrap_or_default();

    let mut sorted_properties = properties.iter().collect::<Vec<_>>();
    sorted_properties.sort_unstable_by_key(|(name_a, _)| *name_a);
    if sorted_properties
        .iter()
        .any(|(_, value)| has_property_description(value))
    {
        let mut lines = vec!["{".to_string()];
        for (name, value) in sorted_properties {
            if let Some(description) = value.get("description").and_then(JsonValue::as_str) {
                for description_line in description
                    .lines()
                    .map(str::trim)
                    .filter(|line| !line.is_empty())
                {
                    lines.push(format!("  // {description_line}"));
                }
            }

            lines.push(format!(
                "  {}",
                render_json_schema_object_property(name, value, &required)
            ));
        }

        append_additional_properties_line(&mut lines, map, &properties, "  ");
        lines.push("}".to_string());
        return lines.join("\n");
    }

    let mut lines = sorted_properties
        .into_iter()
        .map(|(name, value)| render_json_schema_object_property(name, value, &required))
        .collect::<Vec<_>>();

    append_additional_properties_line(&mut lines, map, &properties, "");

    if lines.is_empty() {
        return "{}".to_string();
    }

    format!("{{ {} }}", lines.join(" "))
}

fn render_json_schema_property_name(name: &str) -> String {
    if normalize_code_mode_identifier(name) == name {
        name.to_string()
    } else {
        serde_json::to_string(name).unwrap_or_else(|_| format!("\"{}\"", name.replace('"', "\\\"")))
    }
}

fn render_json_schema_literal(value: &JsonValue) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "unknown".to_string())
}
