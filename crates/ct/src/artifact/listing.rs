use std::fs;
use std::path::Path;
use std::time::SystemTime;

use super::{Artifact, ArtifactKind, blueprints_dir, extract_frontmatter_full};

pub fn list_artifacts(kind: ArtifactKind, include_dives: bool) -> Vec<Artifact> {
    list_artifacts_filtered(kind, false, include_dives, None)
}

pub fn list_archived_artifacts(kind: ArtifactKind) -> Vec<Artifact> {
    list_artifacts_filtered(kind, true, false, None)
}

fn list_artifacts_filtered(
    kind: ArtifactKind,
    archived: bool,
    include_dives: bool,
    project_filter: Option<&str>,
) -> Vec<Artifact> {
    let bp = blueprints_dir();
    let mut artifacts = Vec::new();
    let Ok(entries) = fs::read_dir(&bp) else {
        return artifacts;
    };
    for entry in entries.flatten() {
        let proj_path = entry.path();
        if !proj_path.is_dir() {
            continue;
        }
        let proj_name = proj_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();

        if let Some(filter) = project_filter
            && proj_name != filter
        {
            continue;
        }

        if archived {
            let archive_dir = proj_path.join("archive").join(kind.dir_name());
            collect_artifacts(&bp, &archive_dir, &proj_name, &mut artifacts);
            if kind == ArtifactKind::Spec {
                let archive_dive_dir = proj_path.join("archive").join("dive");
                collect_artifacts(&bp, &archive_dive_dir, &proj_name, &mut artifacts);
            }
        } else {
            let kind_dir = proj_path.join(kind.dir_name());
            collect_artifacts(&bp, &kind_dir, &proj_name, &mut artifacts);
            if include_dives && kind == ArtifactKind::Spec {
                let dive_dir = proj_path.join("dive");
                collect_artifacts(&bp, &dive_dir, &proj_name, &mut artifacts);
            }
        }
    }
    artifacts.sort_by_key(|a| std::cmp::Reverse(a.mod_time));
    artifacts
}

fn collect_artifacts(base: &Path, dir: &Path, fallback_project: &str, out: &mut Vec<Artifact>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            continue;
        }
        if path.extension().is_none_or(|ext| ext != "md") {
            continue;
        }
        let Some(info) = entry.metadata().ok() else {
            continue;
        };
        let name = path
            .strip_prefix(base)
            .unwrap_or(&path)
            .with_extension("")
            .to_string_lossy()
            .to_string();
        let (title, _, created, source, tags, author) = extract_frontmatter_full(&path);
        out.push(Artifact {
            name,
            path,
            title,
            project: fallback_project.to_string(),
            mod_time: info.modified().unwrap_or(SystemTime::UNIX_EPOCH),
            size: info.len(),
            created,
            source,
            tags,
            author,
        });
    }
}
