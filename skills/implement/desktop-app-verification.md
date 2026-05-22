# Desktop App Verification

Use this reference for desktop GUI behavior before creating the
manual-verification gate.

## Preferred approaches

- Electron: use Playwright Electron when the project already supports it.
- macOS native/smoke evidence: use `osascript` to launch/focus apps and
  `screencapture -x <path>.png` for screenshots.
- Cross-platform fallback: use PyAutoGUI for visible GUI automation and
  screenshots when app-specific tooling is unavailable.

## Local spike results

- `screencapture` worked on macOS and produced PNG evidence.
- `osascript` could launch Calculator for a smoke screenshot.
- PyAutoGUI installed in a temporary venv and `pyautogui.screenshot()` produced
  a PNG screenshot.

## Evidence to capture

- App launch/open state.
- Changed workflow happy path.
- Validation, error, or disabled states when relevant.
- Before/after screenshots for visual changes when practical.
- Exact commands, app version/path, test data, and manual steps.

## Boundaries

- Prefer semantic app automation over coordinate clicking when available.
- Do not accept the task from screenshots alone; acceptance still requires the
  Plannotator manual-verification gate.
