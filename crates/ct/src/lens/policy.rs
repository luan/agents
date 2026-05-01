use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::contract::LensMessage;
use super::retention::RetentionPolicy;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct LensPolicy {
    pub retention: RetentionPolicy,
    pub checks: BTreeMap<String, LensCheckConfig>,
    pub scanners: BTreeMap<String, LensScannerConfig>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LensCheckConfig {
    pub command: String,
    #[serde(default = "default_check_scope")]
    pub scope: String,
    #[serde(default)]
    pub automatic: bool,
    #[serde(default = "default_check_timeout_ms", alias = "timeout")]
    pub timeout_ms: u64,
    #[serde(default)]
    pub parser: LensCheckParser,
    #[serde(default, alias = "raw_output_cap", alias = "raw_cap")]
    pub raw_output_max_bytes: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LensScannerConfig {
    pub command: String,
    #[serde(default = "default_check_scope")]
    pub scope: String,
    #[serde(default)]
    pub automatic: bool,
    #[serde(default = "default_scanner_timeout_ms", alias = "timeout")]
    pub timeout_ms: u64,
    #[serde(default = "default_scanner_parser")]
    pub parser: LensCheckParser,
    #[serde(default, alias = "raw_output_cap", alias = "raw_cap")]
    pub raw_output_max_bytes: Option<usize>,
    #[serde(default = "default_scanner_source")]
    pub source: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum LensCheckParser {
    #[default]
    Generic,
    Line,
}

fn default_check_scope() -> String {
    "workspace".to_string()
}

fn default_check_timeout_ms() -> u64 {
    120_000
}

fn default_scanner_timeout_ms() -> u64 {
    30_000
}

fn default_scanner_parser() -> LensCheckParser {
    LensCheckParser::Line
}

fn default_scanner_source() -> String {
    "secrets".to_string()
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimePolicyOverrides {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PolicyLayerStatus {
    pub layer: String,
    pub path: Option<String>,
    pub present: bool,
    pub applied: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResolvedLensPolicy {
    pub policy: LensPolicy,
    pub layers: Vec<PolicyLayerStatus>,
    pub warnings: Vec<LensMessage>,
}

#[derive(Debug, Clone, Default)]
pub struct PolicyResolveOptions {
    pub user_config_path: Option<PathBuf>,
    pub repo_config_path: Option<PathBuf>,
    pub runtime: RuntimePolicyOverrides,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct LensPolicyConfig {
    retention: Option<RetentionPolicyConfig>,
    checks: Option<BTreeMap<String, LensCheckConfig>>,
    scanners: Option<BTreeMap<String, LensScannerConfig>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct RetentionPolicyConfig {
    max_diagnostics: Option<i64>,
    max_tool_runs: Option<i64>,
    max_sessions: Option<i64>,
    max_patch_drafts: Option<i64>,
    max_patch_draft_bodies: Option<i64>,
    max_raw_outputs: Option<i64>,
}

pub fn resolve_policy(root: &Path) -> ResolvedLensPolicy {
    resolve_policy_with_options(root, PolicyResolveOptions::default())
}

pub fn resolve_policy_with_options(
    root: &Path,
    options: PolicyResolveOptions,
) -> ResolvedLensPolicy {
    let mut policy = LensPolicy::default();
    let mut warnings = Vec::new();
    let user_path = options
        .user_config_path
        .unwrap_or_else(default_user_config_path);
    let repo_path = options
        .repo_config_path
        .unwrap_or_else(|| default_repo_config_path(root));
    let mut layers = vec![PolicyLayerStatus {
        layer: "built_in".to_string(),
        path: None,
        present: true,
        applied: true,
    }];
    apply_built_in_defaults(root, &mut policy);

    apply_file_layer("user", &user_path, &mut policy, &mut layers, &mut warnings);
    apply_file_layer(
        "repository",
        &repo_path,
        &mut policy,
        &mut layers,
        &mut warnings,
    );
    apply_runtime(options.runtime, &mut policy, &mut layers);

    ResolvedLensPolicy {
        policy,
        layers,
        warnings,
    }
}

fn apply_built_in_defaults(root: &Path, policy: &mut LensPolicy) {
    if root.join("Cargo.toml").is_file() {
        policy.checks.insert(
            "cargo-fmt".to_string(),
            LensCheckConfig {
                command: "cargo fmt --check".to_string(),
                scope: "workspace".to_string(),
                automatic: true,
                timeout_ms: default_check_timeout_ms(),
                parser: LensCheckParser::Generic,
                raw_output_max_bytes: None,
            },
        );
        policy.checks.insert(
            "cargo-clippy".to_string(),
            LensCheckConfig {
                command: "cargo clippy -- -D warnings".to_string(),
                scope: "workspace".to_string(),
                automatic: true,
                timeout_ms: default_check_timeout_ms(),
                parser: LensCheckParser::Generic,
                raw_output_max_bytes: None,
            },
        );
    }

    if has_biome_config(root) {
        policy.checks.insert(
            "biome-check".to_string(),
            LensCheckConfig {
                command: "bunx biome lint .".to_string(),
                scope: "workspace".to_string(),
                automatic: true,
                timeout_ms: default_check_timeout_ms(),
                parser: LensCheckParser::Generic,
                raw_output_max_bytes: None,
            },
        );
    }
}

fn has_biome_config(root: &Path) -> bool {
    root.join("biome.json").is_file() || root.join("biome.jsonc").is_file()
}

fn apply_file_layer(
    layer: &str,
    path: &Path,
    policy: &mut LensPolicy,
    layers: &mut Vec<PolicyLayerStatus>,
    warnings: &mut Vec<LensMessage>,
) {
    let present = path.is_file();
    let path_text = Some(path.display().to_string());
    if !present {
        layers.push(PolicyLayerStatus {
            layer: layer.to_string(),
            path: path_text,
            present: false,
            applied: false,
        });
        return;
    }

    match read_config(path) {
        Ok(config) => {
            apply_config(config, policy);
            layers.push(PolicyLayerStatus {
                layer: layer.to_string(),
                path: path_text,
                present: true,
                applied: true,
            });
        }
        Err(error) => {
            warnings.push(LensMessage::warning_with_hint(
                "policy_config_invalid",
                format!("failed to read {layer} Lens policy: {error}"),
                "fix or remove the JSON policy file",
            ));
            layers.push(PolicyLayerStatus {
                layer: layer.to_string(),
                path: path_text,
                present: true,
                applied: false,
            });
        }
    }
}

fn read_config(path: &Path) -> Result<LensPolicyConfig, Box<dyn std::error::Error>> {
    let text = std::fs::read_to_string(path)?;
    Ok(serde_json::from_str(&text)?)
}

fn apply_config(config: LensPolicyConfig, policy: &mut LensPolicy) {
    if let Some(retention) = config.retention {
        if let Some(max) = retention.max_diagnostics {
            policy.retention.max_diagnostics = max;
        }
        if let Some(max) = retention.max_tool_runs {
            policy.retention.max_tool_runs = max;
        }
        if let Some(max) = retention.max_sessions {
            policy.retention.max_sessions = max;
        }
        if let Some(max) = retention.max_patch_drafts {
            policy.retention.max_patch_drafts = max;
        }
        if let Some(max) = retention.max_patch_draft_bodies {
            policy.retention.max_patch_draft_bodies = max;
        }
        if let Some(max) = retention.max_raw_outputs {
            policy.retention.max_raw_outputs = max;
        }
    }
    if let Some(checks) = config.checks {
        policy.checks = checks;
    }
    if let Some(scanners) = config.scanners {
        policy.scanners = scanners;
    }
}

fn apply_runtime(
    _runtime: RuntimePolicyOverrides,
    _policy: &mut LensPolicy,
    layers: &mut Vec<PolicyLayerStatus>,
) {
    layers.push(PolicyLayerStatus {
        layer: "runtime".to_string(),
        path: None,
        present: false,
        applied: false,
    });
}

fn default_user_config_path() -> PathBuf {
    match std::env::var_os("XDG_CONFIG_HOME") {
        Some(path) => PathBuf::from(path),
        None => dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("~"))
            .join(".config"),
    }
    .join("ct")
    .join("lens.json")
}

fn default_repo_config_path(root: &Path) -> PathBuf {
    root.join(".ct").join("lens.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policy_config_accepts_named_checks_and_scanners() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("lens.json");
        std::fs::write(
            &repo,
            r#"{
                "checks": {
                    "test": {
                        "command": "./test.sh",
                        "scope": "workspace",
                        "automatic": true,
                        "timeout": 5,
                        "parser": "line",
                        "raw_cap": 128
                    }
                },
                "scanners": {
                    "secrets": {
                        "command": "./scan.sh",
                        "automatic": true,
                        "source": "security"
                    }
                }
            }"#,
        )
        .unwrap();

        let resolved = resolve_policy_with_options(
            temp.path(),
            PolicyResolveOptions {
                user_config_path: Some(temp.path().join("missing-user.json")),
                repo_config_path: Some(repo),
                runtime: RuntimePolicyOverrides::default(),
            },
        );

        let check = resolved.policy.checks.get("test").unwrap();
        assert_eq!(check.command, "./test.sh");
        assert!(check.automatic);
        assert_eq!(check.timeout_ms, 5);
        assert_eq!(check.parser, LensCheckParser::Line);
        assert_eq!(check.raw_output_max_bytes, Some(128));
        assert_eq!(
            resolved.policy.scanners.get("secrets").unwrap().source,
            "security"
        );
    }

    #[test]
    fn cargo_projects_get_built_in_automatic_checks_without_config() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("Cargo.toml"), "[package]\nname='x'\n").unwrap();

        let resolved = resolve_policy_with_options(
            temp.path(),
            PolicyResolveOptions {
                user_config_path: Some(temp.path().join("missing-user.json")),
                repo_config_path: Some(temp.path().join("missing-repo.json")),
                runtime: RuntimePolicyOverrides::default(),
            },
        );

        let fmt = resolved.policy.checks.get("cargo-fmt").unwrap();
        assert_eq!(fmt.command, "cargo fmt --check");
        assert!(fmt.automatic);
        let clippy = resolved.policy.checks.get("cargo-clippy").unwrap();
        assert_eq!(clippy.command, "cargo clippy -- -D warnings");
        assert!(clippy.automatic);
    }

    #[test]
    fn biome_built_in_requires_project_config() {
        let without_config = tempfile::tempdir().unwrap();
        let without = resolve_policy_with_options(
            without_config.path(),
            PolicyResolveOptions {
                user_config_path: Some(without_config.path().join("missing-user.json")),
                repo_config_path: Some(without_config.path().join("missing-repo.json")),
                runtime: RuntimePolicyOverrides::default(),
            },
        );
        assert!(!without.policy.checks.contains_key("biome-check"));

        let with_config = tempfile::tempdir().unwrap();
        std::fs::write(with_config.path().join("biome.jsonc"), "{}\n").unwrap();
        let with = resolve_policy_with_options(
            with_config.path(),
            PolicyResolveOptions {
                user_config_path: Some(with_config.path().join("missing-user.json")),
                repo_config_path: Some(with_config.path().join("missing-repo.json")),
                runtime: RuntimePolicyOverrides::default(),
            },
        );

        let biome = with.policy.checks.get("biome-check").unwrap();
        assert_eq!(biome.command, "bunx biome lint .");
        assert!(biome.automatic);
    }

    #[test]
    fn policy_layers_apply_retention_without_guard_state() {
        let temp = tempfile::tempdir().unwrap();
        let user = temp.path().join("user.json");
        let repo_dir = temp.path().join("repo");
        std::fs::create_dir_all(&repo_dir).unwrap();
        std::fs::write(&user, r#"{"retention":{"max_diagnostics":7}}"#).unwrap();

        let resolved = resolve_policy_with_options(
            &repo_dir,
            PolicyResolveOptions {
                user_config_path: Some(user),
                repo_config_path: Some(temp.path().join("missing-repo.json")),
                runtime: RuntimePolicyOverrides::default(),
            },
        );

        assert_eq!(resolved.policy.retention.max_diagnostics, 7);
        assert!(resolved.warnings.is_empty());
    }
}
