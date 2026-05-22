# Manual Verification Gate

Create a temporary self-contained HTML artifact after commit and before task
acceptance. Do not invoke `$plannotator-visual-explainer`; this file is the
minimal visual explainer pattern for `$implement`.

## Required content

- Task title and commit hash
- Changed surface
- Acceptance criteria
- Automated checks run
- Screenshots or equivalent visual evidence
- If screenshots are not practical, why and what substitute evidence was used
- Manual scenarios for the user to try
- Expected outcome for each scenario
- Caveats or known limitations
- Approval prompt stating:
  - Approving this Plannotator gate accepts the ticket
  - Denying it keeps the ticket in review with feedback to address

## Presentation

Use a simple readable layout: header, summary cards, evidence section, scenario
checklist, caveats, and final approval callout.

Present the artifact with:

```bash
plannotator annotate <artifact.html> --render-html --gate
```

Run Plannotator as a blocking foreground command with a normal long
human-review timeout. Do not start it in a background terminal, do not poll it
with `write_stdin`, and do not continue other work while the gate is open. If it
cannot be kept foreground, stop and report the gate as unavailable.

The HTML itself must ask the user to manually verify the scenarios before
approving.

## Screenshot evidence

When screenshots are available, make them renderable inside Plannotator instead
of merely listing local paths.

Before generating the gate, validate screenshot files are nonzero and inspect
them with `view_image` or `review_images`.

- Do not use `file://...` image URLs; browsers commonly block them in rendered
  review HTML.
- Do not use `data:image/...;base64,...` for screenshot galleries; large data
  URIs are brittle in Plannotator and make artifacts hard to inspect.
- Do not rely on relative image paths from `/tmp`; Plannotator may serve the
  rendered HTML from its own origin rather than the artifact directory.
- Prefer the Pi `review_images` tool when the review is primarily a screenshot
  gallery.
- If the manual gate HTML includes screenshots, use Plannotator's local image
  proxy form for each absolute screenshot path:

```html
<img src="./api/image?path=%2Ftmp%2Fexample-screenshot.png" alt="Example screenshot">
```

Generate the encoded path with a structured URL encoder such as
`encodeURIComponent(absolutePath)`, not by hand. Include the absolute screenshot
path as visible text next to the image so the user can still inspect the file if
rendering fails.

For user-visible work, map each acceptance criterion to evidence in the HTML.
