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
8. Include the screenshot paths and findings in the `$visual-doc`
   manual-verification HTML.

## Visual checks

- Confirm the intended state is visible, not merely that no error occurred.
- Check loading, empty, success, and failure states when the change affects them.
- For layout changes, inspect at desktop and narrow/mobile widths when practical.
- When screenshots are unavailable, record why and provide the strongest
  substitute evidence available.
- Use browser-level captures by default; use OS-level capture when the user asks
  for it.

## Boundaries

- Keep automated tests as the primary regression signal.
- Use `$playwriter` output as manual-verification support; acceptance still
  requires the Plannotator manual-verification gate.
