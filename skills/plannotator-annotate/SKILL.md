---
name: plannotator-annotate
description: Open Plannotator's annotation UI for a markdown file, converted HTML file, URL, folder, artifact gate, or rendered HTML review, then respond to the returned annotations.
disable-model-invocation: false
---

# Plannotator Annotate

Use this skill when the user or another skill needs Plannotator annotation, artifact-gate approval, rendered HTML review, or rendered HTML approval.

## Command discipline

- Never run `plannotator --help`, subcommand `--help`, or other discovery probes.
- Resolve local artifacts to their real absolute local filesystem path before passing them to Plannotator.
- Do not pass vault stems, wiki-link targets, repo-relative paths, or artifact-link paths.
- Run the documented command yourself with Bash instead of asking the user to copy shell syntax.
- Wait for the browser session to finish, then handle the returned result in the same conversation.

## Workflows

General annotation:

```bash
plannotator annotate "<path-or-url>"
```

Artifact gate for a local file:

```bash
plannotator annotate "<absolute-path>" --gate --json
```

Rendered HTML artifact gate:

```bash
plannotator annotate "<absolute-path>" --render-html --gate
```

Rendered HTML informational review:

```bash
plannotator annotate "<absolute-path>" --render-html
```

## Result handling

- If annotations or denial feedback are returned, address them directly, revise the relevant artifact when appropriate, and re-run the same workflow when approval is still required.
- If approval is returned, continue the dependent workflow without asking for duplicate approval.
- If the session closes without feedback, is unavailable, times out, or otherwise fails closed during a required gate, pause or ask whether to retry rather than treating it as approval.
