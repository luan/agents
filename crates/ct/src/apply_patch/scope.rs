use std::path::Path;

use serde::Serialize;
use tree_sitter::{Language, Node, Parser};

#[derive(Debug, Clone, Serialize)]
pub struct SourceScope {
    pub name: String,
    pub kind: String,
    pub start_line: usize,
    pub end_line: usize,
}

#[derive(Debug, Clone)]
pub enum ScopeResolveError {
    NotFound,
    Ambiguous(Vec<SourceScope>),
    EmptySource,
}

struct ScopeLocator {
    kind: Option<String>,
    name: String,
}

pub fn anchor_for_locator(
    path: &str,
    source: &str,
    locator: &str,
) -> Result<(usize, String, SourceScope), ScopeResolveError> {
    let parsed = parse_locator(locator);
    let mut matches = source_scopes(path, source)
        .into_iter()
        .filter(|scope| locator_matches(scope, &parsed))
        .collect::<Vec<_>>();
    matches.sort_by_key(|scope| (scope.start_line, scope.end_line, scope.name.clone()));
    match matches.as_slice() {
        [] => Err(ScopeResolveError::NotFound),
        [scope] => {
            let line = source
                .replace("\r\n", "\n")
                .split('\n')
                .nth(scope.start_line.saturating_sub(1))
                .ok_or(ScopeResolveError::EmptySource)?
                .to_string();
            Ok((scope.start_line, line, scope.clone()))
        }
        _ => Err(ScopeResolveError::Ambiguous(matches)),
    }
}

pub fn source_scopes(path: &str, source: &str) -> Vec<SourceScope> {
    let Some(language) = language_for_path(path) else {
        return Vec::new();
    };

    let mut parser = Parser::new();
    if parser.set_language(&language).is_err() {
        return Vec::new();
    }
    let Some(tree) = parser.parse(source, None) else {
        return Vec::new();
    };

    let mut scopes = Vec::new();
    collect_scopes(tree.root_node(), source.as_bytes(), &mut scopes);
    scopes.sort_by_key(|scope| (scope.start_line, scope.end_line, scope.name.clone()));
    scopes
}

fn language_for_path(path: &str) -> Option<Language> {
    let ext = Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match ext.as_str() {
        "bash" | "sh" | "zsh" => Some(tree_sitter_bash::LANGUAGE.into()),
        "c" | "h" => Some(tree_sitter_c::LANGUAGE.into()),
        "cc" | "cpp" | "cxx" | "hpp" | "hxx" => Some(tree_sitter_cpp::LANGUAGE.into()),
        "cs" => Some(tree_sitter_c_sharp::LANGUAGE.into()),
        "go" => Some(tree_sitter_go::LANGUAGE.into()),
        "java" => Some(tree_sitter_java::LANGUAGE.into()),
        "js" | "jsx" | "mjs" | "cjs" => Some(tree_sitter_javascript::LANGUAGE.into()),
        "kt" | "kts" => Some(tree_sitter_kotlin_ng::LANGUAGE.into()),
        "lua" => Some(tree_sitter_lua::LANGUAGE.into()),
        "php" => Some(tree_sitter_php::LANGUAGE_PHP.into()),
        "py" | "pyw" => Some(tree_sitter_python::LANGUAGE.into()),
        "rb" => Some(tree_sitter_ruby::LANGUAGE.into()),
        "rs" => Some(tree_sitter_rust::LANGUAGE.into()),
        "scala" | "sc" => Some(tree_sitter_scala::LANGUAGE.into()),
        "swift" => Some(tree_sitter_swift::LANGUAGE.into()),
        "ts" => Some(tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()),
        "tsx" => Some(tree_sitter_typescript::LANGUAGE_TSX.into()),
        _ => None,
    }
}

fn parse_locator(locator: &str) -> ScopeLocator {
    let trimmed = locator.trim();
    let mut parts = trimmed.split_whitespace();
    let first = parts.next().unwrap_or_default();
    let rest = parts.collect::<Vec<_>>().join(" ");
    if !rest.is_empty() && is_scope_kind_alias(first) {
        ScopeLocator {
            kind: Some(normalize_scope_kind(first).to_string()),
            name: rest,
        }
    } else {
        ScopeLocator {
            kind: None,
            name: trimmed.to_string(),
        }
    }
}

fn is_scope_kind_alias(value: &str) -> bool {
    matches!(
        normalize_scope_kind(value),
        "function"
            | "class"
            | "interface"
            | "struct"
            | "enum"
            | "impl"
            | "module"
            | "trait"
            | "type"
            | "variable"
    )
}

fn normalize_scope_kind(kind: &str) -> &str {
    match kind {
        "fn" | "func" | "method" => "function",
        "mod" => "module",
        "const" | "let" | "var" | "static" => "variable",
        other => other,
    }
}

fn locator_matches(scope: &SourceScope, locator: &ScopeLocator) -> bool {
    if let Some(kind) = &locator.kind
        && normalize_scope_kind(&scope.kind) != kind
    {
        return false;
    }
    scope.name == locator.name
}

fn collect_scopes(node: Node<'_>, source: &[u8], scopes: &mut Vec<SourceScope>) {
    if let Some(kind) = scope_kind(node.kind()) {
        if let Some(name) = scope_name(node, source) {
            scopes.push(SourceScope {
                name,
                kind: kind.to_string(),
                start_line: node.start_position().row + 1,
                end_line: node.end_position().row + 1,
            });
        }
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_scopes(child, source, scopes);
    }
}

fn scope_kind(kind: &str) -> Option<&'static str> {
    match kind {
        "function_declaration"
        | "function_definition"
        | "function_item"
        | "function"
        | "function_statement"
        | "method_declaration"
        | "method_definition"
        | "method"
        | "generator_function_declaration"
        | "arrow_function"
        | "constructor_declaration" => Some("function"),
        "class_declaration" | "class_definition" | "class" => Some("class"),
        "interface_declaration" | "interface" => Some("interface"),
        "type_alias_declaration" | "type_alias" => Some("type"),
        "struct_item" | "struct_specifier" | "struct_declaration" => Some("struct"),
        "enum_item" | "enum_declaration" | "enum_specifier" => Some("enum"),
        "impl_item" => Some("impl"),
        "mod_item" | "module" | "module_declaration" => Some("module"),
        "trait_item" => Some("trait"),
        "variable_declarator" | "const_item" | "static_item" => Some("variable"),
        _ => None,
    }
}

fn scope_name(node: Node<'_>, source: &[u8]) -> Option<String> {
    if let Some(name) = node.child_by_field_name("name") {
        return node_text(name, source);
    }
    if let Some(name) = node.child_by_field_name("property") {
        return node_text(name, source);
    }
    find_named_identifier(node, source)
}

fn find_named_identifier(node: Node<'_>, source: &[u8]) -> Option<String> {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if matches!(
            child.kind(),
            "identifier"
                | "property_identifier"
                | "field_identifier"
                | "type_identifier"
                | "constant"
                | "name"
        ) {
            if let Some(text) = node_text(child, source) {
                return Some(text);
            }
        }
    }
    None
}

fn node_text(node: Node<'_>, source: &[u8]) -> Option<String> {
    node.utf8_text(source).ok().map(str::trim).and_then(|text| {
        if text.is_empty() {
            None
        } else {
            Some(text.to_string())
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_javascript_function_scopes() {
        let scopes = source_scopes(
            "sample.js",
            "function alpha() {\n  return 1;\n}\n\nclass Beta {\n  gamma() {}\n}\n",
        );
        assert!(scopes.iter().any(|scope| scope.name == "alpha"));
        assert!(scopes.iter().any(|scope| scope.name == "Beta"));
        assert!(scopes.iter().any(|scope| scope.name == "gamma"));
    }

    #[test]
    fn extracts_typescript_type_alias_scopes() {
        let scopes = source_scopes(
            "sample.ts",
            "type ApplyPatchProgressFile = {\n  path: string;\n};\n",
        );
        assert!(
            scopes
                .iter()
                .any(|scope| scope.kind == "type" && scope.name == "ApplyPatchProgressFile")
        );
    }

    #[test]
    fn resolves_typescript_const_scope_alias() {
        let source = "const APPLY_PATCH_PROMPT_APPENDIX = `hello`;\n";
        let (_, anchor, scope) =
            anchor_for_locator("sample.ts", source, "const APPLY_PATCH_PROMPT_APPENDIX").unwrap();
        assert_eq!(anchor, "const APPLY_PATCH_PROMPT_APPENDIX = `hello`;");
        assert_eq!(scope.kind, "variable");
        assert_eq!(scope.name, "APPLY_PATCH_PROMPT_APPENDIX");
    }
}
