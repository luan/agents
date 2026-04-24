#!/usr/bin/env -S uv run
"""
Auto-generation post tool use hook for Claude Code.
Automatically runs code generation scripts when source files are edited.

Environment variables to enable specific generators (all disabled by default):
- CC_HOOKS_FEATURE_FLAGS - enable feature flags generation
- CC_HOOKS_PROMPT_COMPILE - enable prompt template compilation
- CC_HOOKS_SWIFTGEN - enable SwiftGen asset generation
- CC_HOOKS_SOURCERY - enable Sourcery code generation
- CC_HOOKS_CMAKELISTS - enable CMakeLists generation for new Swift files
"""

import json
import subprocess
import sys
import os
from pathlib import Path
from typing import Callable
BLUE = "\033[34m"
YELLOW = "\033[33m"
RED = "\033[31m"
RESET = "\033[0m"


def print_success(message: str) -> None:
    print("", file=sys.stderr)
    print(f"{BLUE}🔹{RESET} {message}", file=sys.stderr)


def print_error(message: str) -> None:
    print("", file=sys.stderr)
    print(f"{RED}❌ {message}{RESET}", file=sys.stderr)


def print_warning(message: str) -> None:
    print("", file=sys.stderr)
    print(f"{YELLOW}⚠️  {message}{RESET}", file=sys.stderr)


def print_info(message: str) -> None:
    print("", file=sys.stderr)
    print(f"{BLUE}ℹ️  {message}{RESET}", file=sys.stderr)


def get_git_repo_root(start_dir: Path) -> Path | None:
    try:
        proc = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            cwd=start_dir,
            capture_output=True,
            text=True,
            timeout=5,
        )
        if proc.returncode != 0:
            return None
        return Path(proc.stdout.strip())
    except Exception:
        return None


def get_staged_files(repo_root: Path) -> set[str]:
    """Get all currently staged files."""
    try:
        result = subprocess.run(
            ["git", "diff", "--cached", "--name-only"],
            cwd=repo_root,
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode != 0:
            return set()
        files = result.stdout.strip()
        return set(files.split("\n")) if files else set()
    except Exception:
        return set()


def stage_file(file_path: Path, repo_root: Path) -> bool:
    """Stage a file in git."""
    try:
        result = subprocess.run(
            ["git", "add", str(file_path)],
            cwd=repo_root,
            capture_output=True,
            timeout=5,
        )
        return result.returncode == 0
    except Exception:
        return False


def unstage_files(files: list[str], repo_root: Path) -> bool:
    """Unstage multiple files in git."""
    if not files:
        return True
    try:
        result = subprocess.run(
            ["git", "restore", "--staged", "--"] + files,
            cwd=repo_root,
            capture_output=True,
            timeout=5,
        )
        return result.returncode == 0
    except Exception:
        return False


def run_script(script_path: Path, repo_root: Path, description: str) -> bool:
    """Run a generation script and return success status."""
    if not script_path.exists():
        print_warning(f"Script not found: {script_path}")
        return True

    print_info(f"Running {description}...")

    try:
        result = subprocess.run(
            [str(script_path)],
            cwd=repo_root,
            capture_output=True,
            text=True,
            timeout=120,
        )

        if result.returncode == 0:
            print_success(f"{description} completed successfully")
            return True
        else:
            print_error(f"{description} failed")
            output = (result.stdout + result.stderr).strip()
            if output:
                print(output, file=sys.stderr)
            return False

    except subprocess.TimeoutExpired:
        print_error(f"{description} timed out after 120 seconds")
        return False
    except Exception as e:
        print_error(f"{description} failed: {e}")
        return False


def run_uv_script(script_args: list[str], repo_root: Path, description: str) -> bool:
    """Run a uv-based Python script and return success status."""
    print_info(f"Running {description}...")

    try:
        result = subprocess.run(
            ["uv", "run"] + script_args,
            cwd=repo_root,
            capture_output=True,
            text=True,
            timeout=120,
        )

        if result.returncode == 0:
            print_success(f"{description} completed successfully")
            return True
        else:
            print_error(f"{description} failed")
            output = (result.stdout + result.stderr).strip()
            if output:
                print(output, file=sys.stderr)
            return False

    except subprocess.TimeoutExpired:
        print_error(f"{description} timed out after 120 seconds")
        return False
    except Exception as e:
        print_error(f"{description} failed: {e}")
        return False


# Generator definitions: (path_matcher, generator_function, description, env_enable_var)
GeneratorDef = tuple[Callable[[Path, Path], bool], Callable[[Path], bool], str, str]


def is_feature_flags_json(file_path: Path, repo_root: Path) -> bool:
    """Check if file is a feature flags JSON file."""
    try:
        rel_path = file_path.relative_to(repo_root)
        rel_str = str(rel_path)

        feature_flag_dirs = [
            "Frameworks/BoostBrowser/Sources/BoostFeatureFlags/Containers/",
            "Frameworks/ARCClients/Sources/FeatureFlags/Containers/",
        ]

        return file_path.suffix.lower() == ".json" and any(
            rel_str.startswith(d) for d in feature_flag_dirs
        )
    except ValueError:
        return False


def is_mustache_template(file_path: Path, repo_root: Path) -> bool:
    """Check if file is a Mustache prompt template."""
    return file_path.suffix.lower() == ".mustache"


def is_xcassets_file(file_path: Path, repo_root: Path) -> bool:
    """Check if file is inside an xcassets directory."""
    return ".xcassets" in str(file_path)


def is_sourcery_source(file_path: Path, repo_root: Path) -> bool:
    """Check if file is a Swift file that might need Sourcery generation."""
    if file_path.suffix.lower() != ".swift":
        return False

    # AnalyticsEvents.swift always triggers Sourcery
    if file_path.name == "AnalyticsEvents.swift":
        return True

    try:
        content = file_path.read_text(encoding="utf-8")
        return "@ViewModel" in content
    except Exception:
        return False


def generate_feature_flags(repo_root: Path) -> bool:
    """Generate feature flags Swift code."""
    script = repo_root / "Tools" / "generate_feature_flags.sh"
    return run_script(script, repo_root, "Feature Flags Generation")


def compile_prompts(repo_root: Path) -> bool:
    """Compile Mustache prompt templates."""
    script = repo_root / "Tools" / "PromptCompiler" / "compile_prompts.sh"
    return run_script(script, repo_root, "Prompt Compilation")


def generate_swiftgen(repo_root: Path) -> bool:
    """Generate SwiftGen asset code."""
    script = repo_root / "Tools" / "swiftgen_generate.sh"
    return run_script(script, repo_root, "SwiftGen Generation")


def generate_sourcery(repo_root: Path) -> bool:
    """Generate Sourcery code."""
    script = repo_root / "Tools" / "sourcery_generate.sh"
    return run_script(script, repo_root, "Sourcery Generation")


def generate_cmakelists_for_new_swift(
    file_path: Path, repo_root: Path, is_new_file: bool
) -> bool:
    """
    Generate CMakeLists.txt for a new Swift file.

    The gen_cmakelists.py script requires files to be staged to detect them.
    This function temporarily stages the file, runs generation, then restores
    the original staging state (unstaging any files that weren't staged before).
    """
    if not is_new_file:
        return True

    if file_path.suffix.lower() != ".swift":
        return True

    if os.environ.get("CC_HOOKS_CMAKELISTS") != "1":
        return True

    # Snapshot staged files before we do anything
    staged_before = get_staged_files(repo_root)

    # Stage the new file
    print_info(f"Temporarily staging {file_path.name} for CMakeLists generation...")
    if not stage_file(file_path, repo_root):
        print_warning("Failed to stage file, skipping CMakeLists generation")
        return True

    success = run_uv_script(
        ["Tools/gen_cmakelists.py", "--fast"],
        repo_root,
        "CMakeLists Generation",
    )

    # Restore staging state: unstage any files that weren't staged before
    staged_after = get_staged_files(repo_root)
    newly_staged = staged_after - staged_before

    if newly_staged:
        print_info(
            f"Restoring staging state (unstaging {len(newly_staged)} file(s))..."
        )
        if not unstage_files(list(newly_staged), repo_root):
            print_warning(
                "Failed to restore staging state - you may need to unstage manually"
            )

    return success


GENERATORS: list[GeneratorDef] = [
    (
        is_feature_flags_json,
        generate_feature_flags,
        "Feature Flags",
        "CC_HOOKS_FEATURE_FLAGS",
    ),
    (
        is_mustache_template,
        compile_prompts,
        "Prompt Compilation",
        "CC_HOOKS_PROMPT_COMPILE",
    ),
    (is_xcassets_file, generate_swiftgen, "SwiftGen", "CC_HOOKS_SWIFTGEN"),
    (is_sourcery_source, generate_sourcery, "Sourcery", "CC_HOOKS_SOURCERY"),
]


def process_file(file_path: Path, repo_root: Path, is_new_file: bool) -> bool:
    """Process a file and run any applicable generators."""
    all_success = True

    for matcher, generator, description, enable_var in GENERATORS:
        if os.environ.get(enable_var) != "1":
            continue

        if matcher(file_path, repo_root):
            success = generator(repo_root)
            if not success:
                all_success = False

    # CMakeLists generation for new Swift files
    if not generate_cmakelists_for_new_swift(file_path, repo_root, is_new_file):
        all_success = False

    return all_success


def main() -> None:
    try:
        if sys.stdin.isatty():
            print_error("This hook requires JSON input from Claude Code")
            sys.exit(1)

        input_data = json.load(sys.stdin)

        event = input_data.get("hook_event_name", "")
        tool_name = input_data.get("tool_name", "")

        if event != "PostToolUse" or tool_name not in ["Edit", "Write", "MultiEdit"]:
            sys.exit(0)

        tool_input = input_data.get("tool_input", {})
        file_path_str = tool_input.get("file_path", "")

        if not file_path_str:
            sys.exit(0)

        file_path = Path(file_path_str)

        if not file_path.exists():
            sys.exit(0)

        repo_root = get_git_repo_root(file_path.parent)
        if repo_root is None:
            sys.exit(0)

        # Write tool creates new files, Edit/MultiEdit modify existing files
        is_new_file = tool_name == "Write"

        success = process_file(file_path, repo_root, is_new_file)

        if success:
            sys.exit(0)
        else:
            print_error("BLOCKING: Fix generation issues above before continuing")
            sys.exit(2)

    except json.JSONDecodeError:
        print_error("Invalid JSON input")
        sys.exit(1)
    except Exception as e:
        print_error(f"Unexpected error: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
