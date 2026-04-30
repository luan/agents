---
name: spec
description: "Create a PRD-style vault spec: what to build, why, user stories, decisions. No implementation plan."
argument-hint: "<topic> [--auto] [--continue] [--depth medium|high|max]"
allowed-tools:
  - Agent
  - Bash
  - Read
  - Glob
  - Grep
user-invocable: true
---

# Spec

Create a PRD-style blueprints vault `spec` artifact. This skill answers **what are we building and why?** It does not produce implementation plans; use `/prepare` after the spec is approved.

The blueprints vault is canonical. Use `ct vault`. New specs start with the `stage/needs-triage` tag.

## Arguments

- `<topic>` — what to specify, required unless `--continue`
- `--auto` — skip the approval gate and commit the best spec you can synthesize from current context
- `--continue` — resume from an existing vault spec; ask the user to choose if multiple matches are plausible
- `--depth medium|high|max` — controls research depth, not planning detail

## Process

### 1. Gather vault context

Search/read relevant vault artifacts before exploring code:

- domain docs for project vocabulary and context boundaries
- decision docs/specs for architectural choices in the touched area
- related specs/plans/reviews that capture active or historical intent

If no relevant vault docs exist, proceed silently.

### 2. Research current state

Dispatch Explore subagents for codebase research when the answer is not already in context.

Required findings:

1. **Current behavior** — what exists today and where it falls short
2. **User/problem context** — who is affected and why this matters
3. **Relevant modules/interfaces** — current public behavior and constraints, not a plan
4. **Design space** — viable product/technical directions with tradeoffs
5. **Risks/open questions** — specific uncertainties that affect scope or acceptance

For complex domains, dispatch parallel Explore agents with different lenses: product behavior, architecture constraints, and skeptical risk review.

### 3. Validate research

Spot-check important architectural claims with direct reads/searches. If a claim affects product behavior, acceptance criteria, or scope, validate it before including it.

For bug specs, include root-cause confidence:

- **HIGH** — reproduced and traced to a specific cause
- **MEDIUM** — strong evidence but not fully isolated
- **LOW** — plausible hypothesis, significant uncertainty remains

If confidence is LOW, say so explicitly in the spec.

### 4. Draft the spec

Write the spec as target product intent. It should be understandable without reading source code to infer what the user wants.

Use this structure:

```markdown
# <Spec Title>

## Problem Statement

The problem from the user's perspective. Include current limitations only where they clarify the problem.

## Solution

The desired target behavior from the user's perspective. Present tense. Include important edge cases and non-goals.

## User Stories

1. As an <actor>, I want <capability>, so that <benefit>.
2. ...

## Product Decisions

- Durable decisions about scope, behavior, UX, or workflow.
- Alternatives considered and why they were rejected, when useful.

## Technical Decisions

- Durable implementation-facing decisions needed to understand intent.
- Public interfaces, contracts, data shapes, or integration constraints when they are part of the product contract.
- Do not include step-by-step implementation instructions.

## Testing Decisions

- Behaviors that must be covered.
- Test seams or prior art when known.
- What not to test because it would couple to implementation details.

## Out of Scope

- Explicit non-goals and adjacent features that should not be pulled in.

## Risks and Open Questions

- Concrete uncertainty, failure scenarios, or dependencies.

## Related

- [[related-artifact]]
```

Do not include an implementation plan, phase list, task breakdown, or file-by-file instructions. Those belong in `/prepare`.

### 5. Review with the user

If `--auto` is not set, present the draft and stop for approval. Ask about scope, missing user stories, wrong vocabulary, and decisions that need correction.

For feedback:

- Minor corrections → revise directly.
- New unexplored behavior or architecture → dispatch follow-up research, then revise.

### 6. Store in the vault

Create or update a `spec` artifact:

1. Run `ct vault create -t spec --topic "..." --tags stage/needs-triage,...`.
2. Edit the returned path with the approved body.
3. Run `ct vault related "<topic>"` and append related wiki-links when useful.
4. Run `ct vault commit <path>`.

## Resume

With `--continue`, search/list vault specs for the current topic, read the selected artifact, and resume at user review. Include inline vault comments if present.

## Output

Return:

```text
Spec: <topic>
Spec file: <path-or-stem>
Next: /prepare <spec-stem>
```
