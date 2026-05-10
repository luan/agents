use std::io::{self, IsTerminal, Write};
use std::sync::atomic::{AtomicU8, Ordering};

use anyhow::Result;
use serde::Serialize;
use serde_json::Value;

static FORMAT: AtomicU8 = AtomicU8::new(OutputFormat::Text as u8);

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum OutputFormat {
    Text = 0,
    Ai = 1,
}

pub fn default_format() -> crate::cli::OutputFormatArg {
    if io::stdout().is_terminal() {
        crate::cli::OutputFormatArg::Text
    } else {
        crate::cli::OutputFormatArg::Ai
    }
}

pub fn set_format(format: OutputFormat) {
    FORMAT.store(format as u8, Ordering::Relaxed);
}

pub fn structured_enabled() -> bool {
    matches!(format(), OutputFormat::Ai)
}

fn format() -> OutputFormat {
    match FORMAT.load(Ordering::Relaxed) {
        1 => OutputFormat::Ai,
        _ => OutputFormat::Text,
    }
}

pub fn write_structured<T: Serialize>(data: &T) -> Result<()> {
    let value = serde_json::to_value(data)?;
    let output = render_ai(&value);
    let stdout = io::stdout();
    let mut handle = stdout.lock();
    handle.write_all(output.as_bytes())?;
    if !output.ends_with('\n') {
        handle.write_all(b"\n")?;
    }
    Ok(())
}

pub fn render<T: Serialize>(data: &T, meta: &[(&str, String)], content: &str) -> Result<()> {
    if structured_enabled() {
        return write_structured(data);
    }
    write_frontmatter(meta, content)
}

pub fn write_frontmatter(meta: &[(&str, String)], content: &str) -> Result<()> {
    let stdout = io::stdout();
    let mut handle = stdout.lock();
    handle.write_all(b"---\n")?;
    for (key, value) in meta {
        handle.write_all(key.as_bytes())?;
        handle.write_all(b": ")?;
        handle.write_all(value.as_bytes())?;
        handle.write_all(b"\n")?;
    }
    handle.write_all(b"---\n")?;
    if !content.is_empty() {
        handle.write_all(content.as_bytes())?;
        if !content.ends_with('\n') {
            handle.write_all(b"\n")?;
        }
    }
    Ok(())
}

fn render_ai(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return text.to_string();
    }
    let Some(object) = value.as_object() else {
        return scalar(value).to_string();
    };
    let op = object
        .get("operation")
        .and_then(Value::as_str)
        .unwrap_or("RESULTS");
    if op == "RESULTS" && object.contains_key("file_count") && object.contains_key("symbol_count") {
        return render_stats(object);
    }
    match op {
        "stats" => render_stats(object),
        "index" => render_index(object),
        "map" => render_map(object),
        "query" | "search" | "inspect" | "outline" | "show" => {
            render_symbol_results("RESULTS", object)
        }
        "callers" => render_relation("CALLERS", object, "caller"),
        "callees" => render_relation("CALLEES", object, "callee"),
        "refs" => render_relation("REFS", object, "name"),
        "impact" => render_relation("IMPACT", object, "caller"),
        "trace" => render_relation("TRACE", object, "callee"),
        "impls" => render_relation("IMPLS", object, "implementor"),
        "types" => render_relation("TYPES", object, "type"),
        "schema" => render_relation("SCHEMA", object, "name"),
        "tests" => render_relation("TESTS", object, "test"),
        "test-deps" => render_relation("TEST_DEPS", object, "dependency"),
        "untested" => render_untested(object),
        "diff" => render_diff(object),
        "structure" => render_structure(object),
        "context" | "investigate" => render_blocks(op, object),
        other => render_generic(&other.to_ascii_uppercase(), object),
    }
}

fn render_stats(object: &serde_json::Map<String, Value>) -> String {
    let mut out = String::from("[STATS]\n");
    out.push_str("LANGS:");
    if let Some(langs) = object.get("languages").and_then(Value::as_object) {
        for (lang, count) in langs {
            out.push_str(&format!(" {}:{}", lang, scalar(count)));
        }
    }
    out.push('\n');
    out.push_str(&format!(
        "TOTALS: files:{} syms:{} repo:{}\n",
        field(object, "file_count"),
        field(object, "symbol_count"),
        first_nonempty(&[
            field(object, "repo_root"),
            field(object, "path"),
            field(object, "repo"),
        ]),
    ));
    out
}

fn render_index(object: &serde_json::Map<String, Value>) -> String {
    format!(
        "[INDEX]\nrepo:{}\nfiles:{} skipped:{} symbols:{} stale:{}\n",
        field(object, "repo_root"),
        field(object, "files_indexed"),
        field(object, "files_skipped"),
        field(object, "symbols_found"),
        field(object, "stale_removed"),
    )
}

fn render_map(object: &serde_json::Map<String, Value>) -> String {
    let mut out = String::from("[PROJECT]\n");
    out.push_str("LANGS:");
    if let Some(langs) = object.get("languages").and_then(Value::as_object) {
        for (lang, count) in langs {
            out.push_str(&format!(" {}:{}", lang, scalar(count)));
        }
    }
    out.push('\n');
    out.push_str(&format!(
        "FILES:{} SYMBOLS:{}\n",
        field(object, "file_count"),
        field(object, "symbol_count"),
    ));
    if let Some(files) = object.get("files").and_then(Value::as_array) {
        out.push_str("\n[FILES]\n");
        for file in files {
            if let Some(file) = file.as_object() {
                out.push_str(&format!(
                    "{}|{}|{}\n",
                    first_nonempty(&[field(file, "rel_path"), field(file, "path")]),
                    field(file, "language"),
                    first_nonempty(&[field(file, "symbol_count"), field(file, "symbols")]),
                ));
            }
        }
    }
    out
}

fn render_symbol_results(header: &str, object: &serde_json::Map<String, Value>) -> String {
    let rows = object.get("results").and_then(Value::as_array);
    let count = object
        .get("result_count")
        .and_then(Value::as_u64)
        .unwrap_or_else(|| rows.map(|rows| rows.len() as u64).unwrap_or(0));
    let mut out = format!("[{}:{}]\n", header, count);
    if let Some(rows) = rows {
        for row in rows {
            render_symbol_or_group(&mut out, row);
        }
    }
    out
}

fn render_symbol_or_group(out: &mut String, row: &Value) {
    let Some(object) = row.as_object() else {
        out.push_str(&format!("{}\n", scalar(row)));
        return;
    };
    if let Some(group_rows) = object.get("results").and_then(Value::as_array) {
        let target = field(object, "target");
        out.push_str(&format!("[TARGET:{}|{}]\n", target, group_rows.len()));
        for child in group_rows {
            render_symbol_or_group(out, child);
        }
        return;
    }
    if object.contains_key("name")
        && (object.contains_key("rel_path") || object.contains_key("file"))
    {
        out.push_str(&symbol_line(object));
    } else {
        out.push_str(&generic_row(object));
    }
    out.push('\n');
}

fn render_relation(
    header: &str,
    object: &serde_json::Map<String, Value>,
    name_field: &str,
) -> String {
    let rows = object.get("results").and_then(Value::as_array);
    let count = object
        .get("result_count")
        .and_then(Value::as_u64)
        .unwrap_or_else(|| rows.map(|rows| count_nested(rows)).unwrap_or(0));
    let target = object
        .get("targets")
        .and_then(Value::as_array)
        .and_then(|targets| targets.first())
        .and_then(Value::as_str)
        .or_else(|| object.get("target").and_then(Value::as_str))
        .unwrap_or("");
    let mut out = if target.is_empty() {
        format!("[{}:{}]\n", header, count)
    } else {
        format!("[{}:{}|{}]\n", header, target, count)
    };
    if let Some(rows) = rows {
        for row in rows {
            render_relation_row(&mut out, row, name_field);
        }
    }
    out
}

fn render_relation_row(out: &mut String, row: &Value, name_field: &str) {
    let Some(object) = row.as_object() else {
        out.push_str(&format!("{}\n", scalar(row)));
        return;
    };
    if let Some(group_rows) = object.get("results").and_then(Value::as_array) {
        let target = field(object, "target");
        out.push_str(&format!("[TARGET:{}|{}]\n", target, group_rows.len()));
        for child in group_rows {
            render_relation_row(out, child, name_field);
        }
        return;
    }
    let name = first_nonempty(&[
        field(object, name_field),
        field(object, "name"),
        field(object, "caller"),
        field(object, "callee"),
        field(object, "dependency"),
        field(object, "test"),
    ]);
    out.push_str(&format!(
        "{}|{}|{}:{}",
        name,
        kind_abbr(first_nonempty(&[field(object, "kind"), "function".to_string()]).as_str()),
        first_nonempty(&[field(object, "rel_path"), field(object, "file")]),
        first_nonempty(&[field(object, "line"), field(object, "start_line")]),
    ));
    append_evidence(out, object);
    out.push('\n');
}

fn render_untested(object: &serde_json::Map<String, Value>) -> String {
    let rows = object.get("results").and_then(Value::as_array);
    let count = object
        .get("result_count")
        .and_then(Value::as_u64)
        .unwrap_or_else(|| rows.map(|rows| rows.len() as u64).unwrap_or(0));
    let mut out = format!("[UNTESTED:{}]\n", count);
    if let Some(rows) = rows {
        for row in rows {
            let Some(row) = row.as_object() else {
                continue;
            };
            let symbol = row.get("symbol").and_then(Value::as_object).unwrap_or(row);
            out.push_str(&symbol_line(symbol));
            out.pop();
            out.push_str(&format!(
                "|refs:{}|test_refs:{}|rank:{}",
                field(row, "reference_count"),
                field(row, "test_reference_count"),
                field(row, "rank_score"),
            ));
            append_evidence(&mut out, row);
            out.push('\n');
        }
    }
    out
}

fn render_diff(object: &serde_json::Map<String, Value>) -> String {
    let mut out = format!(
        "[DIFF:{}]\n",
        object
            .get("target")
            .and_then(Value::as_str)
            .unwrap_or_default()
    );
    if let Some(result) = object.get("result").and_then(Value::as_object) {
        out.push_str(&format!(
            "base:{} file:{} lines:{}-{}\n",
            first_nonempty(&[field(object, "base"), field(result, "base")]),
            field(result, "rel_path"),
            field(result, "start_line"),
            field(result, "end_line"),
        ));
        if let Some(content) = result.get("content").and_then(Value::as_str) {
            out.push_str(content);
            if !content.ends_with('\n') {
                out.push('\n');
            }
        }
    }
    out
}

fn render_structure(object: &serde_json::Map<String, Value>) -> String {
    let mut out = String::from("[STRUCTURE]\n");
    for (key, value) in object {
        if matches!(key.as_str(), "operation" | "available" | "read_only") {
            continue;
        }
        out.push_str(&format!("{}:{}\n", key, compact(value)));
    }
    out
}

fn render_blocks(op: &str, object: &serde_json::Map<String, Value>) -> String {
    let mut out = format!("[{}]\n", op.to_ascii_uppercase());
    for (key, value) in object {
        if matches!(key.as_str(), "operation" | "available" | "read_only") {
            continue;
        }
        out.push_str(&format!("{}:{}\n", key, compact(value)));
    }
    out
}

fn render_generic(header: &str, object: &serde_json::Map<String, Value>) -> String {
    let mut out = format!("[{}]\n", header);
    for (key, value) in object {
        out.push_str(&format!("{}:{}\n", key, compact(value)));
    }
    out
}

fn symbol_line(object: &serde_json::Map<String, Value>) -> String {
    let exported = if object
        .get("exported")
        .or_else(|| object.get("is_exported"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        "|exp"
    } else {
        ""
    };
    let mut line = format!(
        "{}|{}|{}|{}-{}{}",
        field(object, "name"),
        kind_abbr(field(object, "kind").as_str()),
        first_nonempty(&[field(object, "rel_path"), field(object, "file")]),
        first_nonempty(&[field(object, "start_line"), field(object, "line")]),
        first_nonempty(&[field(object, "end_line"), field(object, "line")]),
        exported,
    );
    if let Some(signature) = object.get("signature").and_then(Value::as_str)
        && !signature.is_empty()
    {
        line.push_str(&format!("|sig:{}", one_line(signature)));
    }
    line.push('\n');
    line
}

fn generic_row(object: &serde_json::Map<String, Value>) -> String {
    object
        .iter()
        .filter(|(key, _)| !matches!(key.as_str(), "context" | "source"))
        .map(|(key, value)| format!("{}:{}", key, compact(value)))
        .collect::<Vec<_>>()
        .join("|")
}

fn append_evidence(out: &mut String, object: &serde_json::Map<String, Value>) {
    if let Some(evidence) = object.get("evidence").and_then(Value::as_object)
        && let Some(kind) = evidence.get("kind").and_then(Value::as_str)
    {
        out.push_str(&format!("|ev:{}", kind));
    }
    if let Some(confidence) = object.get("confidence").and_then(Value::as_str) {
        out.push_str(&format!("|conf:{}", confidence));
    }
}

fn count_nested(rows: &[Value]) -> u64 {
    rows.iter()
        .map(|row| {
            row.get("results")
                .and_then(Value::as_array)
                .map(|children| children.len() as u64)
                .unwrap_or(1)
        })
        .sum()
}

fn field(object: &serde_json::Map<String, Value>, key: &str) -> String {
    object.get(key).map(scalar).unwrap_or_default()
}

fn first_nonempty(values: &[String]) -> String {
    values
        .iter()
        .find(|value| !value.is_empty())
        .cloned()
        .unwrap_or_default()
}

fn scalar(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => value.clone(),
        Value::Array(_) | Value::Object(_) => compact(value),
    }
}

fn compact(value: &Value) -> String {
    match value {
        Value::Array(values) => values.iter().map(scalar).collect::<Vec<_>>().join(","),
        Value::Object(object) => object
            .iter()
            .map(|(key, value)| format!("{}={}", key, scalar(value)))
            .collect::<Vec<_>>()
            .join(","),
        _ => scalar(value),
    }
}

fn one_line(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn kind_abbr(kind: &str) -> &'static str {
    match kind {
        "function" => "f",
        "class" => "c",
        "method" => "m",
        "enum" => "e",
        "struct" => "s",
        "trait" => "tr",
        "interface" => "if",
        "type" | "type_alias" => "ty",
        "module" => "mod",
        "test" => "t",
        _ => kind.chars().next().map(|_| "?").unwrap_or("?"),
    }
}
