use std::fs;
use std::path::{Path, PathBuf};

use anyhow::Result;
use assert_fs::fixture::ChildPath;
use assert_fs::prelude::*;
use assert_fs::TempDir;
use predicates::prelude::*;
use pretty_assertions::assert_eq;
use proptest::prelude::*;
use proptest_derive::Arbitrary;
use rstest::{fixture, rstest};
use static_assertions::assert_impl_all;
use xtask::harness::{run, Operation};

assert_impl_all!(Operation: Copy, Clone);

struct HarnessFixture {
    _root: TempDir,
    repository: PathBuf,
    home: PathBuf,
}

impl HarnessFixture {
    fn new() -> Self {
        let root = TempDir::new().expect("create harness fixture root");
        let repository = root.child("repository").to_path_buf();
        let home = root.child("home").to_path_buf();
        fs::create_dir_all(&repository).expect("create fixture repository");
        fs::create_dir_all(&home).expect("create fixture home");
        Self {
            _root: root,
            repository,
            home,
        }
    }

    fn write_managed(&self, trees: &[&str], package_trees: &[&str]) {
        let mut all_trees = trees.to_vec();
        for package_tree in package_trees {
            if !all_trees.contains(package_tree) {
                all_trees.push(package_tree);
            }
        }
        fs::write(
            self.repository.join("managed.toml"),
            format!(
                r#"
[[harnesses]]
name = "test"
source = "source"
target = "target"
links = []
trees = {all_trees:?}
package_trees = {package_trees:?}
seeds = []
"#
            ),
        )
        .expect("write managed fixture");
    }

    fn package(&self, name: &str, dependency: &str) -> (PathBuf, PathBuf) {
        let package = self.repository.join("source/packages").join(name);
        let source_dependency = package.join("node_modules").join(dependency);
        fs::create_dir_all(&source_dependency).expect("create source dependency");
        fs::write(
            package.join("package.json"),
            format!(r#"{{"dependencies":{{"{dependency}":"1.0.0"}}}}"#),
        )
        .expect("write package manifest");
        (package, source_dependency)
    }

    fn local_package(&self, name: &str, dependency: &str) -> (PathBuf, PathBuf) {
        let package = self.repository.join("source/packages").join(name);
        let source_dependency = self.repository.join("source/packages").join(dependency);
        fs::create_dir_all(&package).expect("create package");
        fs::create_dir_all(&source_dependency).expect("create local dependency");
        fs::write(
            package.join("package.json"),
            format!(r#"{{"dependencies":{{"{dependency}":"workspace:*"}}}}"#),
        )
        .expect("write local dependency manifest");
        (package, source_dependency)
    }

    fn target_dependency(&self, package: &str, dependency: &str) -> PathBuf {
        self.home
            .join("target/packages")
            .join(package)
            .join("node_modules")
            .join(dependency)
    }
}

#[fixture]
fn fixture() -> HarnessFixture {
    HarnessFixture::new()
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
fn create_file_symlink(source: &Path, target: &Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_file(source, target)
}

#[cfg(windows)]
fn create_directory_symlink(source: &Path, target: &Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_dir(source, target)
}

#[rstest]
fn managed_package_dependencies_are_linked_checked_and_unlinked(
    fixture: HarnessFixture,
) -> Result<()> {
    fixture.write_managed(&[], &["packages"]);
    let (_package, dependency) = fixture.package("pi-example", "runtime-dependency");

    run(Operation::Setup, &fixture.repository, &fixture.home)?;
    run(Operation::Check, &fixture.repository, &fixture.home)?;
    let installed = fixture.target_dependency("pi-example", "runtime-dependency");
    ChildPath::new(&installed).assert(predicate::path::exists());
    assert_eq!(fs::read_link(&installed)?, dependency);

    run(Operation::Unlink, &fixture.repository, &fixture.home)?;
    assert_eq!(installed.try_exists()?, false);
    Ok(())
}

#[rstest]
fn managed_package_tree_excludes_node_modules(fixture: HarnessFixture) -> Result<()> {
    fixture.write_managed(&["packages"], &[]);
    let (package, _dependency) = fixture.package("pi-example", "runtime-dependency");
    fs::write(package.join("src.ts"), "export const live = true;")?;

    run(Operation::Setup, &fixture.repository, &fixture.home)?;

    let target_package = fixture.home.join("target/packages/pi-example");
    ChildPath::new(target_package.join("package.json")).assert(predicate::path::exists());
    ChildPath::new(target_package.join("src.ts")).assert(predicate::path::exists());
    assert_eq!(target_package.join("node_modules").try_exists()?, false);
    Ok(())
}

#[rstest]
fn managed_package_tree_excludes_development_surfaces_and_retires_old_links(
    fixture: HarnessFixture,
) -> Result<()> {
    fixture.write_managed(&[], &["packages"]);
    let (package, _dependency) = fixture.package("pi-example", "runtime-dependency");
    fs::create_dir_all(package.join("test/nested"))?;
    fs::create_dir_all(package.join("tests"))?;
    fs::create_dir_all(package.join("catalog"))?;
    fs::write(package.join("test/nested/example.test.ts"), "test")?;
    fs::write(package.join("tests/example.test.ts"), "test")?;
    fs::write(package.join("catalog/index.html"), "catalog")?;
    fs::write(package.join("src.ts"), "runtime")?;

    run(Operation::Setup, &fixture.repository, &fixture.home)?;
    run(Operation::Check, &fixture.repository, &fixture.home)?;

    let target_package = fixture.home.join("target/packages/pi-example");
    assert!(fs::symlink_metadata(&target_package)?.file_type().is_dir());
    let target_node_modules = target_package.join("node_modules");
    assert!(fs::symlink_metadata(&target_node_modules)?
        .file_type()
        .is_dir());
    assert!(!fs::symlink_metadata(&target_package)?
        .file_type()
        .is_symlink());
    assert!(!fs::symlink_metadata(&target_node_modules)?
        .file_type()
        .is_symlink());
    ChildPath::new(target_package.join("src.ts")).assert(predicate::path::is_symlink());
    assert!(!target_package.join("test").try_exists()?);
    assert!(!target_package.join("tests").try_exists()?);
    assert!(!target_package.join("catalog").try_exists()?);

    let stale_source = package.join("test/nested/example.test.ts");
    let stale_target = target_package.join("test/nested/example.test.ts");
    fs::create_dir_all(stale_target.parent().expect("stale target parent"))?;
    create_file_symlink(&stale_source, &stale_target)?;
    let error = run(Operation::Check, &fixture.repository, &fixture.home)
        .expect_err("excluded development links must be reported as stale");
    assert!(error.to_string().contains("stale managed link"));
    run(Operation::Setup, &fixture.repository, &fixture.home)?;
    assert!(!stale_target.try_exists()?);
    Ok(())
}

#[rstest]
fn local_package_dependencies_link_to_live_sources(fixture: HarnessFixture) -> Result<()> {
    fixture.write_managed(&[], &["packages"]);
    let (_package, dependency) = fixture.local_package("pi-example", "pi-shared");
    fs::write(dependency.join("new-file.ts"), "export const live = true;")?;

    run(Operation::Setup, &fixture.repository, &fixture.home)?;
    let installed = fixture.target_dependency("pi-example", "pi-shared");
    assert_eq!(fs::read_link(&installed)?, fs::canonicalize(&dependency)?);
    ChildPath::new(installed.join("new-file.ts")).assert(predicate::path::exists());
    Ok(())
}

#[rstest]
fn setup_replaces_cached_local_dependency_with_live_source(fixture: HarnessFixture) -> Result<()> {
    fixture.write_managed(&[], &["packages"]);
    let (package, cached_dependency) = fixture.package("pi-example", "pi-shared");
    let cached_snapshot = fixture.repository.join("source/.bun/pi-shared-snapshot");
    fs::remove_dir_all(&cached_dependency)?;
    fs::create_dir_all(&cached_snapshot)?;
    create_directory_symlink(&cached_snapshot, &cached_dependency)?;
    run(Operation::Setup, &fixture.repository, &fixture.home)?;
    let installed = fixture.target_dependency("pi-example", "pi-shared");
    assert_eq!(fs::read_link(&installed)?, cached_dependency);

    let live_dependency = fixture.repository.join("source/packages/pi-shared");
    fs::create_dir_all(&live_dependency)?;
    fs::write(
        package.join("package.json"),
        r#"{"dependencies":{"pi-shared":"workspace:*"}}"#,
    )?;
    run(Operation::Setup, &fixture.repository, &fixture.home)?;

    assert_eq!(
        fs::read_link(installed)?,
        fs::canonicalize(live_dependency)?
    );
    Ok(())
}

#[rstest]
fn setup_rejects_local_dependency_outside_managed_package_tree(
    fixture: HarnessFixture,
) -> Result<()> {
    fixture.write_managed(&[], &["packages"]);
    let package = fixture.repository.join("source/packages/pi-example");
    let outside = fixture.repository.join("source/outside");
    fs::create_dir_all(&package)?;
    fs::create_dir_all(&outside)?;
    fs::write(
        package.join("package.json"),
        r#"{"dependencies":{"outside":"file:../../outside"}}"#,
    )?;

    let error = run(Operation::Setup, &fixture.repository, &fixture.home)
        .expect_err("local dependency outside the managed tree must be rejected");
    assert_eq!(
        error.to_string(),
        format!(
            "local runtime dependency escapes managed package tree: {}",
            fs::canonicalize(outside)?.display()
        )
    );
    Ok(())
}

#[rstest]
fn setup_reconciles_removed_dependency_links_without_touching_user_entries(
    fixture: HarnessFixture,
) -> Result<()> {
    fixture.write_managed(&[], &["packages"]);
    let (package, _dependency) = fixture.package("pi-example", "runtime-dependency");
    run(Operation::Setup, &fixture.repository, &fixture.home)?;
    let stale = fixture.target_dependency("pi-example", "runtime-dependency");
    let node_modules = stale.parent().expect("node_modules");
    let user_file = node_modules.join("user-file");
    fs::write(&user_file, "user data")?;
    let unrelated = fixture.home.join("unrelated-dependency");
    fs::create_dir_all(&unrelated)?;
    let unrelated_link = node_modules.join("unrelated-link");
    create_file_symlink(&unrelated, &unrelated_link)?;
    fs::write(package.join("package.json"), r#"{"dependencies":{}}"#)?;

    let error = run(Operation::Check, &fixture.repository, &fixture.home)
        .expect_err("removed dependency must be reported");
    assert_eq!(
        error.to_string(),
        format!("stale runtime dependency link: {}", stale.display())
    );

    run(Operation::Setup, &fixture.repository, &fixture.home)?;
    assert_eq!(stale.try_exists()?, false);
    ChildPath::new(user_file).assert(predicate::path::is_file());
    assert_eq!(fs::read_link(unrelated_link)?, unrelated);
    Ok(())
}

#[rstest]
fn unlink_removes_dependency_link_after_source_disappears(fixture: HarnessFixture) -> Result<()> {
    fixture.write_managed(&[], &["packages"]);
    let (_package, dependency) = fixture.package("pi-example", "runtime-dependency");
    run(Operation::Setup, &fixture.repository, &fixture.home)?;
    let installed = fixture.target_dependency("pi-example", "runtime-dependency");
    fs::remove_dir_all(dependency)?;

    run(Operation::Unlink, &fixture.repository, &fixture.home)?;
    assert_eq!(installed.try_exists()?, false);
    Ok(())
}

#[rstest]
fn unlink_removes_local_dependency_link_after_source_disappears(
    fixture: HarnessFixture,
) -> Result<()> {
    fixture.write_managed(&[], &["packages"]);
    let (_package, dependency) = fixture.local_package("pi-example", "pi-shared");
    run(Operation::Setup, &fixture.repository, &fixture.home)?;
    let installed = fixture.target_dependency("pi-example", "pi-shared");
    fs::remove_dir_all(dependency)?;

    run(Operation::Unlink, &fixture.repository, &fixture.home)?;
    assert_eq!(installed.try_exists()?, false);
    Ok(())
}

#[rstest]
fn unlink_removes_file_dependency_link_after_source_disappears(
    fixture: HarnessFixture,
) -> Result<()> {
    fixture.write_managed(&[], &["packages"]);
    let package = fixture.repository.join("source/packages/pi-example");
    let shared = fixture.repository.join("source/packages/shared");
    fs::create_dir_all(&package)?;
    fs::create_dir_all(&shared)?;
    fs::write(
        package.join("package.json"),
        r#"{"dependencies":{"shared-alias":"file:../shared"}}"#,
    )?;

    run(Operation::Setup, &fixture.repository, &fixture.home)?;
    let installed = fixture.target_dependency("pi-example", "shared-alias");
    assert_eq!(fs::read_link(&installed)?, fs::canonicalize(&shared)?);

    fs::remove_dir_all(&shared)?;
    run(Operation::Unlink, &fixture.repository, &fixture.home)?;
    assert_eq!(installed.try_exists()?, false);
    Ok(())
}

#[rstest]
fn unlink_removes_explicit_link_after_source_disappears(fixture: HarnessFixture) -> Result<()> {
    fs::write(
        fixture.repository.join("managed.toml"),
        r#"
[[harnesses]]
name = "test"
source = "source"
target = "target"
links = ["settings.json"]
trees = []
seeds = []
"#,
    )?;
    let source = fixture.repository.join("source/settings.json");
    fs::create_dir_all(source.parent().expect("source parent"))?;
    fs::write(&source, "settings")?;

    run(Operation::Setup, &fixture.repository, &fixture.home)?;
    fs::remove_file(source)?;
    run(Operation::Unlink, &fixture.repository, &fixture.home)?;

    assert!(!fixture.home.join("target/settings.json").try_exists()?);
    Ok(())
}

#[rstest]
#[case::tree_root("tree-root")]
#[case::node_modules("node-modules")]
fn setup_refuses_symlinked_target_directories(
    fixture: HarnessFixture,
    #[case] location: &str,
) -> Result<()> {
    fixture.write_managed(&[], &["packages"]);
    let (_package, _dependency) = fixture.package("pi-example", "runtime-dependency");
    let outside = fixture.home.join("outside");
    fs::create_dir_all(&outside)?;

    match location {
        "tree-root" => {
            let target_root = fixture.home.join("target/packages");
            fs::create_dir_all(target_root.parent().expect("target parent"))?;
            create_directory_symlink(&outside, &target_root)?;
        }
        "node-modules" => {
            let target_package = fixture.home.join("target/packages/pi-example");
            fs::create_dir_all(&target_package)?;
            create_directory_symlink(&outside, &target_package.join("node_modules"))?;
        }
        _ => unreachable!(),
    }

    let error = run(Operation::Setup, &fixture.repository, &fixture.home)
        .expect_err("managed setup must reject symlinked target directories");
    assert!(
        error
            .to_string()
            .contains("refusing managed directory through symlink")
            || error
                .to_string()
                .contains("refusing managed path through symlink directory"),
        "unexpected error: {error:#}"
    );
    Ok(())
}

#[rstest]
fn setup_refuses_symlinked_node_modules_without_dependencies(
    fixture: HarnessFixture,
) -> Result<()> {
    fixture.write_managed(&[], &["packages"]);
    let package = fixture.repository.join("source/packages/pi-example");
    fs::create_dir_all(&package)?;
    fs::write(package.join("package.json"), r#"{"dependencies":{}}"#)?;

    let target_package = fixture.home.join("target/packages/pi-example");
    fs::create_dir_all(&target_package)?;
    let outside = fixture.home.join("outside");
    fs::create_dir_all(&outside)?;
    create_directory_symlink(&outside, &target_package.join("node_modules"))?;

    let error = run(Operation::Setup, &fixture.repository, &fixture.home)
        .expect_err("managed node_modules symlink must be rejected");
    assert!(
        error
            .to_string()
            .contains("refusing managed directory through symlink"),
        "unexpected error: {error:#}"
    );
    Ok(())
}

#[rstest]
fn setup_rejects_unknown_managed_fields(fixture: HarnessFixture) -> Result<()> {
    fs::write(
        fixture.repository.join("managed.toml"),
        r#"
[[harnesses]]
name = "test"
source = "source"
target = "target"
links = []
trees = []
seeds = []
unexpected = true
"#,
    )?;

    let error = run(Operation::Setup, &fixture.repository, &fixture.home)
        .expect_err("unknown managed fields must be rejected");
    assert!(
        format!("{error:#}").contains("unknown field `unexpected`")
            || format!("{error:#}").contains("unexpected"),
        "unexpected error: {error:#}"
    );
    Ok(())
}

#[rstest]
fn setup_rejects_duplicate_and_overlapping_managed_paths(fixture: HarnessFixture) -> Result<()> {
    fs::write(
        fixture.repository.join("managed.toml"),
        r#"
[[harnesses]]
name = "test"
source = "source"
target = "target"
links = ["settings.json", "settings.json"]
trees = ["packages", "packages/nested"]
seeds = []
"#,
    )?;

    let error = run(Operation::Setup, &fixture.repository, &fixture.home)
        .expect_err("duplicate managed paths must be rejected");
    assert!(error.to_string().contains("duplicate test links"));
    Ok(())
}

#[rstest]
fn setup_rejects_overlapping_managed_file_paths(fixture: HarnessFixture) -> Result<()> {
    fs::write(
        fixture.repository.join("managed.toml"),
        r#"
[[harnesses]]
name = "test"
source = "source"
target = "target"
links = ["settings", "settings/backup.json"]
trees = []
seeds = []
"#,
    )?;

    let error = run(Operation::Setup, &fixture.repository, &fixture.home)
        .expect_err("overlapping managed paths must be rejected");
    assert!(error
        .to_string()
        .contains("overlapping test links and seed targets"));
    Ok(())
}

#[rstest]
#[case::backslash("foo\\\\bar")]
#[case::parent("foo/../bar")]
fn setup_rejects_non_portable_dependency_names(
    fixture: HarnessFixture,
    #[case] dependency: &str,
) -> Result<()> {
    fixture.write_managed(&[], &["packages"]);
    let package = fixture.repository.join("source/packages/pi-example");
    fs::create_dir_all(&package)?;
    fs::write(
        package.join("package.json"),
        format!(r#"{{"dependencies":{{"{dependency}":"1.0.0"}}}}"#),
    )?;

    let error = run(Operation::Setup, &fixture.repository, &fixture.home)
        .expect_err("invalid dependency names must be rejected");
    assert!(
        format!("{error:#}").contains("invalid package dependency name"),
        "unexpected error: {error:#}"
    );
    Ok(())
}

#[rstest]
fn stale_local_dependency_cleanup_handles_symlinked_repository_path(
    fixture: HarnessFixture,
) -> Result<()> {
    let real_source = fixture.repository.join("real-source");
    fs::create_dir_all(&real_source)?;
    create_directory_symlink(&real_source, &fixture.repository.join("source"))?;
    fixture.write_managed(&[], &["packages"]);
    let (package, _dependency) = fixture.local_package("pi-example", "pi-shared");
    run(Operation::Setup, &fixture.repository, &fixture.home)?;
    let installed = fixture.target_dependency("pi-example", "pi-shared");

    fs::write(package.join("package.json"), r#"{"dependencies":{}}"#)?;
    run(Operation::Setup, &fixture.repository, &fixture.home)?;
    assert!(!installed.try_exists()?);
    Ok(())
}

#[rstest]
#[case::real_file("file")]
#[case::wrong_symlink("symlink")]
fn setup_refuses_occupied_dependency_target(
    fixture: HarnessFixture,
    #[case] occupied_by: &str,
) -> Result<()> {
    fixture.write_managed(&[], &["packages"]);
    let (_package, _dependency) = fixture.package("pi-example", "runtime-dependency");
    let target = fixture.target_dependency("pi-example", "runtime-dependency");
    fs::create_dir_all(target.parent().expect("dependency target parent"))?;
    let suffix = if occupied_by == "file" {
        fs::write(&target, "user data")?;
        String::new()
    } else {
        let unrelated = fixture.home.join("unrelated-dependency");
        fs::create_dir_all(&unrelated)?;
        create_file_symlink(&unrelated, &target)?;
        format!(" -> {}", unrelated.display())
    };

    let error = run(Operation::Setup, &fixture.repository, &fixture.home)
        .expect_err("occupied target must be protected");
    assert_eq!(
        error.to_string(),
        format!(
            "refusing to replace runtime dependency: {}{suffix}",
            target.display()
        )
    );
    if occupied_by == "file" {
        ChildPath::new(&target).assert(predicate::path::is_file());
    } else {
        assert_eq!(
            fs::read_link(&target)?,
            fixture.home.join("unrelated-dependency")
        );
    }
    Ok(())
}

#[rstest]
fn stale_package_cleanup_removes_only_exact_links(fixture: HarnessFixture) -> Result<()> {
    fixture.write_managed(&[], &["packages"]);
    let source_package = fixture.repository.join("source/packages/pi-removed");
    fs::create_dir_all(source_package.parent().expect("package source parent"))?;
    let target_package = fixture.home.join("target/packages/pi-removed");
    fs::create_dir_all(&target_package)?;

    let source_manifest = source_package.join("package.json");
    let source_file = source_package.join("old.ts");
    create_file_symlink(&source_manifest, &target_package.join("package.json"))?;
    create_file_symlink(&source_file, &target_package.join("old.ts"))?;
    fs::write(target_package.join("keep.txt"), "user data")?;
    let unrelated = fixture.home.join("unrelated.ts");
    fs::write(&unrelated, "unrelated")?;
    create_file_symlink(&unrelated, &target_package.join("wrong.ts"))?;

    let error = run(Operation::Check, &fixture.repository, &fixture.home)
        .expect_err("stale managed link must be reported");
    assert_eq!(
        error.to_string(),
        format!(
            "stale managed link: {}",
            target_package.join("package.json").display()
        )
    );

    run(Operation::Unlink, &fixture.repository, &fixture.home)?;
    ChildPath::new(target_package.join("keep.txt")).assert(predicate::path::is_file());
    assert_eq!(target_package.join("package.json").try_exists()?, false);
    assert_eq!(target_package.join("old.ts").try_exists()?, false);
    assert_eq!(fs::read_link(target_package.join("wrong.ts"))?, unrelated);
    Ok(())
}

#[derive(Debug, Arbitrary)]
enum DependencyName {
    Plain(#[proptest(regex = "[a-z][a-z0-9_-]{0,4}")] String),
    Scoped {
        #[proptest(regex = "[a-z][a-z0-9_-]{0,4}")]
        scope: String,
        #[proptest(regex = "[a-z][a-z0-9_-]{0,4}")]
        package: String,
    },
}

impl DependencyName {
    fn as_str(&self) -> String {
        match self {
            Self::Plain(name) => name.clone(),
            Self::Scoped { scope, package } => format!("@{scope}/{package}"),
        }
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(16))]

    // Keep fixture-backed cases bounded; raise this when dependency-path validation gains more branches.
    // Property: every accepted dependency name links inside its owning package tree.
    #[test]
    fn dependency_links_stay_under_declared_package(dependency: DependencyName) {
        let dependency = dependency.as_str();
        let fixture = HarnessFixture::new();
        fixture.write_managed(&[], &["packages"]);
        let (_package, source_dependency) = fixture.package("pi-example", &dependency);

        let result = run(Operation::Setup, &fixture.repository, &fixture.home);
        prop_assert!(result.is_ok(), "valid dependency setup failed: {result:?}");
        let installed = fixture.target_dependency("pi-example", &dependency);
        assert_eq!(fs::read_link(&installed).unwrap(), source_dependency);
        prop_assert!(installed.starts_with(fixture.home.join("target/packages/pi-example/node_modules")));
    }
}
