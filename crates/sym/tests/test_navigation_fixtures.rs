use std::fs;
use std::path::Path;
use std::process::Command;

use anyhow::Result;

#[test]
fn rust_test_navigation_covers_unit_integration_and_macro_limitations() -> Result<()> {
    let fixture = Fixture::new()?;
    write(
        fixture.root(),
        "src/lib.rs",
        "pub fn add(left: i32, right: i32) -> i32 {\n    left + right\n}\n\npub fn macro_only(left: i32, right: i32) -> i32 {\n    left + right\n}\n\npub fn uncovered(value: i32) -> i32 {\n    value\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn unit_adds_numbers() {\n        let _sum = add(1, 2);\n    }\n\n    #[test]\n    fn unit_macro_only() {\n        assert_eq!(macro_only(1, 2), 3);\n    }\n}\n",
    )?;
    write(
        fixture.root(),
        "tests/integration_test.rs",
        "fn integration_adds_numbers() {\n    let _sum = add(1, 2);\n}\n",
    )?;

    let tests = sym_ai(fixture.root(), &["tests", "add"])?;
    assert!(tests.contains("unit_adds_numbers"));
    assert!(tests.contains("integration_adds_numbers"));

    let deps = sym_ai(fixture.root(), &["test-deps", "unit_adds_numbers"])?;
    assert!(deps.contains("add|"));

    let macro_tests = sym_ai(fixture.root(), &["tests", "macro_only"])?;
    assert!(macro_tests.contains("unit_macro_only"));

    let untested = sym_ai(fixture.root(), &["untested", "--lang", "rust"])?;
    assert!(untested.contains("uncovered|"));
    assert!(!untested.contains("add|f|"));
    assert!(!untested.contains("macro_only|f|"));

    Ok(())
}

#[test]
fn python_test_navigation_covers_pytest_functions_classes_and_decorators() -> Result<()> {
    let fixture = Fixture::new()?;
    write(
        fixture.root(),
        "mathy.py",
        "def add(left: int, right: int) -> int:\n    return left + right\n\n\ndef decorated_target(value: int) -> int:\n    return value\n\n\ndef uncovered(value: int) -> int:\n    return value\n",
    )?;
    write(
        fixture.root(),
        "test_mathy.py",
        "import pytest\nfrom mathy import add, decorated_target\n\n\ndef test_add_function():\n    assert add(1, 2) == 3\n\n\nclass TestMathy:\n    def test_add_method(self):\n        assert add(2, 3) == 5\n\n\n@pytest.mark.parametrize('value', [1])\ndef test_decorated_target(value):\n    assert decorated_target(value) == value\n",
    )?;

    let tests = sym_ai(fixture.root(), &["tests", "add"])?;
    assert!(tests.contains("test_add_function"));
    assert!(tests.contains("test_add_method"));

    let decorated = sym_ai(fixture.root(), &["tests", "decorated_target"])?;
    assert!(decorated.contains("test_decorated_target"));

    let deps = sym_ai(fixture.root(), &["test-deps", "test_decorated_target"])?;
    assert!(deps.contains("decorated_target|"));

    let untested = sym_ai(fixture.root(), &["untested", "--lang", "python"])?;
    assert!(untested.contains("uncovered|"));
    assert!(!untested.contains("add|f|"));

    Ok(())
}

#[test]
fn typescript_test_navigation_covers_jest_and_vitest_wrappers() -> Result<()> {
    let fixture = Fixture::new()?;
    write(
        fixture.root(),
        "src/math.ts",
        "export function add(left: number, right: number): number {\n  return left + right;\n}\n\nexport function uncovered(value: number): number {\n  return value;\n}\n",
    )?;
    write(
        fixture.root(),
        "src/math.test.ts",
        "import { describe, it, test, expect } from 'vitest';\nimport { add } from './math';\n\ndescribe('math', () => {\n  it('adds numbers', () => {\n    expect(add(1, 2)).toBe(3);\n  });\n\n  test('adds again', () => {\n    const sum = add(2, 3);\n    expect(sum).toBe(5);\n  });\n});\n",
    )?;
    write(
        fixture.root(),
        "src/mathy.js",
        "export function multiply(left, right) {\n  return left * right;\n}\n\nexport function untestedJs(value) {\n  return value;\n}\n",
    )?;
    write(
        fixture.root(),
        "src/mathy.spec.js",
        "import { describe, test, expect } from 'jest';\nimport { multiply } from './mathy';\n\ndescribe('mathy', () => {\n  test('multiplies numbers', () => {\n    expect(multiply(2, 3)).toBe(6);\n  });\n});\n",
    )?;

    let tests = sym_ai(fixture.root(), &["tests", "add"])?;
    assert!(tests.contains("it:adds numbers"));
    assert!(tests.contains("test:adds again"));

    let deps = sym_ai(fixture.root(), &["test-deps", "it:adds numbers"])?;
    assert!(deps.contains("add|"));

    let js_tests = sym_ai(fixture.root(), &["tests", "multiply"])?;
    assert!(js_tests.contains("test:multiplies numbers"));

    let js_deps = sym_ai(fixture.root(), &["test-deps", "test:multiplies numbers"])?;
    assert!(js_deps.contains("multiply|"));

    let untested = sym_ai(fixture.root(), &["untested", "--lang", "typescript"])?;
    assert!(untested.contains("uncovered|"));

    let untested_js = sym_ai(fixture.root(), &["untested", "--lang", "javascript"])?;
    assert!(untested_js.contains("untestedJs|"));

    Ok(())
}

#[test]
fn go_test_navigation_covers_test_files_test_functions_and_table_tests() -> Result<()> {
    let fixture = Fixture::new()?;
    write(
        fixture.root(),
        "math.go",
        "package mathy\n\nfunc add(left int, right int) int {\n    return left + right\n}\n\nfunc uncovered(value int) int {\n    return value\n}\n",
    )?;
    write(
        fixture.root(),
        "math_test.go",
        "package mathy\n\nimport \"testing\"\n\nfunc TestAdd(t *testing.T) {\n    cases := []struct{ left, right int }{{1, 2}, {2, 3}}\n    for _, tc := range cases {\n        _ = add(tc.left, tc.right)\n    }\n}\n",
    )?;

    let tests = sym_ai(fixture.root(), &["tests", "add"])?;
    assert!(tests.contains("TestAdd"));

    let deps = sym_ai(fixture.root(), &["test-deps", "TestAdd"])?;
    assert!(deps.contains("add|"));

    let untested = sym_ai(fixture.root(), &["untested", "--lang", "go"])?;
    assert!(untested.contains("uncovered|"));
    assert!(!untested.contains("add|f|"));

    Ok(())
}

struct Fixture {
    root: tempfile::TempDir,
}

impl Fixture {
    fn new() -> Result<Self> {
        let root = tempfile::tempdir()?;
        fs::create_dir(root.path().join(".git"))?;
        Ok(Self { root })
    }

    fn root(&self) -> &Path {
        self.root.path()
    }
}

fn sym_ai(root: &Path, args: &[&str]) -> Result<String> {
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

fn write(root: &Path, rel_path: &str, contents: &str) -> Result<()> {
    let path = root.join(rel_path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, contents)?;
    Ok(())
}
