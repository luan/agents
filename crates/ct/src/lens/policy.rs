use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::contract::LensMessage;
use super::retention::RetentionPolicy;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LensGuardMode {
    Off,
    Warn,
    Block,
}

impl Default for LensGuardMode {
    fn default() -> Self {
        Self::Block
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LensGuardPolicy {
    pub mode: LensGuardMode,
    pub allow_overrides: bool,
}

impl Default for LensGuardPolicy {
    fn default() -> Self {
        Self {
            mode: LensGuardMode::Block,
            allow_overrides: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LensPolicy {
    pub guard: LensGuardPolicy,
    pub retention: RetentionPolicy,
}

impl Default for LensPolicy {
    fn default() -> Self {
        Self {
            guard: LensGuardPolicy::default(),
            retention: RetentionPolicy::default(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimePolicyOverrides {
    pub guard_mode: Option<LensGuardMode>,
    pub allow_overrides: Option<bool>,
}

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
    guard: Option<LensGuardPolicyConfig>,
    retention: Option<RetentionPolicyConfig>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct LensGuardPolicyConfig {
    mode: Option<LensGuardMode>,
    allow_overrides: Option<bool>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct RetentionPolicyConfig {
    max_diagnostics: Option<i64>,
    max_tool_runs: Option<i64>,
    max_sessions: Option<i64>,
    max_patch_drafts: Option<i64>,
    max_patch_draft_bodies: Option<i64>,
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
    if let Some(guard) = config.guard {
        if let Some(mode) = guard.mode {
            policy.guard.mode = mode;
        }
        if let Some(allow_overrides) = guard.allow_overrides {
            policy.guard.allow_overrides = allow_overrides;
        }
    }
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
    }
}

fn apply_runtime(
    runtime: RuntimePolicyOverrides,
    policy: &mut LensPolicy,
    layers: &mut Vec<PolicyLayerStatus>,
) {
    let applied = runtime.guard_mode.is_some() || runtime.allow_overrides.is_some();
    if let Some(mode) = runtime.guard_mode {
        policy.guard.mode = mode;
    }
    if let Some(allow_overrides) = runtime.allow_overrides {
        policy.guard.allow_overrides = allow_overrides;
    }
    layers.push(PolicyLayerStatus {
        layer: "runtime".to_string(),
        path: None,
        present: applied,
        applied,
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
    fn policy_layers_apply_repository_over_weaker_user_default_and_runtime_last() {
        let temp = tempfile::tempdir().unwrap();
        let user = temp.path().join("user.json");
        let repo_dir = temp.path().join("repo");
        std::fs::create_dir_all(&repo_dir).unwrap();
        let repo = repo_dir.join("lens.json");
        std::fs::write(
            &user,
            r#"{"guard":{"mode":"off","allow_overrides":true},"retention":{"max_diagnostics":7}}"#,
        )
        .unwrap();
        std::fs::write(
            &repo,
            r#"{"guard":{"mode":"block","allow_overrides":false}}"#,
        )
        .unwrap();

        let resolved = resolve_policy_with_options(
            &repo_dir,
            PolicyResolveOptions {
                user_config_path: Some(user),
                repo_config_path: Some(repo),
                runtime: RuntimePolicyOverrides::default(),
            },
        );

        assert_eq!(resolved.policy.guard.mode, LensGuardMode::Block);
        assert!(!resolved.policy.guard.allow_overrides);
        assert_eq!(resolved.policy.retention.max_diagnostics, 7);
        assert!(resolved.warnings.is_empty());

        let runtime = resolve_policy_with_options(
            &repo_dir,
            PolicyResolveOptions {
                user_config_path: Some(temp.path().join("missing-user.json")),
                repo_config_path: Some(temp.path().join("missing-repo.json")),
                runtime: RuntimePolicyOverrides {
                    guard_mode: Some(LensGuardMode::Warn),
                    allow_overrides: Some(true),
                },
            },
        );
        assert_eq!(runtime.policy.guard.mode, LensGuardMode::Warn);
        assert!(runtime.policy.guard.allow_overrides);
    }
}
