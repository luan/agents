use codex_apply_patch::absolute_path::*;
use dirs::home_dir;
use std::path::PathBuf;

fn test_path_buf(unix_path: &str) -> PathBuf {
    if cfg!(windows) {
        let mut path = PathBuf::from(r"C:\");
        path.extend(
            unix_path
                .trim_start_matches('/')
                .split('/')
                .filter(|segment| !segment.is_empty()),
        );
        path
    } else {
        PathBuf::from(unix_path)
    }
}

use assert_fs::TempDir;
use pretty_assertions::assert_eq;
use std::fs;
#[cfg(unix)]
use std::process::Command;

#[test]
fn create_with_absolute_path_ignores_base_path() {
    let base_dir = TempDir::new().expect("base dir");
    let absolute_dir = TempDir::new().expect("absolute dir");
    let base_path = base_dir.path();
    let absolute_path = absolute_dir.path().join("file.txt");
    let abs_path_buf = AbsolutePathBuf::resolve_path_against_base(absolute_path.clone(), base_path);
    assert_eq!(abs_path_buf.as_path(), absolute_path.as_path());
}

#[cfg(unix)]
#[test]
fn from_absolute_path_does_not_read_current_dir_when_path_is_absolute() {
    let status = Command::new(std::env::current_exe().expect("current test binary"))
        .arg("from_absolute_path_with_removed_current_dir_child")
        .env("CODEX_ABSOLUTE_PATH_REMOVED_CWD_CHILD", "1")
        .status()
        .expect("run child test");

    assert!(status.success());
}

#[cfg(unix)]
#[test]
fn from_absolute_path_with_removed_current_dir_child() {
    if std::env::var_os("CODEX_ABSOLUTE_PATH_REMOVED_CWD_CHILD").is_none() {
        return;
    }

    let original_cwd = std::env::current_dir().expect("original cwd");
    let temp_dir = TempDir::new().expect("temp dir");
    let removed_cwd = temp_dir.path().to_path_buf();
    std::env::set_current_dir(&removed_cwd).expect("enter temp dir");
    std::fs::remove_dir(&removed_cwd).expect("remove current dir");
    std::env::current_dir().expect_err("current dir should be unavailable");

    let path = AbsolutePathBuf::from_absolute_path(test_path_buf(
        "/tmp/codex/../codex-home/plugins/cache",
    ))
    .expect("absolute path should not require current dir");

    std::env::set_current_dir(original_cwd).expect("restore cwd");
    assert_eq!(
        path.as_path(),
        test_path_buf("/tmp/codex-home/plugins/cache")
    );
}

#[test]
fn from_absolute_path_checked_rejects_relative_path() {
    let err = AbsolutePathBuf::from_absolute_path_checked("relative/path")
        .expect_err("relative path should fail");

    assert_eq!(err.kind(), std::io::ErrorKind::InvalidInput);
}

#[test]
fn normalize_windows_device_path_strips_supported_verbatim_prefixes() {
    assert_eq!(
        normalize_windows_device_path(r"\\?\D:\c\x\worktrees\2508\swift-base"),
        Some(r"D:\c\x\worktrees\2508\swift-base".to_string())
    );
    assert_eq!(
        normalize_windows_device_path(r"\\.\D:\c\x\worktrees\2508\swift-base"),
        Some(r"D:\c\x\worktrees\2508\swift-base".to_string())
    );
    assert_eq!(
        normalize_windows_device_path(r"\\?\UNC\server\share\workspace"),
        Some(r"\\server\share\workspace".to_string())
    );
    assert_eq!(
        normalize_windows_device_path(r"\\.\UNC\server\share\workspace"),
        Some(r"\\server\share\workspace".to_string())
    );
    assert_eq!(
        normalize_windows_device_path(r"\\?\GLOBALROOT\Device"),
        None
    );
}

#[cfg(target_os = "windows")]
#[test]
fn from_absolute_path_strips_windows_verbatim_prefix() {
    let path = AbsolutePathBuf::from_absolute_path_checked(r"\\?\D:\c\x\worktrees\2508\swift-base")
        .expect("verbatim drive path should be absolute");

    assert_eq!(
        path.as_path(),
        Path::new(r"D:\c\x\worktrees\2508\swift-base")
    );
}

#[test]
fn relative_path_is_resolved_against_base_path() {
    let temp_dir = TempDir::new().expect("base dir");
    let base_dir = temp_dir.path();
    let abs_path_buf = AbsolutePathBuf::resolve_path_against_base("file.txt", base_dir);
    assert_eq!(abs_path_buf.as_path(), base_dir.join("file.txt").as_path());
}

#[test]
fn relative_path_dots_are_normalized_against_base_path() {
    let temp_dir = TempDir::new().expect("base dir");
    let base_dir = temp_dir.path();
    let abs_path_buf = AbsolutePathBuf::resolve_path_against_base("./nested/../file.txt", base_dir);
    assert_eq!(abs_path_buf.as_path(), base_dir.join("file.txt").as_path());
}

#[test]
fn canonicalize_returns_absolute_path_buf() {
    let temp_dir = TempDir::new().expect("base dir");
    fs::create_dir(temp_dir.path().join("one")).expect("create one dir");
    fs::create_dir(temp_dir.path().join("two")).expect("create two dir");
    fs::write(temp_dir.path().join("two").join("file.txt"), "").expect("write file");
    let abs_path_buf =
        AbsolutePathBuf::from_absolute_path(temp_dir.path().join("one/../two/./file.txt"))
            .expect("absolute path");
    assert_eq!(
        abs_path_buf
            .canonicalize()
            .expect("path should canonicalize")
            .as_path(),
        dunce::canonicalize(temp_dir.path().join("two").join("file.txt"))
            .expect("expected path should canonicalize")
            .as_path()
    );
}

#[test]
fn canonicalize_returns_error_for_missing_path() {
    let temp_dir = TempDir::new().expect("base dir");
    let abs_path_buf = AbsolutePathBuf::from_absolute_path(temp_dir.path().join("missing.txt"))
        .expect("absolute path");

    assert!(abs_path_buf.canonicalize().is_err());
}

#[test]
fn ancestors_returns_absolute_path_bufs() {
    let abs_path_buf = AbsolutePathBuf::from_absolute_path_checked(test_path_buf("/tmp/one/two"))
        .expect("absolute path");

    let ancestors = abs_path_buf
        .ancestors()
        .map(|path| path.to_path_buf())
        .collect::<Vec<_>>();

    let expected = vec![
        test_path_buf("/tmp/one/two"),
        test_path_buf("/tmp/one"),
        test_path_buf("/tmp"),
        test_path_buf("/"),
    ];

    assert_eq!(ancestors, expected);
}

#[test]
fn relative_to_current_dir_resolves_relative_path() -> std::io::Result<()> {
    let current_dir = std::env::current_dir()?;
    let abs_path_buf = AbsolutePathBuf::relative_to_current_dir("file.txt")?;
    assert_eq!(
        abs_path_buf.as_path(),
        current_dir.join("file.txt").as_path()
    );
    Ok(())
}

#[test]
fn guard_used_in_deserialization() {
    let temp_dir = TempDir::new().expect("base dir");
    let base_dir = temp_dir.path();
    let relative_path = "subdir/file.txt";
    let abs_path_buf = {
        let _guard = AbsolutePathBufGuard::new(base_dir);
        serde_json::from_str::<AbsolutePathBuf>(&format!(r#""{relative_path}""#))
            .expect("failed to deserialize")
    };
    assert_eq!(
        abs_path_buf.as_path(),
        base_dir.join(relative_path).as_path()
    );
}

#[test]
fn home_directory_root_is_expanded_in_deserialization() {
    let Some(home) = home_dir() else {
        return;
    };
    let temp_dir = TempDir::new().expect("base dir");
    let abs_path_buf = {
        let _guard = AbsolutePathBufGuard::new(temp_dir.path());
        serde_json::from_str::<AbsolutePathBuf>("\"~\"").expect("failed to deserialize")
    };
    assert_eq!(abs_path_buf.as_path(), home.as_path());
}

#[test]
fn home_directory_subpath_is_expanded_in_deserialization() {
    let Some(home) = home_dir() else {
        return;
    };
    let temp_dir = TempDir::new().expect("base dir");
    let abs_path_buf = {
        let _guard = AbsolutePathBufGuard::new(temp_dir.path());
        serde_json::from_str::<AbsolutePathBuf>("\"~/code\"").expect("failed to deserialize")
    };
    assert_eq!(abs_path_buf.as_path(), home.join("code").as_path());
}

#[test]
fn home_directory_double_slash_is_expanded_in_deserialization() {
    let Some(home) = home_dir() else {
        return;
    };
    let temp_dir = TempDir::new().expect("base dir");
    let abs_path_buf = {
        let _guard = AbsolutePathBufGuard::new(temp_dir.path());
        serde_json::from_str::<AbsolutePathBuf>("\"~//code\"").expect("failed to deserialize")
    };
    assert_eq!(abs_path_buf.as_path(), home.join("code").as_path());
}

#[cfg(unix)]
#[test]
fn canonicalize_preserving_symlinks_keeps_logical_symlink_path() {
    let temp_dir = TempDir::new().expect("temp dir");
    let real = temp_dir.path().join("real");
    let link = temp_dir.path().join("link");
    std::fs::create_dir_all(&real).expect("create real dir");
    std::os::unix::fs::symlink(&real, &link).expect("create symlink");

    let canonicalized =
        canonicalize_preserving_symlinks(&link).expect("canonicalize preserving symlinks");

    assert_eq!(canonicalized, link);
}

#[cfg(unix)]
#[test]
fn canonicalize_preserving_symlinks_keeps_logical_missing_child_under_symlink() {
    let temp_dir = TempDir::new().expect("temp dir");
    let real = temp_dir.path().join("real");
    let link = temp_dir.path().join("link");
    std::fs::create_dir_all(&real).expect("create real dir");
    std::os::unix::fs::symlink(&real, &link).expect("create symlink");
    let missing = link.join("missing.txt");

    let canonicalized =
        canonicalize_preserving_symlinks(&missing).expect("canonicalize preserving symlinks");

    assert_eq!(canonicalized, missing);
}

#[test]
fn canonicalize_existing_preserving_symlinks_errors_for_missing_path() {
    let temp_dir = TempDir::new().expect("temp dir");
    let missing = temp_dir.path().join("missing");

    let err = canonicalize_existing_preserving_symlinks(&missing)
        .expect_err("missing path should fail canonicalization");

    assert_eq!(err.kind(), std::io::ErrorKind::NotFound);
}

#[cfg(unix)]
#[test]
fn canonicalize_existing_preserving_symlinks_keeps_logical_symlink_path() {
    let temp_dir = TempDir::new().expect("temp dir");
    let real = temp_dir.path().join("real");
    let link = temp_dir.path().join("link");
    std::fs::create_dir_all(&real).expect("create real dir");
    std::os::unix::fs::symlink(&real, &link).expect("create symlink");

    let canonicalized =
        canonicalize_existing_preserving_symlinks(&link).expect("canonicalize symlink");

    assert_eq!(canonicalized, link);
}

#[cfg(target_os = "windows")]
#[test]
fn home_directory_backslash_subpath_is_expanded_in_deserialization() {
    let Some(home) = home_dir() else {
        return;
    };
    let temp_dir = TempDir::new().expect("base dir");
    let abs_path_buf = {
        let _guard = AbsolutePathBufGuard::new(temp_dir.path());
        let input = serde_json::to_string(r#"~\code"#).expect("string should serialize as JSON");
        serde_json::from_str::<AbsolutePathBuf>(&input).expect("is valid abs path")
    };
    assert_eq!(abs_path_buf.as_path(), home.join("code").as_path());
}

#[cfg(target_os = "windows")]
#[test]
fn canonicalize_preserving_symlinks_avoids_verbatim_prefixes() {
    let temp_dir = TempDir::new().expect("temp dir");

    let canonicalized = canonicalize_preserving_symlinks(temp_dir.path()).expect("canonicalize");

    assert_eq!(
        canonicalized,
        dunce::canonicalize(temp_dir.path()).expect("canonicalize temp dir")
    );
    assert!(
        !canonicalized.to_string_lossy().starts_with(r"\\?\"),
        "expected a non-verbatim Windows path, got {canonicalized:?}"
    );
}
