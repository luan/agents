# Skill mechanics

Use these rules when writing or editing a skill.

## Structure

- Keep the shared purpose, essential rules, and routing in `SKILL.md`.
- Move substantial branch-specific guidance, schemas, examples, and procedures to referenced files.
- Link each reference from `SKILL.md`. State when the agent must read it.
- Keep each fact in one place.

## Invocation

A model-invoked skill can activate without a direct user request.

- Keep model invocation enabled when the agent or another skill must find the skill on its own.
- Write a short model-facing `description` that says what the skill does and when it applies.
- Include each distinct trigger once. Do not repeat synonyms for the same trigger.

A user-invoked skill activates only when the user names it.

- Set `disable-model-invocation: true` when the user should always choose the skill manually.
- Use a one-line human-facing `description`.
- Do not make a skill user-invoked only because its work needs approval. Ask for approval before the protected action.

Put shared guidance in a plain reference file when multiple user-invoked skills need it. A user-invoked skill cannot activate another user-invoked skill.

## Split skills

Create a separate model-invoked skill only when it handles an independent request or another skill must activate it.

Keep related modes in one skill when they share the same request and only differ after a user choice.

## Router skills

Use one user-invoked router when the user has too many user-invoked skills to remember.

The router names each skill and when the user should invoke it. It does not activate those skills itself.
