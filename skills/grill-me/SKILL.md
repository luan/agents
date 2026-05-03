---
name: grill-me
description: Grill the user on a plan/design with no side effects until decisions and assumptions are clear.
---

Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

Ask the questions one at a time.

If a question can be answered by exploring the codebase, explore the codebase instead.

## Agentic loop

1. **Intake** — Restate the requested outcome, inputs, constraints, and stop conditions. If the request is ambiguous or unsafe, ask before acting.
2. **Discover** — Gather the minimum evidence needed: user context, repo/vault state, relevant files, commands, docs, or external state. Prefer direct source/tool evidence over memory.
3. **Decide** — Choose the smallest valid path for `grill-me`. Name assumptions, blockers, and what is explicitly out of scope before side effects.
4. **Execute** — Interrogate a plan or design until assumptions, decisions, and risks are explicit; make no code changes.
5. **Verify** — Check the result against the request and this skill's rules using concrete evidence: tests, command output, diffs, links, artifacts, or reviewed findings.
6. **Close** — Provide only the concrete handoff the next actor needs: changed paths/artifacts/findings, verification status, remaining blockers, and the next command/action.

Guardrail: Questions must force decisions, not performative discussion.
