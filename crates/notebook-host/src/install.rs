use anyhow::{Result, ensure};
use fs2::FileExt;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{File, OpenOptions},
    io::{Cursor, Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};
const VERSION: &str = "2.9.5";
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Asset {
    archive: String,
    archive_sha256: String,
    archive_bytes: usize,
    executable: String,
    binary_sha256: String,
    binary_bytes: u64,
}
fn valid(path: &Path, asset: &Asset) -> Result<bool> {
    let Ok(mut file) = File::open(path) else {
        return Ok(false);
    };
    if file.metadata()?.len() != asset.binary_bytes {
        return Ok(false);
    }
    let mut hash = Sha256::new();
    std::io::copy(&mut file, &mut hash)?;
    Ok(hex::encode(hash.finalize()) == asset.binary_sha256)
}
pub async fn ensure(root: &Path) -> Result<PathBuf> {
    let platform = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    };
    let key = format!("{platform}-{arch}");
    let assets: BTreeMap<String, Asset> = serde_json::from_str(include_str!("deno-assets.json"))?;
    let asset = assets
        .get(&key)
        .ok_or_else(|| anyhow::anyhow!("Deno notebook does not support {key}"))?;
    let directory = root.join(format!("deno-{VERSION}-{key}"));
    std::fs::create_dir_all(&directory)?;
    let path = directory.join(&asset.executable);
    if valid(&path, asset)? {
        return Ok(path);
    }
    let lock = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(directory.join("install.lock"))?;
    // Another Pi process may already be installing this exact pinned runtime.
    let lock = tokio::task::spawn_blocking(move || {
        lock.lock_exclusive()?;
        Ok::<_, std::io::Error>(lock)
    })
    .await??;
    if valid(&path, asset)? {
        return Ok(path);
    }
    let url = format!(
        "https://github.com/denoland/deno/releases/download/v{VERSION}/{}",
        asset.archive
    );
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()?;
    let mut response = client.get(url).send().await?.error_for_status()?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        ensure!(
            bytes.len() + chunk.len() <= asset.archive_bytes,
            "Deno archive exceeds its pinned size"
        );
        bytes.extend_from_slice(&chunk);
    }
    ensure!(
        bytes.len() == asset.archive_bytes
            && hex::encode(Sha256::digest(&bytes)) == asset.archive_sha256,
        "Deno archive checksum mismatch"
    );
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))?;
    let entry = archive.by_name(&asset.executable)?;
    ensure!(
        entry.size() == asset.binary_bytes,
        "Deno executable size mismatch"
    );
    let mut bytes = Vec::new();
    entry.take(asset.binary_bytes + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 == asset.binary_bytes
            && hex::encode(Sha256::digest(&bytes)) == asset.binary_sha256,
        "Deno executable checksum mismatch"
    );
    let mut temporary = tempfile::NamedTempFile::new_in(&directory)?;
    temporary.write_all(&bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temporary
            .as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o700))?;
    }
    temporary.as_file().sync_all()?;
    temporary.persist(&path)?;
    drop(lock);
    Ok(path)
}
