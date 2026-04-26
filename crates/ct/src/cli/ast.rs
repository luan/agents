use crate::cli::args::AstAction;

pub fn run_ast(action: AstAction) -> Result<(), Box<dyn std::error::Error>> {
    match action {
        AstAction::Search {
            pattern,
            lang,
            paths,
            json,
            selector,
            context,
            include_ignored,
        } => {
            reject_plain_text_pattern(&pattern)?;
            let paths = default_paths(paths);
            let matches = sg_search(&pattern, &lang, &paths, selector.as_deref(), context)?;
            let out = serde_json::json!({
                "pattern": pattern,
                "lang": lang,
                "paths": paths,
                "include_ignored": include_ignored,
                "matches": matches,
                "match_count": matches.as_array().map(Vec::len).unwrap_or(0),
                "available": true
            });
            print_output(json, &out)?;
        }
        AstAction::Replace {
            pattern,
            rewrite,
            lang,
            paths,
            json,
            apply,
            include_ignored,
        } => {
            reject_plain_text_pattern(&pattern)?;
            let paths = default_paths(paths);
            let matches = if apply {
                sg_replace_apply(&pattern, &rewrite, &lang, &paths)?;
                sg_search(&rewrite, &lang, &paths, None, None)?
            } else {
                sg_replace_dry_run(&pattern, &rewrite, &lang, &paths)?
            };
            let out = serde_json::json!({
                "pattern": pattern,
                "rewrite": rewrite,
                "lang": lang,
                "paths": paths,
                "apply": apply,
                "include_ignored": include_ignored,
                "matches": matches,
                "match_count": matches.as_array().map(Vec::len).unwrap_or(0),
                "available": true
            });
            print_output(json, &out)?;
        }
    }
    Ok(())
}

pub(crate) fn default_paths(paths: Vec<String>) -> Vec<String> {
    if paths.is_empty() {
        vec![".".to_string()]
    } else {
        paths
    }
}

pub(crate) fn reject_plain_text_pattern(pattern: &str) -> Result<(), Box<dyn std::error::Error>> {
    let text = pattern.trim();
    if text.is_empty() {
        return Err("ast pattern cannot be empty".into());
    }
    let looks_like_yaml = text.lines().any(|line| {
        let line = line.trim_start().to_ascii_lowercase();
        ["id:", "language:", "rule:", "rules:", "kind:", "pattern:"]
            .iter()
            .any(|prefix| line.starts_with(prefix))
    });
    let has_ast_signal = text.chars().any(|ch| "$(){}[].;:'\"`".contains(ch));
    if looks_like_yaml || (text.contains(char::is_whitespace) && !has_ast_signal) {
        return Err(
            "ast commands require a structured AST code pattern, not plain text or rule YAML"
                .into(),
        );
    }
    Ok(())
}

pub(crate) fn sg_search(
    pattern: &str,
    lang: &str,
    paths: &[String],
    selector: Option<&str>,
    context: Option<usize>,
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    let mut args = vec![
        "run".to_string(),
        "-p".to_string(),
        pattern.to_string(),
        "--lang".to_string(),
        lang.to_string(),
        "--json=compact".to_string(),
    ];
    if let Some(selector) = selector {
        args.push("--selector".to_string());
        args.push(selector.to_string());
    }
    if let Some(context) = context {
        args.push("--context".to_string());
        args.push(context.to_string());
    }
    args.extend(paths.iter().cloned());
    run_sg_json(args)
}

pub(crate) fn sg_replace_dry_run(
    pattern: &str,
    rewrite: &str,
    lang: &str,
    paths: &[String],
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    let mut args = vec![
        "run".to_string(),
        "-p".to_string(),
        pattern.to_string(),
        "-r".to_string(),
        rewrite.to_string(),
        "--lang".to_string(),
        lang.to_string(),
        "--json=compact".to_string(),
    ];
    args.extend(paths.iter().cloned());
    run_sg_json(args)
}

pub(crate) fn sg_replace_apply(
    pattern: &str,
    rewrite: &str,
    lang: &str,
    paths: &[String],
) -> Result<(), Box<dyn std::error::Error>> {
    let mut args = vec![
        "run".to_string(),
        "-p".to_string(),
        pattern.to_string(),
        "-r".to_string(),
        rewrite.to_string(),
        "--lang".to_string(),
        lang.to_string(),
        "--update-all".to_string(),
    ];
    args.extend(paths.iter().cloned());
    let output = std::process::Command::new("sg").args(args).output()?;
    if !output.status.success() {
        return Err(format!("sg failed: {}", String::from_utf8_lossy(&output.stderr)).into());
    }
    Ok(())
}

fn run_sg_json(args: Vec<String>) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    let output = std::process::Command::new("sg").args(args).output()?;
    if !output.status.success() {
        return Err(format!("sg failed: {}", String::from_utf8_lossy(&output.stderr)).into());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(serde_json::from_str(stdout.trim()).unwrap_or_else(|_| serde_json::json!([])))
}

fn print_output(_json: bool, value: &serde_json::Value) -> Result<(), Box<dyn std::error::Error>> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}
