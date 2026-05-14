//! Portable Codex apply-patch fixture scenarios adapted for `ct`.
//!
//! Most scenarios should match Codex's expected final filesystem snapshot.
//! Three scenarios intentionally diverge because `ct` keeps stricter safety
//! guardrails: no implicit Add overwrite, no implicit Move overwrite, and no
//! partial writes when a later hunk fails planning.

use assert_cmd::Command;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use tempfile::TempDir;

const SCENARIOS_DIR: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/codex_apply_patch_scenarios"
);

fn ct() -> Command {
    Command::cargo_bin("ct").unwrap()
}

#[test]
fn codex_apply_patch_fixture_scenarios_match_or_document_ct_divergence() {
    let mut scenarios = fs::read_dir(SCENARIOS_DIR)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.is_dir())
        .collect::<Vec<_>>();
    scenarios.sort();

    for scenario in scenarios {
        run_scenario(&scenario);
    }
}

fn run_scenario(scenario: &Path) {
    let name = scenario.file_name().unwrap().to_string_lossy();
    let sandbox = TempDir::new().unwrap();
    let state = TempDir::new().unwrap();

    let input_dir = scenario.join("input");
    if input_dir.is_dir() {
        copy_dir_recursive(&input_dir, sandbox.path());
    }

    let patch = fs::read_to_string(scenario.join("patch.txt")).unwrap();
    let _output = ct()
        .arg("apply-patch")
        .arg("--cwd")
        .arg(sandbox.path())
        .env("XDG_DATA_HOME", state.path())
        .write_stdin(patch)
        .output()
        .unwrap();

    let expected_dir = match name.as_ref() {
        // Codex allows overwrites in these scenarios. `ct` requires explicit
        // Delete+Add / Delete+Move intent, so the failed patch leaves input.
        "010_move_overwrites_existing_destination" | "011_add_overwrites_existing_file" => {
            scenario.join("input")
        }
        // Codex's standalone patcher can leave earlier writes after a later
        // failure. `ct` plans before commit and keeps the filesystem unchanged.
        "015_failure_after_partial_success_leaves_changes" => scenario.join("input"),
        _ => scenario.join("expected"),
    };

    let expected = snapshot_files(&expected_dir);
    let actual = snapshot_files(sandbox.path());
    assert_eq!(
        actual, expected,
        "scenario {name} final filesystem did not match expected ct behavior"
    );
}

fn copy_dir_recursive(src: &Path, dst: &Path) {
    for entry in fs::read_dir(src).unwrap() {
        let entry = entry.unwrap();
        let path = entry.path();
        let dest = dst.join(entry.file_name());
        let metadata = fs::metadata(&path).unwrap();
        if metadata.is_dir() {
            fs::create_dir_all(&dest).unwrap();
            copy_dir_recursive(&path, &dest);
        } else if metadata.is_file() {
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::copy(&path, &dest).unwrap();
        }
    }
}

fn snapshot_files(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    let mut entries = BTreeMap::new();
    if root.is_dir() {
        snapshot_files_recursive(root, root, &mut entries);
    }
    entries
}

fn snapshot_files_recursive(base: &Path, dir: &Path, entries: &mut BTreeMap<PathBuf, Vec<u8>>) {
    for entry in fs::read_dir(dir).unwrap() {
        let entry = entry.unwrap();
        let path = entry.path();
        let rel = path.strip_prefix(base).unwrap().to_path_buf();
        let metadata = fs::metadata(&path).unwrap();
        if metadata.is_dir() {
            snapshot_files_recursive(base, &path, entries);
        } else if metadata.is_file() {
            entries.insert(rel, fs::read(&path).unwrap());
        }
    }
}
