use std::path::{Path, PathBuf};

use anyhow::{Result, bail};
use sha2::{Digest, Sha256};

fn resolve_cache_base_dir(
    xdg_cache_home: Option<PathBuf>,
    cache_dir: Option<PathBuf>,
    home: Option<PathBuf>,
) -> Option<PathBuf> {
    if let Some(cache_dir) = xdg_cache_home {
        return Some(cache_dir);
    }

    // dirs::cache_dir() resolves to:
    //   Linux:   $HOME/.cache
    //   macOS:   $HOME/Library/Caches
    //   Windows: %LOCALAPPDATA%
    if let Some(cache) = cache_dir {
        return Some(cache);
    }

    let home = home?;

    #[cfg(target_os = "macos")]
    {
        Some(home.join("Library").join("Caches"))
    }

    #[cfg(windows)]
    {
        Some(home.join("AppData").join("Local"))
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    {
        Some(home.join(".cache"))
    }
}

fn cache_base_dir() -> Option<PathBuf> {
    let xdg_cache_home = std::env::var_os("XDG_CACHE_HOME")
        .filter(|cache_dir| !cache_dir.is_empty())
        .map(PathBuf::from);
    resolve_cache_base_dir(xdg_cache_home, dirs::cache_dir(), dirs::home_dir())
}

pub fn sym_dir() -> Result<PathBuf> {
    cache_base_dir()
        .map(|cache| cache.join("sym"))
        .ok_or_else(|| anyhow::anyhow!("cannot determine cache directory"))
}

pub fn repo_db_path(repo_root: &Path) -> Result<PathBuf> {
    let base = sym_dir()?;
    let repo_root = repo_root.canonicalize()?;
    let hash = Sha256::digest(repo_root.to_string_lossy().as_bytes());
    Ok(base
        .join("repos")
        .join(hex::encode(&hash[..8]))
        .join("index.db"))
}

pub fn configured_db_path(cwd: &Path, explicit: Option<&Path>) -> Result<PathBuf> {
    let env_db = std::env::var_os("SYM_DB")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    select_db_path(cwd, explicit, env_db.as_deref())
}

pub fn select_db_path(
    cwd: &Path,
    explicit: Option<&Path>,
    env_db: Option<&Path>,
) -> Result<PathBuf> {
    if let Some(explicit) = explicit {
        return Ok(explicit.to_path_buf());
    }
    if let Some(env_db) = env_db {
        return Ok(env_db.to_path_buf());
    }

    let root = find_git_root(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    repo_db_path(&root)
}

pub fn find_git_root(dir: &Path) -> Result<PathBuf> {
    let mut current = dir.canonicalize()?;
    loop {
        let dot_git = current.join(".git");
        if let Ok(metadata) = std::fs::metadata(&dot_git)
            && (metadata.is_dir() || metadata.is_file())
        {
            return Ok(current);
        }

        if !current.pop() {
            break;
        }
    }

    bail!("no git repository found from {}", dir.display())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::resolve_cache_base_dir;

    #[test]
    fn cache_base_dir_respects_xdg_override() {
        let resolved = resolve_cache_base_dir(
            Some(PathBuf::from("/tmp/xdg-cache")),
            Some(PathBuf::from("/tmp/platform-cache")),
            Some(PathBuf::from("/tmp/home")),
        )
        .expect("cache dir");

        assert_eq!(resolved, PathBuf::from("/tmp/xdg-cache"));
    }

    #[test]
    fn cache_base_dir_falls_back_to_home_convention() {
        let resolved = resolve_cache_base_dir(None, None, Some(PathBuf::from("/tmp/home")))
            .expect("cache dir");

        #[cfg(target_os = "macos")]
        assert_eq!(resolved, PathBuf::from("/tmp/home/Library/Caches"));

        #[cfg(windows)]
        assert_eq!(resolved, PathBuf::from("/tmp/home/AppData/Local"));

        #[cfg(not(any(target_os = "macos", windows)))]
        assert_eq!(resolved, PathBuf::from("/tmp/home/.cache"));
    }
}
