use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::json;

use super::contract::{LensEnvelope, LensMessage};
use super::store::LensStore;
use super::types::ReadCoverageRange;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiscoveryIntent {
    Symbol,
    Text,
    Path,
    SourceContext,
    Ast,
    Lsp,
}

impl DiscoveryIntent {
    pub fn parse(value: &str) -> Result<Self, Box<dyn std::error::Error>> {
        match value {
            "symbol" | "name" | "symbol_name" => Ok(Self::Symbol),
            "text" | "text_path" | "text/path" => Ok(Self::Text),
            "path" | "file" => Ok(Self::Path),
            "source" | "source_context" | "source-context" | "context" => Ok(Self::SourceContext),
            "ast" | "ast_pattern" | "ast-pattern" => Ok(Self::Ast),
            "lsp" | "language_server" | "language-server" => Ok(Self::Lsp),
            other => Err(format!(
                "invalid discovery intent: {other} (expected symbol, text, path, source-context, ast, or lsp)"
            )
            .into()),
        }
    }

    fn as_str(&self) -> &'static str {
        match self {
            Self::Symbol => "symbol",
            Self::Text => "text",
            Self::Path => "path",
            Self::SourceContext => "source_context",
            Self::Ast => "ast",
            Self::Lsp => "lsp",
        }
    }
}

#[derive(Debug, Clone)]
pub struct DiscoveryOptions {
    pub cwd: PathBuf,
    pub intent: DiscoveryIntent,
    pub query: Option<String>,
    pub path: Option<String>,
    pub line: Option<usize>,
    pub end_line: Option<usize>,
    pub character: Option<usize>,
    pub lang: Option<String>,
    pub limit: usize,
    pub context: usize,
    pub session: Option<String>,
    pub include_debug: bool,
    pub include_raw: bool,
    pub lsp_operation: Option<String>,
}

impl DiscoveryOptions {
    pub fn new(cwd: PathBuf, intent: DiscoveryIntent) -> Self {
        Self {
            cwd,
            intent,
            query: None,
            path: None,
            line: None,
            end_line: None,
            character: None,
            lang: None,
            limit: 10,
            context: 2,
            session: None,
            include_debug: false,
            include_raw: false,
            lsp_operation: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiscoveryData {
    pub route: DiscoveryRoute,
    pub items: Vec<DiscoveryItem>,
    pub item_count: usize,
    pub alternatives: Vec<DiscoveryAlternative>,
    pub next_actions: Vec<DiscoveryNextAction>,
    pub coverage: Vec<DiscoveryCoverage>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiscoveryRoute {
    pub intent: String,
    pub backend: String,
    pub explanation: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiscoveryItem {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symbol_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_line: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_line: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiscoveryAlternative {
    pub reason: String,
    pub item: DiscoveryItem,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiscoveryNextAction {
    pub label: String,
    pub command: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiscoveryCoverage {
    pub path: String,
    pub range: ReadCoverageRange,
    pub source: String,
}

pub fn build_discovery_envelope(
    options: DiscoveryOptions,
) -> Result<LensEnvelope<DiscoveryData>, Box<dyn std::error::Error>> {
    let root = options.cwd.canonicalize()?;
    let mut warnings = Vec::new();
    let mut raw = None;

    let (route, mut items, backend_raw) = match route_backend(&options) {
        DiscoveryBackend::SymSymbol => discover_symbols(&root, &options)?,
        DiscoveryBackend::SymText => discover_text(&root, &options)?,
        DiscoveryBackend::Source => discover_source_context(&root, &options)?,
        DiscoveryBackend::Ast => discover_ast(&root, &options, &mut warnings)?,
        DiscoveryBackend::Lsp => discover_lsp(&root, &options, &mut warnings)?,
    };
    if options.include_raw {
        raw = backend_raw;
    }

    let alternatives = ambiguity_alternatives(&items);
    if !alternatives.is_empty() {
        warnings.push(LensMessage::warning_with_hint(
            "ambiguous_results",
            format!("{} possible results matched", items.len()),
            "Use a path, parent, or source-context intent to disambiguate.",
        ));
    }
    if items.is_empty() && warnings.is_empty() {
        warnings.push(LensMessage::warning_with_hint(
            "no_results",
            "Discovery completed but returned no results.",
            "Try a broader text query or a more specific path.",
        ));
    }

    let coverage = record_coverage(&root, &options, &items, &mut warnings)?;
    let next_actions = next_actions(&options, &items, &route);
    let data = DiscoveryData {
        route,
        item_count: items.len(),
        items: std::mem::take(&mut items),
        alternatives,
        next_actions,
        coverage,
    };

    let mut envelope = if warnings.is_empty() {
        LensEnvelope::ok(data)
    } else {
        LensEnvelope::warning(data, warnings)
    };
    if options.include_debug {
        envelope = envelope.with_debug(json!({
            "intent": options.intent.as_str(),
            "limit": effective_limit(&options),
            "context": options.context,
            "has_query": options.query.is_some(),
            "has_path": options.path.is_some(),
            "lsp_operation": options.lsp_operation,
        }));
    }
    if let Some(raw) = raw {
        envelope = envelope.with_raw(raw);
    }
    Ok(envelope)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DiscoveryBackend {
    SymSymbol,
    SymText,
    Source,
    Ast,
    Lsp,
}

fn route_backend(options: &DiscoveryOptions) -> DiscoveryBackend {
    match options.intent {
        DiscoveryIntent::Symbol => DiscoveryBackend::SymSymbol,
        DiscoveryIntent::Text => {
            if options.lang.is_some()
                && options.query.as_deref().is_some_and(looks_like_ast_pattern)
            {
                DiscoveryBackend::Ast
            } else {
                DiscoveryBackend::SymText
            }
        }
        DiscoveryIntent::Path | DiscoveryIntent::SourceContext => {
            if options.lsp_operation.is_some() || options.character.is_some() {
                DiscoveryBackend::Lsp
            } else {
                DiscoveryBackend::Source
            }
        }
        DiscoveryIntent::Ast => DiscoveryBackend::Ast,
        DiscoveryIntent::Lsp => DiscoveryBackend::Lsp,
    }
}

fn discover_symbols(
    root: &Path,
    options: &DiscoveryOptions,
) -> Result<
    (
        DiscoveryRoute,
        Vec<DiscoveryItem>,
        Option<serde_json::Value>,
    ),
    Box<dyn std::error::Error>,
> {
    let query = required_query(options)?;
    let includes = path_filters(options);
    let results = sym::search::search_symbols(
        root,
        query,
        &sym::search::SymbolSearchOptions {
            kind: None,
            lang: options.lang.as_deref(),
            limit: effective_limit(options),
            exact: false,
            ignore_case: false,
            includes: &includes,
            excludes: &[],
        },
    )?;
    let items = results
        .iter()
        .map(|symbol| DiscoveryItem {
            kind: "symbol".to_string(),
            path: Some(relative_path(root, &symbol.rel_path)),
            name: Some(symbol.name.clone()),
            symbol_kind: Some(symbol.kind.clone()),
            language: Some(symbol.language.clone()),
            start_line: Some(symbol.start_line as i64),
            end_line: Some(symbol.end_line as i64),
            snippet: non_empty(symbol.signature.clone()),
            summary: format!(
                "{} {} in {}:{}-{}",
                symbol.kind, symbol.name, symbol.rel_path, symbol.start_line, symbol.end_line
            ),
        })
        .collect();
    Ok((
        DiscoveryRoute {
            intent: options.intent.as_str().to_string(),
            backend: "sym".to_string(),
            explanation: "Symbol/name intent uses the sym index for ranked symbol lookup."
                .to_string(),
        },
        items,
        Some(json!({ "symbols": results })),
    ))
}

fn discover_text(
    root: &Path,
    options: &DiscoveryOptions,
) -> Result<
    (
        DiscoveryRoute,
        Vec<DiscoveryItem>,
        Option<serde_json::Value>,
    ),
    Box<dyn std::error::Error>,
> {
    let query = required_query(options)?;
    let includes = path_filters(options);
    let results = sym::search::search_text(
        root,
        query,
        options.lang.as_deref(),
        effective_limit(options),
        &includes,
        &[],
        false,
    )?;
    let items = results
        .iter()
        .map(|hit| DiscoveryItem {
            kind: "text_match".to_string(),
            path: Some(relative_path(root, &hit.rel_path)),
            name: None,
            symbol_kind: None,
            language: options.lang.clone(),
            start_line: Some(hit.line as i64),
            end_line: Some(hit.line as i64),
            snippet: Some(hit.snippet.clone()),
            summary: format!("text match in {}:{}", hit.rel_path.display(), hit.line),
        })
        .collect();
    Ok((
        DiscoveryRoute {
            intent: options.intent.as_str().to_string(),
            backend: "sym_text".to_string(),
            explanation: "Plain text/path intent uses sym's repository walker and records only hit-line coverage.".to_string(),
        },
        items,
        Some(json!({ "text_matches": results })),
    ))
}

fn discover_source_context(
    root: &Path,
    options: &DiscoveryOptions,
) -> Result<
    (
        DiscoveryRoute,
        Vec<DiscoveryItem>,
        Option<serde_json::Value>,
    ),
    Box<dyn std::error::Error>,
> {
    let path = required_path(options)?;
    let line = options.line.unwrap_or(1);
    let end_line = options.end_line.unwrap_or(line);
    let full_path = root.join(path);
    let lines = sym::show::show_file(&full_path, Some((line, end_line)), options.context)?;
    let start_line = lines
        .first()
        .map(|line| line.line as i64)
        .unwrap_or(line as i64);
    let end_line = lines
        .last()
        .map(|line| line.line as i64)
        .unwrap_or(end_line as i64);
    let snippet = lines
        .iter()
        .map(|line| format!("{}: {}", line.line, line.content))
        .collect::<Vec<_>>()
        .join("\n");
    let rel_path = relative_path(root, path);
    let items = vec![DiscoveryItem {
        kind: "source_context".to_string(),
        path: Some(rel_path.clone()),
        name: None,
        symbol_kind: None,
        language: language_from_path(path),
        start_line: Some(start_line),
        end_line: Some(end_line),
        snippet: Some(snippet),
        summary: format!("source context in {rel_path}:{start_line}-{end_line}"),
    }];
    Ok((
        DiscoveryRoute {
            intent: options.intent.as_str().to_string(),
            backend: "source".to_string(),
            explanation:
                "Source-context intent reads the requested file range and records the shown range."
                    .to_string(),
        },
        items,
        Some(json!({ "lines": lines })),
    ))
}

fn discover_ast(
    root: &Path,
    options: &DiscoveryOptions,
    warnings: &mut Vec<LensMessage>,
) -> Result<
    (
        DiscoveryRoute,
        Vec<DiscoveryItem>,
        Option<serde_json::Value>,
    ),
    Box<dyn std::error::Error>,
> {
    let query = required_query(options)?;
    let Some(lang) = options.lang.as_deref() else {
        warnings.push(LensMessage::warning_with_hint(
            "ast_lang_required",
            "AST discovery requires a language.",
            "Pass --lang rust, --lang typescript, or another ast-grep language.",
        ));
        return Ok((ast_route(options), Vec::new(), None));
    };
    let paths = if let Some(path) = &options.path {
        vec![path.clone()]
    } else {
        vec![".".to_string()]
    };
    let raw = match crate::cli::ast::sg_search(query, lang, &paths, None, Some(options.context)) {
        Ok(raw) => raw,
        Err(error) => {
            warnings.push(LensMessage::warning_with_hint(
                "ast_backend_unavailable",
                format!("AST backend failed: {error}"),
                "Install ast-grep (sg) or retry with --intent text for plain text search.",
            ));
            return Ok((ast_route(options), Vec::new(), None));
        }
    };
    let mut items = raw
        .as_array()
        .into_iter()
        .flatten()
        .take(effective_limit(options))
        .map(|value| ast_item(root, value, lang))
        .collect::<Vec<_>>();
    if items.is_empty() && raw.is_object() {
        items.push(ast_item(root, &raw, lang));
    }
    Ok((ast_route(options), items, Some(json!({ "ast_grep": raw }))))
}

fn ast_route(options: &DiscoveryOptions) -> DiscoveryRoute {
    DiscoveryRoute {
        intent: options.intent.as_str().to_string(),
        backend: "ast".to_string(),
        explanation: "Structured AST-like patterns route to ast-grep so syntax-aware matches stay available behind Lens.".to_string(),
    }
}

fn discover_lsp(
    root: &Path,
    options: &DiscoveryOptions,
    warnings: &mut Vec<LensMessage>,
) -> Result<
    (
        DiscoveryRoute,
        Vec<DiscoveryItem>,
        Option<serde_json::Value>,
    ),
    Box<dyn std::error::Error>,
> {
    let Some(path) = options.path.as_deref() else {
        warnings.push(LensMessage::warning_with_hint(
            "lsp_path_required",
            "LSP discovery requires a file path.",
            "Pass --path with a source file that has a registered language server.",
        ));
        return Ok((lsp_route(options), Vec::new(), None));
    };
    let full_path = root.join(path);
    let Some(probe) = crate::lsp::registry::probe_for_file(&full_path) else {
        warnings.push(LensMessage::warning(
            "lsp_server_unknown",
            "No Lens LSP server definition matched the requested file.",
        ));
        return Ok((lsp_route(options), Vec::new(), None));
    };

    let rel_path = relative_path(root, path);
    if !probe.available {
        warnings.push(LensMessage::warning_with_hint(
            "lsp_backend_unavailable",
            format!("{} is not available", probe.server.name),
            format!("Install one of: {}", probe.server.commands.join(", ")),
        ));
        let item = DiscoveryItem {
            kind: "lsp_probe".to_string(),
            path: Some(rel_path.clone()),
            name: Some(probe.server.name.to_string()),
            symbol_kind: None,
            language: Some(probe.server.language_id.to_string()),
            start_line: options.line.map(|line| line as i64),
            end_line: options.line.map(|line| line as i64),
            snippet: None,
            summary: format!("{} would handle {rel_path}", probe.server.name),
        };
        return Ok((
            lsp_route(options),
            vec![item],
            Some(json!({ "probe": probe })),
        ));
    }

    let Some(operation) = options.lsp_operation.as_deref() else {
        let item = DiscoveryItem {
            kind: "lsp_probe".to_string(),
            path: Some(rel_path.clone()),
            name: Some(probe.server.name.to_string()),
            symbol_kind: None,
            language: Some(probe.server.language_id.to_string()),
            start_line: options.line.map(|line| line as i64),
            end_line: options.line.map(|line| line as i64),
            snippet: None,
            summary: format!("{} is available for {rel_path}", probe.server.name),
        };
        return Ok((
            lsp_route(options),
            vec![item],
            Some(json!({ "probe": probe })),
        ));
    };

    let output = match run_lsp_operation(&probe, operation, &full_path, options) {
        Ok(output) => output,
        Err(error) => {
            warnings.push(LensMessage::warning(
                "lsp_request_failed",
                format!("LSP request failed: {error}"),
            ));
            return Ok((
                lsp_route(options),
                Vec::new(),
                Some(json!({ "probe": probe })),
            ));
        }
    };
    let item = DiscoveryItem {
        kind: "lsp_result".to_string(),
        path: Some(rel_path.clone()),
        name: Some(operation.to_string()),
        symbol_kind: None,
        language: Some(probe.server.language_id.to_string()),
        start_line: options.line.map(|line| line as i64),
        end_line: options.line.map(|line| line as i64),
        snippet: Some(format!("{} result(s)", output.result_count)),
        summary: format!(
            "LSP {operation} returned {} result(s) for {rel_path}",
            output.result_count
        ),
    };
    Ok((
        lsp_route(options),
        vec![item],
        Some(json!({ "probe": probe, "operation": operation, "result": output.result })),
    ))
}

fn lsp_route(options: &DiscoveryOptions) -> DiscoveryRoute {
    DiscoveryRoute {
        intent: options.intent.as_str().to_string(),
        backend: "lsp".to_string(),
        explanation: "Source-position language-server intents route to the registered LSP backend when available.".to_string(),
    }
}

fn run_lsp_operation(
    probe: &crate::lsp::registry::LspServerProbe,
    operation: &str,
    path: &Path,
    options: &DiscoveryOptions,
) -> anyhow::Result<crate::lsp::client::LspOperationResult> {
    let mut client = crate::lsp::client::LspClient::start(probe)?;
    client.initialize(probe)?;
    client.open_file(probe, path)?;
    client.run_text_operation(
        operation,
        path,
        options.line,
        options.character,
        options.query.as_deref(),
        None,
    )
}

fn record_coverage(
    root: &Path,
    options: &DiscoveryOptions,
    items: &[DiscoveryItem],
    warnings: &mut Vec<LensMessage>,
) -> Result<Vec<DiscoveryCoverage>, Box<dyn std::error::Error>> {
    let mut store = LensStore::open_for_project(root)?;
    let mut coverage = Vec::new();
    for item in items {
        let (Some(path), Some(start_line), Some(end_line)) =
            (item.path.as_deref(), item.start_line, item.end_line)
        else {
            continue;
        };
        let range = match store.record_read(
            options.session.as_deref(),
            Path::new(path),
            start_line,
            end_line,
        ) {
            Ok(range) => range,
            Err(error) => {
                warnings.push(LensMessage::warning(
                    "coverage_record_failed",
                    format!("Could not record read coverage for {path}: {error}"),
                ));
                continue;
            }
        };
        coverage.push(DiscoveryCoverage {
            path: path.to_string(),
            range,
            source: item.kind.clone(),
        });
    }
    Ok(coverage)
}

fn ambiguity_alternatives(items: &[DiscoveryItem]) -> Vec<DiscoveryAlternative> {
    if items.len() <= 1 {
        return Vec::new();
    }
    items
        .iter()
        .take(5)
        .cloned()
        .map(|item| DiscoveryAlternative {
            reason: "multiple_ranked_matches".to_string(),
            item,
        })
        .collect()
}

fn next_actions(
    options: &DiscoveryOptions,
    items: &[DiscoveryItem],
    route: &DiscoveryRoute,
) -> Vec<DiscoveryNextAction> {
    if items.is_empty() {
        return vec![DiscoveryNextAction {
            label: "broaden search".to_string(),
            command: "ct lens discover --intent text --query <broader-term> --json".to_string(),
        }];
    }

    let first = &items[0];
    let mut actions = Vec::new();
    if let (Some(path), Some(line)) = (&first.path, first.start_line) {
        actions.push(DiscoveryNextAction {
            label: "show source context".to_string(),
            command: format!(
                "ct lens discover --intent source-context --path {} --line {} --context {} --json",
                shell_word(path),
                line,
                options.context.max(2)
            ),
        });
    }
    if let Some(name) = &first.name
        && route.backend == "sym"
    {
        actions.push(DiscoveryNextAction {
            label: "find references".to_string(),
            command: format!("ct sym refs {}", shell_word(name)),
        });
    }
    if route.backend == "lsp" && first.kind == "lsp_probe" {
        actions.push(DiscoveryNextAction {
            label: "ask language server for hover".to_string(),
            command: "ct lens discover --intent source-context --path <file> --line <line> --character <character> --lsp-operation hover --json".to_string(),
        });
    }
    actions
}

fn required_query(options: &DiscoveryOptions) -> Result<&str, Box<dyn std::error::Error>> {
    options
        .query
        .as_deref()
        .filter(|query| !query.trim().is_empty())
        .ok_or_else(|| "discovery requires --query for this intent".into())
}

fn required_path(options: &DiscoveryOptions) -> Result<&str, Box<dyn std::error::Error>> {
    options
        .path
        .as_deref()
        .filter(|path| !path.trim().is_empty())
        .ok_or_else(|| "discovery requires --path for this intent".into())
}

fn path_filters(options: &DiscoveryOptions) -> Vec<String> {
    options
        .path
        .as_ref()
        .map(|path| vec![path.clone()])
        .unwrap_or_default()
}

fn effective_limit(options: &DiscoveryOptions) -> usize {
    if options.limit == 0 {
        10
    } else {
        options.limit
    }
}

fn looks_like_ast_pattern(query: &str) -> bool {
    let text = query.trim();
    text.contains('$') || text.chars().any(|ch| "{}();[]".contains(ch))
}

fn ast_item(root: &Path, value: &serde_json::Value, lang: &str) -> DiscoveryItem {
    let path = value
        .get("file")
        .or_else(|| value.get("path"))
        .and_then(serde_json::Value::as_str)
        .map(|path| relative_path(root, path));
    let start_line = json_line(value.pointer("/range/start/line"));
    let end_line = json_line(value.pointer("/range/end/line")).or(start_line);
    let snippet = value
        .get("text")
        .or_else(|| value.get("match"))
        .and_then(serde_json::Value::as_str)
        .map(|text| text.trim().to_string());
    let summary = match (&path, start_line) {
        (Some(path), Some(line)) => format!("AST match in {path}:{line}"),
        (Some(path), None) => format!("AST match in {path}"),
        (None, _) => "AST match".to_string(),
    };
    DiscoveryItem {
        kind: "ast_match".to_string(),
        path,
        name: None,
        symbol_kind: None,
        language: Some(lang.to_string()),
        start_line,
        end_line,
        snippet,
        summary,
    }
}

fn json_line(value: Option<&serde_json::Value>) -> Option<i64> {
    let line = value?.as_i64()?;
    Some(if line <= 0 { 1 } else { line })
}

fn relative_path(root: &Path, path: impl AsRef<Path>) -> String {
    let path = path.as_ref();
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    };
    absolute
        .strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .to_string()
}

fn language_from_path(path: &str) -> Option<String> {
    Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_string)
}

fn non_empty(value: String) -> Option<String> {
    (!value.trim().is_empty()).then_some(value)
}

fn shell_word(value: &str) -> String {
    if value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '/' | '.' | '_' | '-' | ':'))
    {
        value.to_string()
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn symbol_discovery_routes_to_sym_records_coverage_and_reports_ambiguity() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("a.rs"), "fn target() {}\n").unwrap();
        std::fs::write(temp.path().join("b.rs"), "fn target() {}\n").unwrap();

        let mut options = DiscoveryOptions::new(temp.path().to_path_buf(), DiscoveryIntent::Symbol);
        options.query = Some("target".to_string());
        options.session = Some("s".to_string());
        let envelope = build_discovery_envelope(options).unwrap();

        assert_eq!(envelope.data.route.backend, "sym");
        assert_eq!(envelope.data.item_count, 2);
        assert_eq!(envelope.warnings[0].code, "ambiguous_results");
        assert_eq!(envelope.data.alternatives.len(), 2);
        assert!(
            envelope
                .data
                .next_actions
                .iter()
                .any(|action| action.label == "find references")
        );
        assert!(envelope.data.items.iter().all(|item| {
            item.path
                .as_deref()
                .is_some_and(|path| !Path::new(path).is_absolute())
        }));

        let first = &envelope.data.items[0];
        let mut store = LensStore::open_for_project(temp.path()).unwrap();
        let decision = store
            .check_guard(
                Some("s"),
                Path::new(first.path.as_deref().unwrap()),
                first.start_line.unwrap(),
                first.end_line.unwrap(),
                super::super::types::GuardAction::Warn,
            )
            .unwrap();
        assert_eq!(decision.reason, super::super::types::GuardReason::Covered);
    }

    #[test]
    fn text_discovery_records_narrow_hit_and_hides_raw_debug_by_default() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(
            temp.path().join("main.rs"),
            "fn main() {\n    let needle = 1;\n}\n",
        )
        .unwrap();

        let mut options = DiscoveryOptions::new(temp.path().to_path_buf(), DiscoveryIntent::Text);
        options.query = Some("needle".to_string());
        options.session = Some("s".to_string());
        let envelope = build_discovery_envelope(options).unwrap();
        let value = serde_json::to_value(&envelope).unwrap();

        assert_eq!(envelope.data.route.backend, "sym_text");
        assert_eq!(envelope.data.coverage[0].range.start_line, 2);
        assert_eq!(envelope.data.coverage[0].range.end_line, 2);
        assert!(value.get("debug").is_none());
        assert!(value.get("raw").is_none());

        let mut store = LensStore::open_for_project(temp.path()).unwrap();
        let decision = store
            .check_guard(
                Some("s"),
                Path::new("main.rs"),
                2,
                2,
                super::super::types::GuardAction::Warn,
            )
            .unwrap();
        assert_eq!(decision.reason, super::super::types::GuardReason::Covered);
    }

    #[test]
    fn source_context_records_the_shown_range_and_generates_next_action() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("main.rs"), "one\ntwo\nthree\nfour\n").unwrap();

        let mut options =
            DiscoveryOptions::new(temp.path().to_path_buf(), DiscoveryIntent::SourceContext);
        options.path = Some("main.rs".to_string());
        options.line = Some(2);
        options.context = 1;
        options.session = Some("s".to_string());
        let envelope = build_discovery_envelope(options).unwrap();

        assert_eq!(envelope.data.route.backend, "source");
        assert_eq!(envelope.data.items[0].start_line, Some(1));
        assert_eq!(envelope.data.items[0].end_line, Some(3));
        assert!(
            envelope.data.items[0]
                .snippet
                .as_ref()
                .unwrap()
                .contains("2: two")
        );
        assert!(
            envelope.data.next_actions[0]
                .command
                .contains("source-context")
        );

        let mut store = LensStore::open_for_project(temp.path()).unwrap();
        let decision = store
            .check_guard(
                Some("s"),
                Path::new("main.rs"),
                1,
                3,
                super::super::types::GuardAction::Warn,
            )
            .unwrap();
        assert_eq!(decision.reason, super::super::types::GuardReason::Covered);
    }

    #[test]
    fn ast_and_lsp_intents_have_distinct_route_explanations_without_requiring_backends() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("main.rs"), "fn main() {}\n").unwrap();

        let mut ast = DiscoveryOptions::new(temp.path().to_path_buf(), DiscoveryIntent::Ast);
        ast.query = Some("fn $NAME()".to_string());
        ast.lang = Some("rust".to_string());
        let ast_envelope = build_discovery_envelope(ast).unwrap();
        assert_eq!(ast_envelope.data.route.backend, "ast");
        assert!(ast_envelope.data.route.explanation.contains("ast-grep"));

        let mut lsp = DiscoveryOptions::new(temp.path().to_path_buf(), DiscoveryIntent::Lsp);
        lsp.path = Some("main.rs".to_string());
        lsp.line = Some(1);
        let lsp_envelope = build_discovery_envelope(lsp).unwrap();
        assert_eq!(lsp_envelope.data.route.backend, "lsp");
        assert!(lsp_envelope.data.route.explanation.contains("LSP"));
        assert_eq!(lsp_envelope.data.items[0].path.as_deref(), Some("main.rs"));
    }

    #[test]
    fn raw_and_debug_payloads_are_opt_in() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("main.rs"), "fn main() {}\n").unwrap();

        let mut options = DiscoveryOptions::new(temp.path().to_path_buf(), DiscoveryIntent::Text);
        options.query = Some("main".to_string());
        options.include_debug = true;
        options.include_raw = true;
        let value = serde_json::to_value(build_discovery_envelope(options).unwrap()).unwrap();

        assert!(value.get("debug").is_some());
        assert!(value.get("raw").is_some());
    }
}
