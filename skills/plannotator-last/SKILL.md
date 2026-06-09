---
name: plannotator-last
description: Open Plannotator on the latest rendered assistant message and use the returned annotations to revise that message or continue.
disable-model-invocation: true
---

# Plannotator Last

Use this skill when the user wants to annotate the latest assistant response in Plannotator.

Do not send a commentary/status message before running the command. The command targets the latest rendered assistant response, so a preamble can mistakenly become the thing being annotated.

## Command discipline

- Never run `plannotator --help`, subcommand `--help`, or other discovery probes.
- Run the documented command yourself with Bash instead of asking the user to copy shell syntax.
- Wait for the annotation session to finish, then handle the returned result in the same conversation.

## Workflow

```bash
plannotator last
```

## Result handling

- If feedback is returned, incorporate it into the follow-up response.
- If the session closes without feedback, mention that briefly and continue.
