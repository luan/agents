use assert_fs::TempDir;
use assert_fs::prelude::*;
use codex_apply_patch::fs::*;
use codex_apply_patch::path_uri::PathUri;
use pretty_assertions::assert_eq;
use std::io;

#[rstest::fixture]
fn temp_dir() -> TempDir {
    TempDir::new().expect("filesystem fixture directory")
}

#[rstest::rstest]
#[tokio::test]
async fn local_filesystem_reads_host_path_uris(temp_dir: TempDir) {
    let dir = temp_dir;
    let file = dir.child("file.txt");
    file.write_str("hello").unwrap();
    let uri = PathUri::from_host_native_path(file.path()).unwrap();

    assert_eq!(LOCAL_FS.read_file_text(&uri, None).await.unwrap(), "hello");
}

#[rstest::rstest]
#[tokio::test]
async fn local_filesystem_rejects_sandbox_contexts(temp_dir: TempDir) {
    let dir = temp_dir;
    let uri = PathUri::from_host_native_path(dir.path().join("file.txt")).unwrap();
    let error = LOCAL_FS
        .write_file(&uri, b"hello".to_vec(), Some(&FileSystemSandboxContext))
        .await
        .unwrap_err();

    assert_eq!(error.kind(), io::ErrorKind::Unsupported);
}
