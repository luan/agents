use std::fs;
use std::path::Path;

use anyhow::{Context, Result, bail};
use regex::Regex;

const BEGIN: &str = "<!-- BEGIN GENERATED RULES -->";
const END: &str = "<!-- END GENERATED RULES -->";

pub fn run() -> Result<()> {
    let root = crate::repo_root();
    let template_path = root.join("AGENTS.template.md");
    let output_path = root.join("GLOBAL_AGENTS.md");
    let rules_dir = root.join("rules");

    let template = fs::read_to_string(&template_path)
        .with_context(|| format!("read {}", template_path.display()))?;
    let begin_idx = template
        .find(BEGIN)
        .with_context(|| format!("{} missing {BEGIN}", template_path.display()))?;
    let end_idx = template
        .find(END)
        .with_context(|| format!("{} missing {END}", template_path.display()))?;
    if end_idx < begin_idx {
        bail!("{} markers are out of order", template_path.display());
    }

    let before = &template[..begin_idx];
    let after = &template[end_idx + END.len()..];
    let rules_block = render_rules(&rules_dir, &root)?;
    let new_output = format!("{before}{BEGIN}\n{rules_block}{END}{after}");

    if let Ok(existing) = fs::read_to_string(&output_path)
        && existing == new_output
    {
        return Ok(());
    }
    fs::write(&output_path, new_output)
        .with_context(|| format!("write {}", output_path.display()))?;
    Ok(())
}

fn render_rules(rules_dir: &Path, root: &Path) -> Result<String> {
    if !rules_dir.exists() {
        return Ok("_No shared rules are currently defined._\n".to_string());
    }
    let mut entries: Vec<_> = fs::read_dir(rules_dir)
        .with_context(|| format!("read_dir {}", rules_dir.display()))?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().map(|e| e == "md").unwrap_or(false))
        .collect();
    entries.sort();

    if entries.is_empty() {
        return Ok("_No shared rules are currently defined._\n".to_string());
    }

    let mut lines = Vec::with_capacity(entries.len());
    for path in entries {
        let (title, description) = parse_rule(&path)?;
        let rel = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .display()
            .to_string();
        let name = path.file_name().unwrap().to_string_lossy();
        lines.push(format!(
            "- `{rel}` (~/.agents/rules/{name}): {title} - {description}"
        ));
    }
    Ok(lines.join("\n") + "\n")
}

fn parse_rule(path: &Path) -> Result<(String, String)> {
    let text = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    let (description, body) = if let Some(rest) = text.strip_prefix("---\n") {
        if let Some(end) = rest.find("---\n") {
            let frontmatter = &rest[..end];
            let body = &rest[end + 4..];
            let mut desc = String::new();
            for line in frontmatter.lines() {
                if let Some((key, value)) = line.split_once(':') {
                    let key = key.trim();
                    if key == "description" || key == "summary" {
                        desc = value.trim().trim_matches(['"', '\'']).to_string();
                        break;
                    }
                }
            }
            (desc, body.to_string())
        } else {
            (String::new(), text.clone())
        }
    } else {
        (String::new(), text.clone())
    };

    let header = Regex::new(r"^#\s+(.+?)\s*$").unwrap();
    let mut title = String::new();
    for line in body.lines() {
        if let Some(caps) = header.captures(line) {
            title = caps[1].trim().to_string();
            break;
        }
    }
    if title.is_empty() {
        let stem = path.file_stem().unwrap().to_string_lossy();
        title = stem
            .split('-')
            .map(|w| {
                let mut chars = w.chars();
                match chars.next() {
                    Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
                    None => String::new(),
                }
            })
            .collect::<Vec<_>>()
            .join(" ");
    }
    let description = if description.is_empty() {
        title.clone()
    } else {
        description
    };
    Ok((title, description))
}
