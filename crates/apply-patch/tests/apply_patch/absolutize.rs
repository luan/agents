use codex_apply_patch::absolute_path::absolutize::absolutize_from;
use pretty_assertions::assert_eq;
use std::path::{Path, PathBuf};

#[cfg(unix)]
#[rstest::rstest]
#[case("/path/to/123/456", "/base", "/path/to/123/456")]
#[case("/path/to/./123/../456", "/base", "/path/to/456")]
#[case("path/to/123/456", "/base", "/base/path/to/123/456")]
#[case("./path/to/123/456", "/base", "/base/path/to/123/456")]
#[case("../path/to/123/456", "/base/cwd", "/base/path/to/123/456")]
#[case("../../path/to/123/456", "/", "/path/to/123/456")]
#[case("", "/base/cwd", "/base/cwd")]
fn unix_paths_are_absolutized_against_the_base(
    #[case] path: &str,
    #[case] base: &str,
    #[case] expected: &str,
) {
    assert_eq!(
        absolutize_from(Path::new(path), Path::new(base)),
        PathBuf::from(expected)
    );
}

#[cfg(windows)]
#[rstest::rstest]
#[case(r"\path\to\file", r"C:\base\cwd", r"C:\path\to\file")]
#[case(r"D:path\to\file", r"C:\base\cwd", r"D:\base\cwd\path\to\file")]
fn windows_paths_are_absolutized_against_the_base(
    #[case] path: &str,
    #[case] base: &str,
    #[case] expected: &str,
) {
    assert_eq!(
        absolutize_from(Path::new(path), Path::new(base)),
        PathBuf::from(expected)
    );
}
