---
name: zoom-out
description: "Zoom out: explain broader module/caller context for unfamiliar code."
user-invocable: true
disable-model-invocation: true
---

I don't know this area of code well. Go up a layer of abstraction. Search/read relevant blueprints vault domain and decision artifacts, then give me a map of all relevant modules and callers using the project's recorded vocabulary. If no relevant vault docs exist, proceed silently.

## Agentic loop

1. **Intake** — Restate the requested outcome, inputs, constraints, and stop conditions. If the request is ambiguous or unsafe, ask before acting.
2. **Discover** — Gather the minimum evidence needed: user context, repo/vault state, relevant files, commands, docs, or external state. Prefer direct source/tool evidence over memory.
3. **Decide** — Choose the smallest valid path for `zoom-out`. Name assumptions, blockers, and what is explicitly out of scope before side effects.
4. **Execute** — Explain broader code context by tracing modules, callers, responsibilities, and seams.
5. **Verify** — Check the result against the request and this skill's rules using concrete evidence: tests, command output, diffs, links, artifacts, or reviewed findings.
6. **Close** — Provide only the concrete handoff the next actor needs: changed paths/artifacts/findings, verification status, remaining blockers, and the next command/action.

Guardrail: Ground explanations in source references, not architectural storytelling.
