//! Local filesystem operations for the patch engine.
//!
//! Upstream routes this contract through Codex's exec-server and sandbox stack, behind an
//! `ExecutorFileSystem` trait. Pi applies patches on the host, so there is one implementation and
//! no sandbox. These are the operations the patch engine calls, and nothing else.

use crate::path_uri::PathUri;
use std::io;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CreateDirectoryOptions {
    pub recursive: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RemoveOptions {
    pub recursive: bool,
    pub force: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FileMetadata {
    pub is_directory: bool,
    pub is_file: bool,
    pub is_symlink: bool,
}

fn local_path(path: &PathUri) -> io::Result<std::path::PathBuf> {
    Ok(path.to_abs_path()?.into_path_buf())
}

pub fn read_file_text(path: &PathUri) -> io::Result<String> {
    let bytes = std::fs::read(local_path(path)?)?;
    String::from_utf8(bytes).map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))
}

pub fn write_file(path: &PathUri, contents: Vec<u8>) -> io::Result<()> {
    std::fs::write(local_path(path)?, contents)
}

pub fn create_directory(path: &PathUri, options: CreateDirectoryOptions) -> io::Result<()> {
    let path = local_path(path)?;
    if options.recursive {
        std::fs::create_dir_all(path)
    } else {
        std::fs::create_dir(path)
    }
}

pub fn get_metadata(path: &PathUri) -> io::Result<FileMetadata> {
    let metadata = std::fs::symlink_metadata(local_path(path)?)?;
    Ok(FileMetadata {
        is_directory: metadata.is_dir(),
        is_file: metadata.is_file(),
        is_symlink: metadata.file_type().is_symlink(),
    })
}

pub fn remove(path: &PathUri, options: RemoveOptions) -> io::Result<()> {
    let path = local_path(path)?;
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if options.force && error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if metadata.is_dir() {
        if options.recursive {
            std::fs::remove_dir_all(path)
        } else {
            std::fs::remove_dir(path)
        }
    } else {
        std::fs::remove_file(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_host_path_uri() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file.txt");
        std::fs::write(&path, "hello").unwrap();
        let uri = PathUri::from_host_native_path(&path).unwrap();

        assert_eq!(read_file_text(&uri).unwrap(), "hello");
    }

    #[test]
    fn force_remove_ignores_a_missing_path() {
        let dir = tempfile::tempdir().unwrap();
        let uri = PathUri::from_host_native_path(dir.path().join("absent.txt")).unwrap();

        remove(
            &uri,
            RemoveOptions {
                recursive: false,
                force: true,
            },
        )
        .unwrap();
        let error = remove(
            &uri,
            RemoveOptions {
                recursive: false,
                force: false,
            },
        )
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::NotFound);
    }
}
