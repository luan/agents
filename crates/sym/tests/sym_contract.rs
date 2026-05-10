use std::fs;
use std::path::Path;
use std::process::Command;

use anyhow::Result;
fn run_ai(root: &Path, args: &[&str]) -> Result<String> {
    let output = Command::new(env!("CARGO_BIN_EXE_sym"))
        .current_dir(root)
        .args(["--format", "ai"])
        .args(args)
        .output()?;
    assert!(
        output.status.success(),
        "sym {args:?} failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(String::from_utf8(output.stdout)?)
}

#[test]
fn sym_exposes_cohesive_source_navigation_ai_contracts() -> Result<()> {
    let fixture = SourceFixture::new()?;

    for (operation, args) in [
        ("index", vec!["index", "--force"]),
        ("stats", vec!["stats"]),
        ("map", vec!["map", "--level", "2", "-n", "1"]),
        ("query", vec!["query", "add"]),
        ("search", vec!["search", "add"]),
        ("inspect", vec!["inspect", "lib.rs"]),
        ("outline", vec!["outline", "lib.rs"]),
        ("show", vec!["show", "add"]),
        ("refs", vec!["refs", "add"]),
        ("callers", vec!["callers", "add"]),
        ("callees", vec!["callees", "adds_numbers"]),
        ("impact", vec!["impact", "add"]),
        ("trace", vec!["trace", "adds_numbers"]),
        ("types", vec!["types", "load_user"]),
        ("schema", vec!["schema", "User"]),
        ("tests", vec!["tests", "add"]),
        ("test-deps", vec!["test-deps", "adds_numbers"]),
        ("untested", vec!["untested"]),
        ("investigate", vec!["investigate", "add"]),
    ] {
        let text = run_ai(fixture.root(), &args)?;
        assert!(
            text.starts_with(&format!(
                "[{}",
                match operation {
                    "test-deps" => "TEST_DEPS",
                    "untested" => "UNTESTED",
                    "callers" => "CALLERS",
                    "callees" => "CALLEES",
                    "impact" => "IMPACT",
                    "trace" => "TRACE",
                    "refs" => "REFS",
                    "types" => "TYPES",
                    "schema" => "SCHEMA",
                    "tests" => "TESTS",
                    "diff" => "DIFF",
                    "index" => "INDEX",
                    "stats" => "STATS",
                    "map" => "PROJECT",
                    "context" => "CONTEXT",
                    "investigate" => "INVESTIGATE",
                    _ => "RESULTS",
                }
            )),
            "{operation} should report a CodeMapper-style header, got:\n{text}"
        );
        assert!(!text.contains("[SYM_AI"));
    }

    Ok(())
}

#[test]
fn sym_tests_test_deps_and_untested_match_navigation_contract() -> Result<()> {
    let fixture = SourceFixture::new()?;

    let tests = run_ai(fixture.root(), &["tests", "add"])?;
    assert!(tests.contains("[TESTS:add|"));
    assert!(tests.contains("adds_numbers"));

    let deps = run_ai(fixture.root(), &["test-deps", "adds_numbers"])?;
    assert!(deps.contains("[TEST_DEPS:adds_numbers|"));
    assert!(deps.contains("add|"));

    let untested = run_ai(fixture.root(), &["untested"])?;
    assert!(untested.contains("[UNTESTED:"));
    assert!(untested.contains("uncovered|f|lib.rs|"));

    Ok(())
}

#[test]
fn sym_relationship_and_assessment_rows_include_evidence_metadata() -> Result<()> {
    let fixture = SourceFixture::new()?;

    let refs = run_ai(fixture.root(), &["refs", "add"])?;
    assert!(refs.contains("|ev:parsed_call_edge|conf:high"));

    let callers = run_ai(fixture.root(), &["callers", "add"])?;
    assert!(callers.contains("|ev:parsed_call_edge|conf:high"));

    let callees = run_ai(fixture.root(), &["callees", "adds_numbers"])?;
    assert!(callees.contains("|ev:parsed_call_edge"));

    let impact = run_ai(fixture.root(), &["impact", "add"])?;
    assert!(impact.contains("|ev:parsed_call_edge"));

    let trace = run_ai(fixture.root(), &["trace", "adds_numbers"])?;
    assert!(trace.contains("|ev:parsed_call_edge"));

    let tests = run_ai(fixture.root(), &["tests", "add"])?;
    assert!(tests.contains("|ev:parsed_call_edge"));
    assert!(tests.contains("|conf:"));

    let deps = run_ai(fixture.root(), &["test-deps", "adds_numbers"])?;
    assert!(deps.contains("|ev:parsed_call_edge|conf:high"));

    let untested = run_ai(fixture.root(), &["untested"])?;
    assert!(untested.contains("uncovered|f|lib.rs|"));
    assert!(untested.contains("|ev:no_indexed_test_reference|conf:medium"));

    Ok(())
}

#[test]
fn sym_untested_ranks_public_referenced_symbols_with_cached_inputs() -> Result<()> {
    let root = tempfile::tempdir()?;
    fs::create_dir(root.path().join(".git"))?;
    let mut source = String::from(
        "pub fn public_api() -> i32 {\n    1\n}\n\nfn private_leaf() -> i32 {\n    2\n}\n\n",
    );
    for index in 0..30 {
        source.push_str(&format!(
            "fn caller_{index}() -> i32 {{\n    public_api()\n}}\n\n"
        ));
    }
    write(root.path(), "lib.rs", &source)?;

    let untested = run_ai(root.path(), &["untested", "--lang", "rust"])?;
    let first = untested.lines().nth(1).expect("untested row");
    assert!(first.starts_with("public_api|f|lib.rs|1-3"));
    assert!(first.contains("|refs:30|test_refs:0|rank:"));
    let public_rank = rank_from_line(first);
    let private_rank = untested
        .lines()
        .find(|line| line.starts_with("private_leaf|"))
        .map(rank_from_line)
        .expect("private leaf row");
    assert!(public_rank > private_rank);

    Ok(())
}

#[test]
fn sym_diff_uses_source_navigation_ai_contract() -> Result<()> {
    let fixture = DiffFixture::new()?;

    let text = run_ai(fixture.root(), &["diff", "HandleRequest"])?;
    assert!(text.starts_with("[DIFF:HandleRequest]\n"));
    assert!(text.contains("updated handle"));

    Ok(())
}

#[test]
fn agent_instructions_include_direct_sym_workflow() -> Result<()> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let template = fs::read_to_string(root.join("AGENTS.template.md"))?;
    let readme = fs::read_to_string(root.join("README.md"))?;
    let skill = fs::read_to_string(root.join("skills/sym/SKILL.md"))?;

    for required in [
        "Use `sym` for source navigation",
        "sym --format ai",
        "sym search",
        "sym show",
        "sym callers",
        "sym callees",
        "sym tests",
        "sym untested",
    ] {
        assert!(
            template.contains(required) || readme.contains(required) || skill.contains(required),
            "agent-facing sym guidance must mention {required:?}"
        );
    }

    let help = Command::new(env!("CARGO_BIN_EXE_sym"))
        .arg("--help")
        .output()?;
    assert!(help.status.success());
    let help = String::from_utf8(help.stdout)?;
    for command in [
        "index",
        "stats",
        "map",
        "query",
        "search",
        "inspect",
        "outline",
        "show",
        "refs",
        "callers",
        "callees",
        "impact",
        "trace",
        "impls",
        "types",
        "schema",
        "tests",
        "test-deps",
        "untested",
        "investigate",
        "diff",
    ] {
        assert!(
            help.contains(command),
            "sym help should expose command {command:?}"
        );
    }
    assert!(!help.contains("hook"), "sym hooks are not part of the CLI");

    Ok(())
}

struct SourceFixture {
    root: tempfile::TempDir,
}

impl SourceFixture {
    fn new() -> Result<Self> {
        let root = tempfile::tempdir()?;
        fs::create_dir(root.path().join(".git"))?;
        fs::create_dir(root.path().join("tests"))?;
        write(
            root.path(),
            "lib.rs",
            "struct User {\n    id: u64,\n}\n\nfn load_user(user: User) -> User {\n    user\n}\n\npub fn add(left: i32, right: i32) -> i32 {\n    left + right\n}\n\npub fn uncovered(value: i32) -> i32 {\n    value\n}\n",
        )?;
        write(
            root.path(),
            "tests/integration_test.rs",
            "fn adds_numbers() {\n    let _sum = add(1, 2);\n}\n",
        )?;
        Ok(Self { root })
    }

    fn root(&self) -> &Path {
        self.root.path()
    }
}

struct DiffFixture {
    root: tempfile::TempDir,
}

impl DiffFixture {
    fn new() -> Result<Self> {
        let root = tempfile::tempdir()?;
        git(root.path(), &["init", "--initial-branch=main"])?;
        git(root.path(), &["config", "user.name", "Sym Tests"])?;
        git(root.path(), &["config", "user.email", "sym@example.com"])?;
        write(
            root.path(),
            "main.go",
            "package main\n\nfunc HandleRequest() {\n    println(\"handle\")\n}\n",
        )?;
        git(root.path(), &["add", "main.go"])?;
        git(root.path(), &["commit", "-m", "initial"])?;
        write(
            root.path(),
            "main.go",
            "package main\n\nfunc HandleRequest() {\n    println(\"updated handle\")\n}\n",
        )?;
        Ok(Self { root })
    }

    fn root(&self) -> &Path {
        self.root.path()
    }
}

fn write(root: &Path, rel_path: &str, contents: &str) -> Result<()> {
    let path = root.join(rel_path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, contents)?;
    Ok(())
}

fn git(root: &Path, args: &[&str]) -> Result<()> {
    let status = Command::new("git").args(args).current_dir(root).status()?;
    if !status.success() {
        anyhow::bail!("git {:?} failed", args);
    }
    Ok(())
}

fn rank_from_line(line: &str) -> i64 {
    line.split('|')
        .find_map(|part| part.strip_prefix("rank:"))
        .and_then(|rank| rank.parse().ok())
        .unwrap_or_default()
}
