---
name: manual-testing
description: Run and report manual validation of applications with truthful evidence such as scenarios, screenshots, and videos. Use when the user asks for manual testing, QA validation, screenshots/videos for a PR, or when another skill needs PR-ready manual testing evidence.
---

# Manual Testing

Validate user-facing behavior by running the application like a reviewer or user would, then report only what was actually exercised.

## Core rules

- Manual testing is interactive product validation, not unit tests, lint, typecheck, or build output.
- Never claim a scenario was manually tested unless you performed it or the user explicitly reported it.
- Prefer concrete evidence: scenario, environment, data/setup, screenshot path, video path, and observed result.
- If manual testing is expected but you cannot perform it, ask the user what they tested.
- If using results in a PR description, keep the report concise and evidence-oriented.

## Workflow

1. **Identify scenarios**
   - Derive high-risk user flows from the diff, issue, or user request.
   - Include before/after, error, loading, empty, permission, and responsive states when relevant.
   - Keep scope proportional to the change.

2. **Choose execution method**
   - Browser app: use `$playwriter` and read its documentation first.
   - CLI/TUI/native app: run the app directly and capture terminal output or screenshots when useful.
   - If the app needs secrets, paid services, destructive actions, or unavailable devices, ask before proceeding.

3. **Run the app**
   - Start the smallest local environment needed.
   - Use realistic data, but avoid changing production data unless the user explicitly approves.
   - Keep any running server/session IDs until validation is complete, then clean up.

4. **Capture evidence**
   - Save screenshots/videos to a clear path, preferably under an ignored artifacts directory such as `tmp/manual-testing/`.
   - Name files by scenario, for example `tmp/manual-testing/settings-empty-state.png`.
   - Capture only evidence that helps reviewers understand the tested behavior.

5. **Report truthfully**
   - List each scenario as `Tested: <scenario> -> <result>`.
   - Include screenshot/video paths when captured.
   - Separate automated checks from manual testing if both were run.
   - State blockers plainly: `Not tested: <scenario> -> <reason>`.

## PR-ready format

Use this shape for template sections that ask for testing, QA, screenshots, or videos:

```md
Manual validation:
- Tested: <user scenario> -> <observed result>. Evidence: <path or link>
- Tested: <edge scenario> -> <observed result>.
- Not tested: <scenario> -> <reason or awaiting user confirmation>.
```

If no manual validation was performed or reported, write:

```md
Manual testing not reported.
```

Do not replace this with automated command output or a list of unit/lint/typecheck/build commands.
