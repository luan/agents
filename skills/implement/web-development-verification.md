# Web Development Verification

Use this reference for web UI or browser-visible behavior before creating the
manual-verification gate.

## Workflow

1. Load/use `$playwriter` when verification needs a real browser, logged-in
   state, JavaScript execution, screenshots, or visual inspection.
2. Start the app using the repo's normal command, or use an already-running app
   when the task specifies one.
3. Confirm the served origin Playwriter can reach; for local dev servers, check
   `localhost` vs `127.0.0.1` before diagnosing browser failures.
4. Drive the changed workflow in the browser.
5. Capture screenshots for each important state: before/after when available,
   happy path, validation/error states, and responsive states when relevant.
6. Check screenshot byte sizes and visually inspect them before embedding.
7. Record exact URLs, commands, test data, accounts, and browser steps used.
8. Include the screenshot paths and findings in the manual-verification HTML.

## Visual checks

- Confirm the intended state is visible, not merely that no error occurred.
- Check loading, empty, success, and failure states when the change affects them.
- For layout changes, inspect at desktop and narrow/mobile widths when practical.
- If screenshots cannot be captured, record why and provide the strongest
  substitute evidence available.
- Do not use OS-level capture as a fallback unless the user explicitly asks for it.

## Boundaries

- Do not replace automated tests with browser verification.
- Do not accept the task from `$playwriter` output alone; acceptance still
  requires the Plannotator manual-verification gate.
