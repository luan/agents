use std::{
    collections::hash_map::DefaultHasher,
    fs::{self, File, OpenOptions},
    hash::{Hash, Hasher},
    io,
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};

use crate::artifact::{self, CtError};

pub struct VaultLock {
    path: PathBuf,
    _file: File,
}

impl VaultLock {
    pub fn acquire(name: &str) -> Result<Self, CtError> {
        let lock_dir = artifact::blueprints_dir().join(".vlt").join("locks");
        fs::create_dir_all(&lock_dir)?;
        Self::acquire_in(&lock_dir, name, Duration::from_secs(30))
    }

    fn acquire_in(lock_dir: &Path, name: &str, timeout: Duration) -> Result<Self, CtError> {
        let path = lock_dir.join(format!("{}.lock", lock_name(name)));
        let start = Instant::now();
        loop {
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(file) => return Ok(Self { path, _file: file }),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    if start.elapsed() >= timeout {
                        return Err(CtError::Validation(format!(
                            "timed out waiting for vault lock: {}",
                            path.display()
                        )));
                    }
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) => return Err(error.into()),
            }
        }
    }
}

impl Drop for VaultLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn lock_name(name: &str) -> String {
    let mut hasher = DefaultHasher::new();
    name.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn waits_for_existing_lock_until_released() {
        let tmp = std::env::temp_dir().join(format!("vlt-lock-{}", std::process::id()));
        fs::remove_dir_all(&tmp).ok();
        fs::create_dir_all(&tmp).unwrap();

        let first = VaultLock::acquire_in(&tmp, "same", Duration::from_secs(1)).unwrap();
        let tmp_for_thread = tmp.clone();
        let handle = thread::spawn(move || {
            VaultLock::acquire_in(&tmp_for_thread, "same", Duration::from_secs(1)).unwrap()
        });
        thread::sleep(Duration::from_millis(30));
        assert!(!handle.is_finished());
        drop(first);
        let second = handle.join().unwrap();
        drop(second);

        fs::remove_dir_all(&tmp).ok();
    }
}
