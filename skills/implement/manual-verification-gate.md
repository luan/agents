# Manual Verification Gate

Create a temporary self-contained HTML artifact after commit and before task acceptance. Load/use `$visual-doc` for report layout, visual language, media embedding, and presentation command.

## Required content

- Task title and commit hash
- Changed surface
- Acceptance criteria
- Automated checks run
- Screenshots, terminal frames, recordings, or equivalent visual evidence
- Substitute evidence and proof rationale when screenshots are unavailable
- Manual scenarios for the user to try
- Expected outcome for each scenario
- Caveats or known limitations
- Approval prompt stating:
  - Approving this Plannotator gate accepts the ticket
  - Denying it keeps the ticket in review with feedback to address

## Presentation command

Load/use `$plannotator` and run its rendered artifact-gate workflow for the HTML file.

The HTML itself must ask the user to manually verify the scenarios before approving. For user-visible work, map each acceptance criterion to evidence in the HTML.
