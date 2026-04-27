use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::json;

use super::contract::{LensEnvelope, LensMessage, LensResponseStatus};
use super::policy::{
    PolicyResolveOptions, ResolvedLensPolicy, RuntimePolicyOverrides, resolve_policy_with_options,
};
use super::store::{LensStore, StoreCounts};
use super::types::{Diagnostic, DiagnosticSeverity};

#[derive(Debug, Clone, Default)]
pub struct LensStatusOptions {
    pub include_disk: bool,
    pub include_debug: bool,
    pub include_raw: bool,
    pub runtime_policy: RuntimePolicyOverrides,
    pub tool_commands: Option<Vec<ToolRequirement>>,
    pub policy_options: Option<PolicyResolveOptions>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolRequirement {
    pub command: String,
    pub purpose: String,
    pub install_hint: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LensStatusData {
    pub project_id: i64,
    pub state: LensStateStatus,
    pub policy: ResolvedLensPolicy,
    pub health: LensHealth,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LensStateStatus {
    pub state_dir: String,
    pub db_path: String,
    pub stored_outside_repository: bool,
    pub db_bytes: Option<u64>,
    pub counts: StoreCounts,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LensHealth {
    pub status: LensResponseStatus,
    pub diagnostics: DiagnosticHealth,
    pub tools: Vec<ToolHint>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiagnosticHealth {
    pub total: usize,
    pub errors: usize,
    pub warnings: usize,
    pub info: usize,
    pub hints: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolHint {
    pub command: String,
    pub available: bool,
    pub purpose: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

pub fn build_status_envelope(
    root: &Path,
    mut options: LensStatusOptions,
) -> Result<LensEnvelope<LensStatusData>, Box<dyn std::error::Error>> {
    let store = LensStore::open_for_project(root)?;
    let counts = store.counts()?;
    let diagnostics = store.list_diagnostics(None)?;
    let db_path = super::paths::project_db_path(root)?;
    let state_dir = super::paths::project_state_dir(root)?;
    let canonical_root = root.canonicalize()?;
    let resolved_policy = resolve_status_policy(root, &mut options);
    let tool_requirements = options
        .tool_commands
        .unwrap_or_else(default_tool_requirements);
    let tools = tool_hints_for(tool_requirements);

    let mut warnings = resolved_policy.warnings.clone();
    for tool in &tools {
        if !tool.available {
            warnings.push(LensMessage::warning_with_hint(
                "tool_missing",
                format!("optional Lens tool '{}' is not available", tool.command),
                tool.hint.clone().unwrap_or_else(|| {
                    "install the tool or disable the related Lens feature".to_string()
                }),
            ));
        }
    }

    let diagnostic_health = diagnostic_health(&diagnostics);
    let health_status = if diagnostic_health.errors > 0 {
        LensResponseStatus::Error
    } else if diagnostic_health.warnings > 0 || !warnings.is_empty() {
        LensResponseStatus::Warning
    } else {
        LensResponseStatus::Ok
    };
    let errors = if diagnostic_health.errors > 0 {
        vec![LensMessage::error(
            "diagnostics_error",
            format!(
                "{} error diagnostics are recorded",
                diagnostic_health.errors
            ),
        )]
    } else {
        Vec::new()
    };
    let data = LensStatusData {
        project_id: store.project_id(),
        state: LensStateStatus {
            state_dir: state_dir.display().to_string(),
            db_path: db_path.display().to_string(),
            stored_outside_repository: !path_starts_with(&state_dir, &canonical_root),
            db_bytes: if options.include_disk && db_path.exists() {
                Some(std::fs::metadata(&db_path)?.len())
            } else {
                None
            },
            counts,
        },
        policy: resolved_policy,
        health: LensHealth {
            status: health_status.clone(),
            diagnostics: diagnostic_health,
            tools,
        },
    };

    let mut envelope = if !errors.is_empty() {
        LensEnvelope::error(data, errors)
    } else if !warnings.is_empty() {
        LensEnvelope::warning(data, warnings)
    } else {
        LensEnvelope::ok(data)
    };
    if options.include_debug {
        let policy_layer_count = envelope.data.policy.layers.len();
        envelope = envelope.with_debug(json!({
            "root": canonical_root,
            "policy_layer_count": policy_layer_count,
        }));
    }
    if options.include_raw {
        let policy_layers = envelope.data.policy.layers.clone();
        let tool_hints = envelope.data.health.tools.clone();
        envelope = envelope.with_raw(json!({
            "policy_layers": policy_layers,
            "tool_hints": tool_hints,
        }));
    }
    Ok(envelope)
}

fn resolve_status_policy(root: &Path, options: &mut LensStatusOptions) -> ResolvedLensPolicy {
    let mut policy_options = options.policy_options.take().unwrap_or_default();
    if policy_options.runtime == RuntimePolicyOverrides::default() {
        policy_options.runtime = options.runtime_policy.clone();
    }
    resolve_policy_with_options(root, policy_options)
}

fn diagnostic_health(diagnostics: &[Diagnostic]) -> DiagnosticHealth {
    let mut health = DiagnosticHealth {
        total: diagnostics.len(),
        errors: 0,
        warnings: 0,
        info: 0,
        hints: 0,
    };
    for diagnostic in diagnostics {
        match diagnostic.severity {
            DiagnosticSeverity::Error => health.errors += 1,
            DiagnosticSeverity::Warning => health.warnings += 1,
            DiagnosticSeverity::Info => health.info += 1,
            DiagnosticSeverity::Hint => health.hints += 1,
        }
    }
    health
}

pub fn tool_hints_for(requirements: Vec<ToolRequirement>) -> Vec<ToolHint> {
    requirements
        .into_iter()
        .map(|requirement| {
            let available = command_available(&requirement.command);
            ToolHint {
                command: requirement.command,
                available,
                purpose: requirement.purpose,
                hint: (!available).then_some(requirement.install_hint),
            }
        })
        .collect()
}

fn default_tool_requirements() -> Vec<ToolRequirement> {
    vec![
        ToolRequirement {
            command: "git".to_string(),
            purpose: "repository identity and changed-file fallback".to_string(),
            install_hint: "install git or run Lens in a project where git is available".to_string(),
        },
        ToolRequirement {
            command: "sg".to_string(),
            purpose: "AST search/replace diagnostics and cleanup discovery".to_string(),
            install_hint: "install ast-grep (sg) to enable AST-backed Lens features".to_string(),
        },
    ]
}

fn command_available(command: &str) -> bool {
    let path = Path::new(command);
    if path.components().count() > 1 {
        return path.is_file();
    }
    let Some(paths) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&paths).any(|dir| dir.join(command).is_file())
}

fn path_starts_with(path: &Path, prefix: &Path) -> bool {
    let path = normalize_for_prefix(path);
    let prefix = normalize_for_prefix(prefix);
    path.starts_with(prefix)
}

fn normalize_for_prefix(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn health_envelope_serializes_counts_and_schema() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("main.rs"), "fn main() {}\n").unwrap();
        let mut store = LensStore::open_in_memory_for_tests(temp.path()).unwrap();
        store
            .record_diagnostics(&[Diagnostic {
                source: super::super::types::DiagnosticSource::Test,
                severity: DiagnosticSeverity::Warning,
                code: None,
                message: "warn".to_string(),
                rel_path: Some("main.rs".to_string()),
                start_line: Some(1),
                end_line: Some(1),
                fingerprint: "warn-1".to_string(),
                content_hash: None,
            }])
            .unwrap();
        let health = LensHealth {
            status: LensResponseStatus::Warning,
            diagnostics: DiagnosticHealth {
                total: 1,
                errors: 0,
                warnings: 1,
                info: 0,
                hints: 0,
            },
            tools: Vec::new(),
        };
        let envelope = LensEnvelope::warning(
            health,
            vec![LensMessage::warning(
                "diagnostics_warning",
                "warning diagnostics are recorded",
            )],
        );
        let value = serde_json::to_value(&envelope).unwrap();
        assert_eq!(
            value["schema_version"],
            super::super::contract::LENS_RESPONSE_SCHEMA_VERSION
        );
        assert_eq!(value["status"], "warning");
        assert_eq!(value["data"]["diagnostics"]["warnings"], 1);
    }

    #[test]
    fn missing_tools_are_reported_as_hints_not_failures() {
        let hints = tool_hints_for(vec![ToolRequirement {
            command: "ct-lens-definitely-missing-tool".to_string(),
            purpose: "test".to_string(),
            install_hint: "install the fixture".to_string(),
        }]);

        assert_eq!(hints.len(), 1);
        assert!(!hints[0].available);
        assert_eq!(hints[0].hint.as_deref(), Some("install the fixture"));
    }

    #[test]
    fn state_status_points_outside_repository() {
        let temp = tempfile::tempdir().unwrap();
        let envelope = build_status_envelope(
            temp.path(),
            LensStatusOptions {
                tool_commands: Some(Vec::new()),
                ..LensStatusOptions::default()
            },
        )
        .unwrap();
        assert!(envelope.data.state.stored_outside_repository);
        assert!(!Path::new(&envelope.data.state.db_path).starts_with(temp.path()));
    }
}
