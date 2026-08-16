use pretty_assertions::assert_eq;
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use tempfile::tempdir;

#[test]
fn test_apply_patch_scenarios() -> anyhow::Result<()> {
    let scenarios_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("scenarios");
    for scenario in fs::read_dir(scenarios_dir)? {
        let scenario = scenario?;
        let path = scenario.path();
        if path.is_dir() {
            run_apply_patch_scenario(&path)?;
        }
    }
    Ok(())
}

/// Runs apply-patch and asserts its exit status and final filesystem state.
fn run_apply_patch_scenario(dir: &Path) -> anyhow::Result<()> {
    let tmp = tempdir()?;

    // Copy the input files to the temporary directory
    let input_dir = dir.join("input");
    if input_dir.is_dir() {
        copy_dir_recursive(&input_dir, tmp.path())?;
    }

    // Read the patch.txt file
    let patch = fs::read_to_string(dir.join("patch.txt"))?;

    let output = Command::new(env!("CARGO_BIN_EXE_apply_patch"))
        .arg(patch)
        .current_dir(tmp.path())
        .output()?;
    let expected_success = !dir.join("expected_failure").is_file();
    assert_eq!(
        output.status.success(),
        expected_success,
        "Scenario {} exited with {:?}.\nstderr:\n{}",
        dir.display(),
        output.status.code(),
        String::from_utf8_lossy(&output.stderr),
    );

    // Assert that the final state matches the expected state exactly
    let expected_dir = dir.join("expected");
    let expected_snapshot = snapshot_dir(&expected_dir)?;
    let actual_snapshot = snapshot_dir(tmp.path())?;

    assert_eq!(
        actual_snapshot,
        expected_snapshot,
        "Scenario {} did not match expected final state",
        dir.display()
    );

    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Entry {
    File(Vec<u8>),
    Dir,
}

fn snapshot_dir(root: &Path) -> anyhow::Result<BTreeMap<PathBuf, Entry>> {
    let mut entries = BTreeMap::new();
    if root.is_dir() {
        snapshot_dir_recursive(root, root, &mut entries)?;
    }
    Ok(entries)
}

fn snapshot_dir_recursive(
    base: &Path,
    dir: &Path,
    entries: &mut BTreeMap<PathBuf, Entry>,
) -> anyhow::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let Some(stripped) = path.strip_prefix(base).ok() else {
            continue;
        };
        let rel = stripped.to_path_buf();

        // Under Buck2, files in `__srcs` are often materialized as symlinks.
        // Use `metadata()` (follows symlinks) so our fixture snapshots work
        // under both Cargo and Buck2.
        let metadata = fs::metadata(&path)?;
        if metadata.is_dir() {
            entries.insert(rel.clone(), Entry::Dir);
            snapshot_dir_recursive(base, &path, entries)?;
        } else if metadata.is_file() {
            let contents = fs::read(&path)?;
            entries.insert(rel, Entry::File(contents));
        }
    }
    Ok(())
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> anyhow::Result<()> {
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let path = entry.path();
        let dest_path = dst.join(entry.file_name());

        // See note in `snapshot_dir_recursive` about Buck2 symlink trees.
        let metadata = fs::metadata(&path)?;
        if metadata.is_dir() {
            fs::create_dir_all(&dest_path)?;
            copy_dir_recursive(&path, &dest_path)?;
        } else if metadata.is_file() {
            if let Some(parent) = dest_path.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(&path, &dest_path)?;
        }
    }
    Ok(())
}
