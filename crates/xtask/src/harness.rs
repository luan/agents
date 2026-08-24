use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Component, Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::Deserialize;

#[derive(Clone, Copy)]
pub enum Operation {
    Setup,
    Check,
    Unlink,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Managed {
    harnesses: Vec<Harness>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Harness {
    name: String,
    source: PathBuf,
    target: PathBuf,
    links: Vec<PathBuf>,
    trees: Vec<PathBuf>,
    #[serde(default)]
    package_trees: Vec<PathBuf>,
    seeds: Vec<Seed>,
}

#[derive(Deserialize)]
struct PackageManifest {
    #[serde(default)]
    dependencies: BTreeMap<String, String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Seed {
    source: PathBuf,
    target: PathBuf,
}

fn relative_path(path: &Path, label: &str) -> Result<()> {
    if path.as_os_str().is_empty()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        bail!("invalid {label}: {}", path.display());
    }
    Ok(())
}

fn validate(managed: &Managed) -> Result<()> {
    let mut harness_names = BTreeSet::new();
    let mut harness_targets = BTreeSet::new();
    for harness in &managed.harnesses {
        if harness.name.is_empty() {
            bail!("harness name cannot be empty");
        }
        if !harness_names.insert(&harness.name) {
            bail!("duplicate harness name: {}", harness.name);
        }
        if !harness_targets.insert(normalized_path(&harness.target)) {
            bail!("duplicate harness target: {}", harness.target.display());
        }
        relative_path(&harness.source, &format!("{} source", harness.name))?;
        relative_path(&harness.target, &format!("{} target", harness.name))?;
        for path in &harness.links {
            relative_path(path, &format!("{} link", harness.name))?;
        }
        for path in &harness.trees {
            relative_path(path, &format!("{} tree", harness.name))?;
        }
        for path in &harness.package_trees {
            relative_path(path, &format!("{} package tree", harness.name))?;
        }
        for seed in &harness.seeds {
            relative_path(&seed.source, &format!("{} seed source", harness.name))?;
            relative_path(&seed.target, &format!("{} seed target", harness.name))?;
        }

        reject_duplicate_paths(&harness.links, &format!("{} links", harness.name))?;
        reject_duplicate_paths(&harness.trees, &format!("{} trees", harness.name))?;
        reject_duplicate_paths(
            &harness.package_trees,
            &format!("{} package trees", harness.name),
        )?;

        // A package tree uses the regular tree manager for package files and
        // this list only adds dependency reconciliation. Keeping both entries
        // is deliberate; reject incomplete declarations instead of silently
        // creating a second package-file manager.
        for package_tree in &harness.package_trees {
            if !harness
                .trees
                .iter()
                .any(|tree| normalized_path(tree) == normalized_path(package_tree))
            {
                bail!(
                    "{} package tree is not also listed as a tree: {}",
                    harness.name,
                    package_tree.display()
                );
            }
        }

        reject_overlapping_paths(&harness.trees, &format!("{} trees", harness.name))?;

        let mut file_paths = harness.links.clone();
        file_paths.extend(harness.seeds.iter().map(|seed| seed.target.clone()));
        reject_duplicate_paths(
            &file_paths,
            &format!("{} links and seed targets", harness.name),
        )?;
        reject_overlapping_paths(
            &file_paths,
            &format!("{} links and seed targets", harness.name),
        )?;
        for file_path in &file_paths {
            if harness
                .trees
                .iter()
                .any(|tree| paths_overlap(file_path, tree))
            {
                bail!(
                    "{} file path overlaps a managed tree: {}",
                    harness.name,
                    file_path.display()
                );
            }
        }
    }
    Ok(())
}

fn normalized_path(path: &Path) -> PathBuf {
    path.components()
        .filter_map(|component| match component {
            Component::CurDir => None,
            _ => Some(component.as_os_str()),
        })
        .collect()
}

fn paths_overlap(left: &Path, right: &Path) -> bool {
    let left = normalized_path(left);
    let right = normalized_path(right);
    left == right || left.starts_with(&right) || right.starts_with(&left)
}

fn reject_duplicate_paths(paths: &[PathBuf], label: &str) -> Result<()> {
    let mut seen = BTreeSet::new();
    for path in paths {
        if !seen.insert(normalized_path(path)) {
            bail!("duplicate {label}: {}", path.display());
        }
    }
    Ok(())
}

fn reject_overlapping_paths(paths: &[PathBuf], label: &str) -> Result<()> {
    for (index, path) in paths.iter().enumerate() {
        if paths[index + 1..]
            .iter()
            .any(|other| paths_overlap(path, other))
        {
            bail!("overlapping {label}: {}", path.display());
        }
    }
    Ok(())
}

fn path_status(path: &Path) -> Result<Option<fs::FileType>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(metadata.file_type())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error).with_context(|| format!("inspect {}", path.display())),
    }
}

fn exact_link(source: &Path, target: &Path) -> Result<bool> {
    let Some(file_type) = path_status(target)? else {
        return Ok(false);
    };
    if !file_type.is_symlink() {
        return Ok(false);
    }
    Ok(fs::read_link(target).with_context(|| format!("read link {}", target.display()))? == source)
}

fn ensure_safe_target_parent(operation: Operation, target: &Path, safe_root: &Path) -> Result<()> {
    let Some(parent) = target.parent() else {
        return Ok(());
    };
    let relative = parent.strip_prefix(safe_root).with_context(|| {
        format!(
            "managed target is outside the harness root: {} (root {})",
            target.display(),
            safe_root.display()
        )
    })?;

    let mut current = safe_root.to_path_buf();
    match path_status(&current)? {
        Some(file_type) if file_type.is_symlink() => {
            bail!("refusing harness root symlink: {}", current.display());
        }
        Some(file_type) if !file_type.is_dir() => {
            bail!(
                "refusing harness root that is not a directory: {}",
                current.display()
            );
        }
        Some(_) => {}
        None => bail!("missing harness root: {}", current.display()),
    }
    for component in relative.components() {
        current.push(component.as_os_str());
        match path_status(&current)? {
            Some(file_type) if file_type.is_symlink() => {
                bail!(
                    "refusing managed path through symlink directory: {}",
                    current.display()
                );
            }
            Some(file_type) if !file_type.is_dir() => {
                bail!(
                    "refusing managed path through non-directory: {}",
                    current.display()
                );
            }
            Some(_) => {}
            None if matches!(operation, Operation::Setup) => {
                fs::create_dir(&current)
                    .with_context(|| format!("create directory {}", current.display()))?;
            }
            None => return Ok(()),
        }
    }
    Ok(())
}

fn validate_managed_directory(path: &Path, safe_root: &Path) -> Result<()> {
    let relative = path.strip_prefix(safe_root).with_context(|| {
        format!(
            "managed directory is outside the harness root: {} (root {})",
            path.display(),
            safe_root.display()
        )
    })?;
    let mut current = safe_root.to_path_buf();
    match path_status(&current)? {
        Some(file_type) if file_type.is_symlink() => {
            bail!("refusing harness root symlink: {}", current.display());
        }
        Some(file_type) if !file_type.is_dir() => {
            bail!(
                "refusing harness root that is not a directory: {}",
                current.display()
            );
        }
        Some(_) => {}
        None => return Ok(()),
    }
    for component in relative.components() {
        current.push(component.as_os_str());
        match path_status(&current)? {
            Some(file_type) if file_type.is_symlink() => {
                bail!(
                    "refusing managed directory through symlink: {}",
                    current.display()
                );
            }
            Some(file_type) if !file_type.is_dir() => {
                bail!(
                    "refusing managed directory that is not a directory: {}",
                    current.display()
                );
            }
            Some(_) => {}
            None => return Ok(()),
        }
    }
    Ok(())
}

#[cfg(unix)]
fn create_file_symlink(source: &Path, target: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(source, target)
}

#[cfg(unix)]
fn create_directory_symlink(source: &Path, target: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(source, target)
}

#[cfg(windows)]
fn create_directory_symlink(source: &Path, target: &Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_dir(source, target)
}

#[cfg(windows)]
fn create_file_symlink(source: &Path, target: &Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_file(source, target)
}

fn manage_link(operation: Operation, source: &Path, target: &Path, safe_root: &Path) -> Result<()> {
    ensure_safe_target_parent(operation, target, safe_root)?;
    if !matches!(operation, Operation::Unlink) && path_status(source)?.is_none() {
        bail!("missing managed source: {}", source.display());
    }

    match operation {
        Operation::Check => {
            if !exact_link(source, target)? {
                bail!("invalid managed link: {}", target.display());
            }
        }
        Operation::Unlink => {
            if exact_link(source, target)? {
                fs::remove_file(target)
                    .with_context(|| format!("remove link {}", target.display()))?;
            }
        }
        Operation::Setup => {
            if let Some(file_type) = path_status(target)? {
                if exact_link(source, target)? {
                    return Ok(());
                }
                let suffix = if file_type.is_symlink() {
                    format!(
                        " -> {}",
                        fs::read_link(target)
                            .with_context(|| format!("read link {}", target.display()))?
                            .display()
                    )
                } else {
                    String::new()
                };
                bail!("refusing to replace {}{suffix}", target.display());
            }
            create_file_symlink(source, target)
                .with_context(|| format!("link {} -> {}", target.display(), source.display()))?;
        }
    }
    Ok(())
}

fn manage_seed(operation: Operation, source: &Path, target: &Path, safe_root: &Path) -> Result<()> {
    ensure_safe_target_parent(operation, target, safe_root)?;
    if !matches!(operation, Operation::Unlink) {
        let Some(source_type) = path_status(source)? else {
            bail!("missing seed source: {}", source.display());
        };
        if !source_type.is_file() {
            bail!("invalid seed source: {}", source.display());
        }
    }

    match operation {
        Operation::Unlink => {}
        Operation::Check => {
            if !path_status(target)?.is_some_and(|file_type| file_type.is_file()) {
                bail!("missing seeded file: {}", target.display());
            }
        }
        Operation::Setup => {
            if let Some(target_type) = path_status(target)? {
                if !target_type.is_file() {
                    bail!("refusing invalid seed target: {}", target.display());
                }
                return Ok(());
            }
            fs::copy(source, target)
                .with_context(|| format!("seed {} from {}", target.display(), source.display()))?;
        }
    }
    Ok(())
}

fn is_package_development_surface(
    source_root: &Path,
    relative: &Path,
    name: &std::ffi::OsStr,
) -> bool {
    if !matches!(name.to_str(), Some("test" | "tests" | "catalog")) {
        return false;
    }
    // Package roots are identified by their manifest; this keeps a package
    // named `test` and unrelated source subdirectories intact without scanning imports.
    source_root.join(relative).join("package.json").is_file()
}

fn tree_files(
    root: &Path,
    relative: &Path,
    files: &mut Vec<PathBuf>,
    exclude_package_development: bool,
) -> Result<()> {
    let directory = root.join(relative);
    for entry in fs::read_dir(&directory)
        .with_context(|| format!("read managed tree {}", directory.display()))?
    {
        let entry = entry.with_context(|| format!("read entry in {}", directory.display()))?;
        if entry.file_name() == "node_modules" {
            continue;
        }
        let child = relative.join(entry.file_name());
        let file_type = entry
            .file_type()
            .with_context(|| format!("inspect {}", entry.path().display()))?;
        if file_type.is_dir() {
            if exclude_package_development
                && is_package_development_surface(root, relative, &entry.file_name())
            {
                continue;
            }
            tree_files(root, &child, files, exclude_package_development)?;
        } else {
            files.push(child);
        }
    }
    Ok(())
}

fn reconcile_tree_visit(
    operation: Operation,
    source_root: &Path,
    target_root: &Path,
    relative: &Path,
    expected: &BTreeSet<&PathBuf>,
    exclude_package_development: bool,
) -> Result<()> {
    for entry in fs::read_dir(target_root.join(relative))
        .with_context(|| format!("read managed tree {}", target_root.display()))?
    {
        let entry = entry
            .with_context(|| format!("read entry in {}", target_root.join(relative).display()))?;
        if entry.file_name() == "node_modules" {
            continue;
        }
        let child = relative.join(entry.file_name());
        let file_type = entry
            .file_type()
            .with_context(|| format!("inspect {}", entry.path().display()))?;
        if file_type.is_dir() {
            let child_exclude = !(exclude_package_development
                && is_package_development_surface(source_root, relative, &entry.file_name()));
            reconcile_tree_visit(
                operation,
                source_root,
                target_root,
                &child,
                expected,
                child_exclude,
            )?;
            continue;
        }
        if file_type.is_symlink()
            && !expected.contains(&child)
            && exact_link(&source_root.join(&child), &entry.path())?
        {
            match operation {
                Operation::Check => {
                    bail!("stale managed link: {}", entry.path().display());
                }
                Operation::Setup | Operation::Unlink => {
                    fs::remove_file(entry.path()).with_context(|| {
                        format!("remove stale managed link {}", entry.path().display())
                    })?;
                }
            }
        }
    }
    Ok(())
}

fn reconcile_tree(
    operation: Operation,
    source_root: &Path,
    target_root: &Path,
    expected: &[PathBuf],
    safe_root: &Path,
    exclude_package_development: bool,
) -> Result<()> {
    validate_managed_directory(target_root, safe_root)?;
    let Some(file_type) = path_status(target_root)? else {
        return Ok(());
    };
    if !file_type.is_dir() {
        return Ok(());
    }

    let expected = expected.iter().collect::<BTreeSet<_>>();
    // Only exact repository-owned symlinks are reconciled. Real files remain protected.
    reconcile_tree_visit(
        operation,
        source_root,
        target_root,
        Path::new(""),
        &expected,
        exclude_package_development,
    )
}

fn reconcile_stale_packages(
    operation: Operation,
    source_root: &Path,
    target_root: &Path,
    safe_root: &Path,
) -> Result<()> {
    validate_managed_directory(target_root, safe_root)?;
    let Some(file_type) = path_status(target_root)? else {
        return Ok(());
    };
    if !file_type.is_dir() {
        return Ok(());
    }

    for entry in fs::read_dir(target_root)
        .with_context(|| format!("read package tree {}", target_root.display()))?
    {
        let entry = entry.with_context(|| format!("read entry in {}", target_root.display()))?;
        let entry_type = entry
            .file_type()
            .with_context(|| format!("inspect {}", entry.path().display()))?;
        if !entry_type.is_dir() {
            continue;
        }
        let package_name = entry.file_name();
        let source_manifest = source_root.join(&package_name).join("package.json");
        let target_manifest = entry.path().join("package.json");
        if source_manifest.is_file() || !exact_link(&source_manifest, &target_manifest)? {
            continue;
        }
        reconcile_owned_links(
            operation,
            &source_root.join(&package_name),
            &entry.path(),
            Path::new(""),
        )?;
    }
    Ok(())
}

fn reconcile_owned_links(
    operation: Operation,
    source_root: &Path,
    target_root: &Path,
    relative: &Path,
) -> Result<()> {
    for entry in fs::read_dir(target_root.join(relative))
        .with_context(|| format!("read managed package {}", target_root.display()))?
    {
        let entry = entry.with_context(|| format!("read entry in {}", target_root.display()))?;
        let child = relative.join(entry.file_name());
        let file_type = entry
            .file_type()
            .with_context(|| format!("inspect {}", entry.path().display()))?;
        if file_type.is_dir() {
            reconcile_owned_links(operation, source_root, target_root, &child)?;
            continue;
        }
        if !file_type.is_symlink() || !exact_link(&source_root.join(&child), &entry.path())? {
            continue;
        }
        match operation {
            Operation::Check => bail!("stale managed link: {}", entry.path().display()),
            Operation::Setup | Operation::Unlink => fs::remove_file(entry.path())
                .with_context(|| format!("remove stale managed link {}", entry.path().display()))?,
        }
    }
    Ok(())
}

fn dependency_path(name: &str) -> Result<PathBuf> {
    let valid_segment = |segment: &str| {
        !segment.is_empty()
            && !segment.contains('\\')
            && !segment.contains('\0')
            && matches!(
                Path::new(segment)
                    .components()
                    .collect::<Vec<_>>()
                    .as_slice(),
                [Component::Normal(_)]
            )
    };
    let segments: Vec<_> = name.split('/').collect();
    let valid = match segments.as_slice() {
        [package] => valid_segment(package) && !package.starts_with('@'),
        [scope, package] => {
            valid_segment(scope)
                && valid_segment(package)
                && scope.starts_with('@')
                && scope.len() > 1
        }
        _ => false,
    };
    if !valid {
        bail!("invalid package dependency name: {name}");
    }
    Ok(segments.iter().collect())
}

fn manage_dependency_link(
    operation: Operation,
    source: &Path,
    target: &Path,
    safe_root: &Path,
) -> Result<()> {
    ensure_safe_target_parent(operation, target, safe_root)?;
    if !matches!(operation, Operation::Unlink)
        && !source
            .try_exists()
            .with_context(|| format!("inspect runtime dependency {}", source.display()))?
    {
        bail!("missing installed runtime dependency: {}", source.display());
    }

    match operation {
        Operation::Check => {
            if !exact_link(source, target)? {
                bail!("invalid runtime dependency link: {}", target.display());
            }
        }
        Operation::Unlink => {
            if exact_link(source, target)? {
                fs::remove_file(target)
                    .with_context(|| format!("remove dependency link {}", target.display()))?;
            }
        }
        Operation::Setup => {
            if exact_link(source, target)? {
                return Ok(());
            }
            if let Some(file_type) = path_status(target)? {
                let suffix = if file_type.is_symlink() {
                    format!(
                        " -> {}",
                        fs::read_link(target)
                            .with_context(|| format!("read link {}", target.display()))?
                            .display()
                    )
                } else {
                    String::new()
                };
                bail!(
                    "refusing to replace runtime dependency: {}{suffix}",
                    target.display()
                );
            }
            create_directory_symlink(source, target).with_context(|| {
                format!(
                    "link runtime dependency {} -> {}",
                    target.display(),
                    source.display()
                )
            })?;
        }
    }
    Ok(())
}

fn reconcile_dependency_links(
    operation: Operation,
    installed_root: &Path,
    package_tree_root: &Path,
    target_root: &Path,
    relative: &Path,
    expected: &BTreeMap<PathBuf, PathBuf>,
    safe_root: &Path,
) -> Result<()> {
    validate_managed_directory(target_root, safe_root)?;
    let directory = target_root.join(relative);
    let Some(file_type) = path_status(&directory)? else {
        return Ok(());
    };
    if !file_type.is_dir() {
        return Ok(());
    }

    for entry in fs::read_dir(&directory)
        .with_context(|| format!("read runtime dependencies {}", directory.display()))?
    {
        let entry = entry.with_context(|| format!("read entry in {}", directory.display()))?;
        let child = relative.join(entry.file_name());
        let file_type = entry
            .file_type()
            .with_context(|| format!("inspect {}", entry.path().display()))?;
        if file_type.is_dir() {
            reconcile_dependency_links(
                operation,
                installed_root,
                package_tree_root,
                target_root,
                &child,
                expected,
                safe_root,
            )?;
            continue;
        }
        if !file_type.is_symlink() {
            continue;
        }
        if let Some(source) = expected.get(&child) {
            if exact_link(source, &entry.path())? {
                continue;
            }
        }
        if !exact_link_from_root(installed_root, &child, &entry.path())?
            && !exact_link_from_root(package_tree_root, &child, &entry.path())?
        {
            continue;
        }
        match operation {
            Operation::Check => bail!("stale runtime dependency link: {}", entry.path().display()),
            Operation::Setup | Operation::Unlink => {
                fs::remove_file(entry.path()).with_context(|| {
                    format!(
                        "remove stale runtime dependency link {}",
                        entry.path().display()
                    )
                })?;
            }
        }
    }
    Ok(())
}

fn exact_link_from_root(root: &Path, relative: &Path, target: &Path) -> Result<bool> {
    if exact_link(&root.join(relative), target)? {
        return Ok(true);
    }
    let Ok(root) = fs::canonicalize(root) else {
        return Ok(false);
    };
    exact_link(&root.join(relative), target)
}

fn dependency_source(
    operation: Operation,
    package_root: &Path,
    package_tree_root: &Path,
    dependency: &Path,
    specification: &str,
) -> Result<PathBuf> {
    let candidate = if specification.starts_with("workspace:") {
        package_tree_root.join(dependency)
    } else if let Some(relative) = specification.strip_prefix("file:") {
        package_root.join(relative)
    } else {
        return Ok(package_root.join("node_modules").join(dependency));
    };
    let package_tree_root = fs::canonicalize(package_tree_root)
        .with_context(|| format!("resolve package tree {}", package_tree_root.display()))?;
    let source = match fs::canonicalize(&candidate) {
        Ok(source) => source,
        Err(error)
            if error.kind() == std::io::ErrorKind::NotFound
                && matches!(operation, Operation::Unlink) =>
        {
            canonicalize_existing_parent(&candidate).with_context(|| {
                format!("resolve removed runtime dependency {}", candidate.display())
            })?
        }
        Err(error) => {
            return Err(error).with_context(|| {
                format!(
                    "resolve local runtime dependency {} from {}",
                    specification,
                    package_root.display()
                )
            });
        }
    };
    if !source.starts_with(&package_tree_root) {
        bail!(
            "local runtime dependency escapes managed package tree: {}",
            source.display()
        );
    }
    Ok(source)
}

fn canonicalize_existing_parent(path: &Path) -> Result<PathBuf> {
    let mut missing = Vec::new();
    let mut current = path;
    loop {
        match fs::canonicalize(current) {
            Ok(mut resolved) => {
                for component in missing.iter().rev() {
                    resolved.push(component);
                }
                return Ok(resolved);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let Some(name) = current.file_name() else {
                    return Err(error)
                        .with_context(|| format!("find existing parent for {}", path.display()));
                };
                missing.push(name.to_owned());
                current = current
                    .parent()
                    .with_context(|| format!("find existing parent for {}", path.display()))?;
            }
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("resolve dependency path {}", path.display()));
            }
        }
    }
}

fn manage_package_tree(
    operation: Operation,
    source_root: &Path,
    target_root: &Path,
    safe_root: &Path,
) -> Result<()> {
    for entry in fs::read_dir(source_root)
        .with_context(|| format!("read package tree {}", source_root.display()))?
    {
        let entry = entry.with_context(|| format!("read entry in {}", source_root.display()))?;
        if !entry
            .file_type()
            .with_context(|| format!("inspect {}", entry.path().display()))?
            .is_dir()
        {
            continue;
        }
        let manifest_path = entry.path().join("package.json");
        if !manifest_path.is_file() {
            continue;
        }
        let manifest: PackageManifest = serde_json::from_str(
            &fs::read_to_string(&manifest_path)
                .with_context(|| format!("read {}", manifest_path.display()))?,
        )
        .with_context(|| format!("parse {}", manifest_path.display()))?;
        let dependencies = manifest
            .dependencies
            .iter()
            .map(|(dependency, specification)| {
                let dependency = dependency_path(dependency)?;
                let source = dependency_source(
                    operation,
                    &entry.path(),
                    source_root,
                    &dependency,
                    specification,
                )?;
                Ok((dependency, source))
            })
            .collect::<Result<BTreeMap<_, _>>>()?;
        let source_dependencies = entry.path().join("node_modules");
        let target_dependencies = target_root.join(entry.file_name()).join("node_modules");
        // `node_modules` is intentionally excluded from the regular tree
        // manager, but it is still a managed directory. Validate it even for
        // packages with no dependencies so a cached or malicious symlink
        // cannot survive simply because there is nothing to link today.
        validate_managed_directory(&target_dependencies, safe_root)?;
        reconcile_dependency_links(
            operation,
            &source_dependencies,
            source_root,
            &target_dependencies,
            Path::new(""),
            &dependencies,
            safe_root,
        )?;
        for (dependency, source) in dependencies {
            manage_dependency_link(
                operation,
                &source,
                &target_dependencies.join(dependency),
                safe_root,
            )?;
        }
    }
    Ok(())
}

pub fn run(operation: Operation, repository: &Path, home: &Path) -> Result<()> {
    let managed_path = repository.join("managed.toml");
    let contents = fs::read_to_string(&managed_path)
        .with_context(|| format!("read {}", managed_path.display()))?;
    let managed: Managed =
        toml::from_str(&contents).with_context(|| format!("parse {}", managed_path.display()))?;
    validate(&managed)?;

    for harness in managed.harnesses {
        let source_root = repository.join(harness.source);
        let target_root = home.join(harness.target);
        let package_trees = harness.package_trees.clone();
        for path in harness.links {
            manage_link(
                operation,
                &source_root.join(&path),
                &target_root.join(path),
                home,
            )?;
        }
        for tree in &harness.package_trees {
            reconcile_stale_packages(
                operation,
                &source_root.join(tree),
                &target_root.join(tree),
                home,
            )?;
        }
        for tree in harness.trees {
            let tree_root = source_root.join(&tree);
            if !path_status(&tree_root)?.is_some_and(|file_type| file_type.is_dir()) {
                bail!("missing managed tree: {}", tree_root.display());
            }
            let mut files = Vec::new();
            let exclude_package_development = package_trees.contains(&tree);
            tree_files(
                &tree_root,
                Path::new(""),
                &mut files,
                exclude_package_development,
            )?;
            reconcile_tree(
                operation,
                &tree_root,
                &target_root.join(&tree),
                &files,
                home,
                exclude_package_development,
            )?;
            for path in files {
                manage_link(
                    operation,
                    &tree_root.join(&path),
                    &target_root.join(&tree).join(path),
                    home,
                )?;
            }
        }
        for tree in harness.package_trees {
            manage_package_tree(
                operation,
                &source_root.join(&tree),
                &target_root.join(&tree),
                home,
            )?;
        }
        for seed in harness.seeds {
            manage_seed(
                operation,
                &source_root.join(seed.source),
                &target_root.join(seed.target),
                home,
            )?;
        }
    }
    Ok(())
}
