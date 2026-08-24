---
name: writing-for-agents
description: Write or edit instructions for agents, including skills, AGENTS.md, and CLAUDE.md.
---

Write agent instructions that produce clear and consistent decisions.

Preserve the user's intent, project language, and existing authority boundaries.

## Instructions

- Keep instructions used by every matching task in the main file.
- Move substantial task-specific detail to a referenced file. State when the agent must read it.
- Put actions in execution order. Keep related definitions, rules, and exceptions together.
- Give an action a clear and checkable completion condition when incomplete work is a real risk.
- Keep each rule in one place. Remove duplicate, stale, speculative, and ineffective instructions.
- Use plain project language. Add a term only when it makes repeated instructions clearer.
- State the desired behavior directly. Keep explicit prohibitions for safety, authority, and destructive-action boundaries.
- Preserve necessary detail. Do not shorten an instruction until its behavior changes.
- Preserve unrelated content when editing an existing file.

When the document is a skill, read [SKILL-MECHANICS.md](SKILL-MECHANICS.md).

Finish when every instruction changes behavior and all conditional detail remains discoverable.
