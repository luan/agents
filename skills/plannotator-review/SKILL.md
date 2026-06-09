---
name: plannotator-review
description: Open Plannotator's browser-based code review UI for the current worktree or a pull request URL, then act on the feedback that comes back.
disable-model-invocation: false
---

# Plannotator Review

Use this skill when the user or another skill needs Plannotator code review for local changes or a pull request.

## Command discipline

- Never run `plannotator --help`, subcommand `--help`, or other discovery probes.
- Do not stage files before review unless the user explicitly asks.
- Before starting review, state what changed, where feedback is requested, and anything intentionally left out.
- Run the documented command yourself with Bash instead of asking the user to copy shell syntax.
- Wait for the browser review to finish, then handle the returned result in the same conversation.

## Workflow

```bash
plannotator review [optional-pr-url]
```

## Result handling

- If review returns feedback, address it directly. When feedback is a question, continue the conversation until the gap is resolved before making code changes.
- If review returns approval, acknowledge that review passed and continue the dependent workflow.
- Treat files or hunks staged by the user during Plannotator review as approved review selections. Preserve the index exactly as the user left it unless they ask for a staging change.
