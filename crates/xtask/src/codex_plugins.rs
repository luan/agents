use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::Deserialize;

#[derive(Deserialize)]
struct Marketplace {
    name: String,
    plugins: Vec<Plugin>,
}

#[derive(Deserialize)]
struct Plugin {
    name: String,
    source: PluginSource,
}

#[derive(Deserialize)]
struct PluginSource {
    source: String,
    #[serde(default)]
    path: Option<String>,
}

#[derive(Deserialize)]
struct PluginManifest {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    version: Option<String>,
}

#[derive(Deserialize)]
struct CodexConfig {
    #[serde(default)]
    plugins: HashMap<String, toml::Value>,
}

pub fn run() -> Result<()> {
    let root = crate::repo_root();
    let home = dirs::home_dir().context("cannot determine HOME")?;
    let codex_home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".codex"));

    let marketplace_path = root.join(".agents/plugins/marketplace.json");
    let config_path = root.join("codex/config.toml");

    let marketplace: Marketplace = serde_json::from_str(
        &fs::read_to_string(&marketplace_path)
            .with_context(|| format!("read {}", marketplace_path.display()))?,
    )
    .with_context(|| format!("parse {}", marketplace_path.display()))?;

    let config: CodexConfig = toml::from_str(
        &fs::read_to_string(&config_path)
            .with_context(|| format!("read {}", config_path.display()))?,
    )
    .with_context(|| format!("parse {}", config_path.display()))?;

    let enabled: std::collections::HashSet<String> = config
        .plugins
        .iter()
        .filter_map(|(k, v)| {
            v.get("enabled")
                .and_then(|e| e.as_bool())
                .filter(|b| *b)
                .map(|_| k.clone())
        })
        .collect();

    let mut installed = 0usize;
    for plugin in &marketplace.plugins {
        let key = format!("{}@{}", plugin.name, marketplace.name);
        if !enabled.contains(&key) {
            continue;
        }
        install_plugin(&root, &codex_home, &marketplace.name, plugin)?;
        installed += 1;
    }

    if installed == 0 {
        eprintln!(
            "no enabled plugins found for marketplace `{}`",
            marketplace.name
        );
    }
    Ok(())
}

fn install_plugin(
    root: &Path,
    codex_home: &Path,
    marketplace_name: &str,
    plugin: &Plugin,
) -> Result<()> {
    if plugin.source.source != "local" {
        println!(
            "skipping {}@{}: only local sources are installed here",
            plugin.name, marketplace_name
        );
        return Ok(());
    }
    let rel = plugin
        .source
        .path
        .as_deref()
        .with_context(|| format!("plugin {} missing source.path", plugin.name))?;
    let source_path =
        fs::canonicalize(root.join(rel)).with_context(|| format!("resolve plugin path {}", rel))?;

    let manifest_path = manifest_path(&source_path)?;
    let manifest: PluginManifest = serde_json::from_str(
        &fs::read_to_string(&manifest_path)
            .with_context(|| format!("read {}", manifest_path.display()))?,
    )
    .with_context(|| format!("parse {}", manifest_path.display()))?;

    if manifest.name.as_deref() != Some(plugin.name.as_str()) {
        bail!(
            "plugin manifest name `{}` does not match `{}`",
            manifest.name.unwrap_or_default(),
            plugin.name
        );
    }
    let version = validate_version(manifest.version.as_deref().unwrap_or("local").trim())?;

    let target = codex_home
        .join("plugins")
        .join("cache")
        .join(marketplace_name)
        .join(&plugin.name)
        .join(&version);
    let parent = target
        .parent()
        .context("plugin target has no parent")?
        .to_path_buf();
    fs::create_dir_all(&parent).with_context(|| format!("mkdir -p {}", parent.display()))?;

    let tmp = parent.join(format!(".{}.tmp", file_name(&target)?));
    let backup = parent.join(format!(".{}.old", file_name(&target)?));

    let _ = fs::remove_dir_all(&tmp);
    copy_tree(&source_path, &tmp)?;
    let _ = fs::remove_dir_all(&backup);
    if target.exists() || fs::symlink_metadata(&target).is_ok() {
        fs::rename(&target, &backup).with_context(|| format!("backup {}", target.display()))?;
    }
    fs::rename(&tmp, &target).with_context(|| format!("install {}", target.display()))?;
    let _ = fs::remove_dir_all(&backup);

    println!(
        "installed {}@{} {} -> {}",
        plugin.name,
        marketplace_name,
        version,
        target.display()
    );
    Ok(())
}

fn manifest_path(plugin_root: &Path) -> Result<PathBuf> {
    for rel in [".codex-plugin/plugin.json", ".claude-plugin/plugin.json"] {
        let p = plugin_root.join(rel);
        if p.is_file() {
            return Ok(p);
        }
    }
    bail!("missing plugin manifest in {}", plugin_root.display());
}

fn validate_version(version: &str) -> Result<String> {
    if version.is_empty() {
        bail!("blank plugin version");
    }
    if version == "." || version == ".." {
        bail!("invalid plugin version `{version}`");
    }
    if !version
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '+'))
    {
        bail!("invalid plugin version `{version}`");
    }
    Ok(version.to_string())
}

fn file_name(p: &Path) -> Result<String> {
    Ok(p.file_name()
        .context("path has no file name")?
        .to_string_lossy()
        .into_owned())
}

fn copy_tree(src: &Path, dst: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(src).with_context(|| format!("stat {}", src.display()))?;
    if meta.file_type().is_symlink() {
        copy_symlink(src, dst)?;
        return Ok(());
    }
    if meta.is_dir() {
        fs::create_dir_all(dst).with_context(|| format!("mkdir -p {}", dst.display()))?;
        for entry in fs::read_dir(src).with_context(|| format!("read_dir {}", src.display()))? {
            let entry = entry?;
            copy_tree(&entry.path(), &dst.join(entry.file_name()))?;
        }
    } else {
        fs::copy(src, dst)
            .with_context(|| format!("copy {} -> {}", src.display(), dst.display()))?;
    }
    Ok(())
}

#[cfg(unix)]
fn copy_symlink(src: &Path, dst: &Path) -> Result<()> {
    let target = fs::read_link(src).with_context(|| format!("read_link {}", src.display()))?;
    std::os::unix::fs::symlink(&target, dst)
        .with_context(|| format!("symlink {} -> {}", dst.display(), target.display()))?;
    Ok(())
}

#[cfg(not(unix))]
fn copy_symlink(src: &Path, dst: &Path) -> Result<()> {
    let target = fs::read_link(src).with_context(|| format!("read_link {}", src.display()))?;
    if target.is_dir() {
        std::os::windows::fs::symlink_dir(&target, dst)?;
    } else {
        std::os::windows::fs::symlink_file(&target, dst)?;
    }
    Ok(())
}
