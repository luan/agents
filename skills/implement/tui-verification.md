# TUI Verification

Use this reference for terminal UI behavior before creating the
manual-verification gate.

## Preferred approaches

- Project-specific test harness first, especially snapshot tests already used by
  the repo.
- Rust/Ratatui: consider `ratatui-testlib` for PTY-driven integration and visual
  snapshot evidence.
- Python TUI: consider `curtaincall` for PTY-driven assertions; consider
  `textual-capture` for Textual apps.
- Generic fallback: run the app in a PTY, capture transcript output, and take
  terminal screenshots when practical.

## Local spike results

- `ratatui-testlib = "0.1.0"` was available from crates.io.
- `curtaincall 0.3.0` and `textual-capture 0.3.0` installed in a temporary venv.
- `curtaincall` exposed terminal testing APIs such as `Terminal`, `Locator`, and
  `expect`.
- The npm `termless` package was only a placeholder, so do not rely on it unless
  a real tool is installed separately.

## Evidence to capture

- Startup screen.
- Changed interaction path with keystrokes used.
- Empty, loading, success, and failure states when relevant.
- Snapshot files, screenshots, recordings, or terminal transcripts.
- Exact command, environment variables, terminal size, and test data.

## Boundaries

- Do not replace automated tests with visual TUI evidence.
- Do not accept the task from TUI evidence alone; acceptance still requires the
  Plannotator manual-verification gate.
