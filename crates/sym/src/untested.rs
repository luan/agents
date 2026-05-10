use std::fs;

use crate::store::SymbolResult;

pub struct Rank {
    pub score: i64,
    pub reason: Vec<&'static str>,
    pub exported: bool,
}

pub fn rank(symbol: &SymbolResult, reference_count: usize, test_reference_count: usize) -> Rank {
    let exported = is_exported_symbol(symbol);
    let mut score = 0i64;
    let mut reason = Vec::new();

    if exported {
        score += 1000;
        reason.push("exported/public symbol");
    } else {
        reason.push("private/internal symbol");
    }

    if reference_count > 0 {
        score += (reference_count.min(100) as i64) * 10;
        reason.push("referenced by indexed code");
    } else {
        reason.push("no indexed fan-in");
    }

    if test_reference_count == 0 {
        score += 100;
        reason.push("no indexed test references");
    }

    Rank {
        score,
        reason,
        exported,
    }
}

fn is_exported_symbol(symbol: &SymbolResult) -> bool {
    match symbol.language.as_str() {
        "rust" => source_line_starts_with(&symbol.file, symbol.start_line, "pub "),
        "typescript" | "tsx" | "javascript" => {
            source_line_starts_with(&symbol.file, symbol.start_line, "export ")
                || symbol
                    .name
                    .chars()
                    .next()
                    .is_some_and(|ch| ch.is_ascii_uppercase())
        }
        "go" => symbol
            .name
            .chars()
            .next()
            .is_some_and(|ch| ch.is_ascii_uppercase()),
        "python" => !symbol.name.starts_with('_'),
        _ => symbol
            .name
            .chars()
            .next()
            .is_some_and(|ch| ch.is_ascii_uppercase()),
    }
}

fn source_line_starts_with(file: &str, line: usize, prefix: &str) -> bool {
    let Ok(contents) = fs::read_to_string(file) else {
        return false;
    };
    contents
        .lines()
        .nth(line.saturating_sub(1))
        .map(str::trim_start)
        .is_some_and(|line| line.starts_with(prefix))
}
