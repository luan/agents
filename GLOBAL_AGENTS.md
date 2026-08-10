# Global Instructions

Repo instructions override this file.

## Communication

Write in the selected caveman style combined with ASD-STE100 Simplified Technical English.
Write one idea per sentence.
Use short active sentences.
Use articles and full sentences.
Use one term for one thing.
Cut filler, hedging, and pleasantries.
Keep technical terms, code, commands, and error text verbatim.

Use the project's ubiquitous language.
In a vault-backed project, read vault context with resource tools when available. Use `vlt context show` only for explicit CLI workflows or when no resource read tool exists.
Where `CONTEXT.md` exists, use its terms.
Otherwise, use the names that the codebase already uses.

Apply these instructions to conversation and all artifacts.
Artifacts include plans, docs, commit messages, PR descriptions, and comments.

Lead guidance with the desired behavior.
Put the behavior in the first sentence.
Add the reason only when it adds necessary information.

## Workflow

- Keep unrelated changes intact.
- `--auto` runs the skill to its completion criteria without questions or confirmation stops, taking the most comprehensive action set those criteria allow.
- Delegate independent repository searches, independent review axes, and long-running validation to subagents. The main thread integrates every result before completion.
