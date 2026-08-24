use codex_apply_patch::path_uri::PathUri;
use codex_apply_patch::standalone_executable::display_path;
use pretty_assertions::assert_eq;
use std::io::Write;
use std::process::{Command, Stdio};
use tempfile::tempdir;

#[rstest::rstest]
#[case(
    "file:///workspace/project",
    "file:///workspace/project/src/main.rs",
    "src/main.rs"
)]
#[case(
    "file:///C:/workspace/project",
    "file:///C:/workspace/project/src/main.rs",
    r"src\main.rs"
)]
#[case(
    "file://server/share/project",
    "file://server/share/project/src/main.rs",
    r"src\main.rs"
)]
#[case(
    "file:///workspace/project",
    "file:///C:/other/file.rs",
    r"C:\other\file.rs"
)]
fn display_path_uses_the_environment_or_foreign_path_convention(
    #[case] cwd: &str,
    #[case] path: &str,
    #[case] expected: &str,
) {
    let cwd = PathUri::parse(cwd).expect("valid cwd URI");
    let path = PathUri::parse(path).expect("valid path URI");

    assert_eq!(display_path(&cwd, &path), expected);
}

#[test]
fn json_result_contains_native_unified_diffs_for_separated_changes() {
    let cwd = tempdir().expect("temporary cwd");
    let contents = (1..=30)
        .map(|line| format!("line {line:02}"))
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    std::fs::write(cwd.path().join("separated.txt"), contents).expect("write fixture");

    let patch = "*** Begin Patch\n*** Update File: separated.txt\n@@\n-line 03\n+line 03 changed\n@@\n-line 15\n+line 15 changed\n@@\n-line 28\n+line 28 changed\n*** End Patch\n";
    let mut child = Command::new(env!("CARGO_BIN_EXE_apply_patch"))
        .current_dir(cwd.path())
        .env("PI_APPLY_PATCH_JSON", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start apply_patch");
    child
        .stdin
        .take()
        .expect("stdin")
        .write_all(patch.as_bytes())
        .expect("write patch");
    let output = child.wait_with_output().expect("wait for apply_patch");

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let json_line = stdout.lines().last().expect("structured JSON line");
    let result: serde_json::Value = serde_json::from_str(json_line).expect("structured output");
    assert!(result.get("changes").is_none());
    let diff = result["result"]["diff"].as_str().expect("unified diff");
    assert!(diff.starts_with("--- a/separated.txt\n+++ b/separated.txt\n"));
    assert!(diff.contains("@@ -2,3 +2,3 @@\n line 02\n-line 03\n+line 03 changed\n line 04"));
    assert!(diff.contains("@@ -14,3 +14,3 @@\n line 14\n-line 15\n+line 15 changed\n line 16"));
    assert!(diff.contains("@@ -27,3 +27,3 @@\n line 27\n-line 28\n+line 28 changed\n line 29"));
}
