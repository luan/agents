use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use anyhow::{Context, Result};
use sha2::{Digest, Sha256};

use crate::parser;
use crate::repo;
use crate::store::Store;
use crate::walker::{WalkOptions, walk};

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct IndexStats {
    pub files_indexed: usize,
    pub files_skipped: usize,
    pub symbols_found: usize,
    pub stale_removed: usize,
    pub ignore_patterns: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct IndexOptions {
    pub db_path: Option<PathBuf>,
    pub cli_ignore_patterns: Vec<String>,
    pub force: bool,
}

pub fn index(root: &Path, options: &IndexOptions) -> Result<IndexStats> {
    let ignore_patterns = options.cli_ignore_patterns.clone();
    let files = walk(
        root,
        &WalkOptions {
            parseable_only: true,
            ignore: ignore_patterns.clone(),
        },
    )?;
    let db_path = options
        .db_path
        .clone()
        .map(Ok)
        .unwrap_or_else(|| repo::configured_db_path(root, None))?;
    let store = Store::open(&db_path)?;
    let canonical_root = root.canonicalize()?;
    store.set_meta("repo_root", &canonical_root.to_string_lossy())?;

    let current_paths = files
        .iter()
        .map(|file| file.path.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    let stale_removed = store.delete_stale_paths(&current_paths)?;
    let file_checks = store.all_file_checks()?;

    let mut files_indexed = 0;
    let mut files_skipped = 0;
    let mut symbols_found = 0;

    for file in files {
        let path = file.path.to_string_lossy().into_owned();
        let file_size = i64::try_from(file.size).context("file size does not fit in i64")?;
        let mtime_ns = file
            .modified
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as i64;
        if !options.force {
            if let Some(check) = file_checks.get(&path) {
                if check.mtime_ns == mtime_ns && check.size == file_size {
                    files_skipped += 1;
                    continue;
                }
            }
        }

        let source = fs::read(&file.path)
            .with_context(|| format!("reading {}", file.path.display()))?;
        let parsed = parser::parse_source(&source, &file.path.to_string_lossy(), &file.language)
            .with_context(|| format!("parsing {}", file.path.display()))?;
        let hash = hash_bytes(&source);
        let file_id = store.upsert_file(
            &path,
            &file.rel_path.to_string_lossy().replace('\\', "/"),
            &file.language,
            &hash,
            file.modified,
            file_size,
        )?;
        symbols_found += parsed.symbols.len();
        store.replace_file_contents(file_id, &parsed.symbols, &parsed.imports, &parsed.refs)?;
        files_indexed += 1;
    }

    // Only bump last_index_ns when something actually changed. A no-op
    // ensure_fresh (clean repo, no work) preserves the prior timestamp.
    if files_indexed > 0 || stale_removed > 0 {
        store.set_meta("last_index_ns", &format!("{}", now_ns()))?;
    }

    Ok(IndexStats {
        files_indexed,
        files_skipped,
        symbols_found,
        stale_removed,
        ignore_patterns,
    })
}

pub fn ensure_fresh(cwd: &Path, db_path: &Path) -> Result<usize> {
    let store = Store::open(db_path)?;
    let repo_root = store.get_meta("repo_root")?;
    drop(store);

    let repo_root = repo_root
        .filter(|root| !root.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| repo::find_git_root(cwd).unwrap_or_else(|_| cwd.to_path_buf()));

    // Always invoke the full index walk. `index()` is already efficient on
    // clean repos: it walks once, runs a single DB query for stored mtimes,
    // and skips per-file parsing/hashing when (mtime, size) match. Any
    // optimisation that tries to short-circuit using directory mtimes alone
    // is platform-fragile (Windows NTFS dir mtime updates are coarser than
    // file mtime, so freshly added or deleted files are invisible at the
    // dir level until the OS catches up).
    let stats = index(
        &repo_root,
        &IndexOptions {
            db_path: Some(db_path.to_path_buf()),
            ..IndexOptions::default()
        },
    )?;
    Ok(stats.files_indexed + stats.stale_removed)
}

pub fn reset_db(db_path: &Path) -> Result<()> {
    remove_if_exists(db_path)?;

    let wal_path = PathBuf::from(format!("{}-wal", db_path.display()));
    remove_if_exists(&wal_path)?;

    let shm_path = PathBuf::from(format!("{}-shm", db_path.display()));
    remove_if_exists(&shm_path)?;

    Ok(())
}

fn hash_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn now_ns() -> i64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as i64
}

fn remove_if_exists(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("removing {}", path.display())),
    }
}
