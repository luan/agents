use std::path::{Path, PathBuf};

pub fn nearest_root(file: &Path, markers: &[&str]) -> Option<PathBuf> {
    let start = if file.is_dir() { file } else { file.parent()? };
    for dir in start.ancestors() {
        if is_home(dir) {
            return None;
        }
        if markers.iter().any(|marker| dir.join(marker).exists()) {
            return Some(dir.to_path_buf());
        }
    }
    None
}

fn is_home(path: &Path) -> bool {
    dirs::home_dir().is_some_and(|home| home == path)
}
