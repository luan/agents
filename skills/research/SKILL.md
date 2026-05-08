---
name: research
description: 'Research product intent and create a PRD-style vault artifact capturing what to build, why, user stories, decisions, and non-goals. Use when a product idea needs research before planning or implementation.'
argument-hint: "<topic> [--auto] [--continue] [--depth medium|high|max]"
user-invocable: true
---

# Research

Create or revise a canonical vault research artifact. Answer **what are we building and why?** Do not plan implementation work; use `$plan` after research is approved.

## Arguments

- `<topic>` — required unless `--continue`
- `--auto` — skips conversational approval only; the Plannotator gate is still required
- `--continue` — resume an existing research artifact
- `--depth medium|high|max` — controls research breadth

## Workflow

1. **Gather context**
   - Search/read relevant vault artifacts with `vault_*` tools.
   - Read related domain/decision docs, prior research, plans, and docs.
   - Explore code only after the vault vocabulary and decisions are clear.

2. **Research current state**
   - Identify current behavior, user problem, relevant interfaces, constraints, risks, and open questions.
   - Use Explore subagents for large or unfamiliar areas.
   - Validate important claims with direct reads/searches.

3. **Draft product intent**
   - Write target behavior from the user's perspective.
   - Include: problem, solution, user stories, product decisions, technical constraints, testing decisions, non-goals, risks, related links.
   - Do not include phases, task breakdowns, or file-by-file implementation steps.

4. **Review**
   - Before the gate, ask only targeted clarification questions about unresolved scope, stories, terminology, or decisions; do not frame these as approval.
   - Then run `vault_plannotator_gate` on the actual vault file with `gateType="research"`. Use the normal long human-review timeout; do not set a short timeout for research gates.
   - A handled approved Plannotator gate is sufficient approval to continue; do not ask the user for another approval afterward.
   - If denied with feedback, treat it as content feedback: revise the same file and re-gate.
   - If unavailable, timed out, closed without result, or otherwise failed closed, treat it as a Plannotator/tool failure, not a content approval failure. Ask whether to retry the Plannotator gate or pause; do not ask the user to approve the research conversationally. Keep `vault_commit` blocked until a handled approved tool result exists.
   - Do not try to recover Plannotator feedback through separate artifact comment extraction. Plannotator annotations must arrive through the gate result; if they do not, retry or pause.

5. **Commit**
   - Record compact approval metadata only: gate type, approved, timestamp, target, saved path/review id when available.
   - Call `vault_commit` only after approval. Never commit before the research gate, including with `--auto`.

## Completion

When finished, briefly state the artifact or tasks created, what was verified, and the next workflow step.
