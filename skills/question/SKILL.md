---
name: question
description: "Grills product or engineering intent against existing docs and code, then seeds QRDSPI context with resolved choices. Use when a request needs vocabulary, scope, edge cases, defaults, or user preferences clarified before research, design, structure, plan, or implementation."
user-invocable: true
---

# Question

## Quick start

Read enough vault context and code to avoid lazy questions, interview the user in small batches, then stop with a **Question Summary** that later work can carry forward.

No-edit, no-implementation phase. Do not call `apply_patch`, create tasks, write vault artifacts, or continue into another QRDSPI phase in the same turn. Stop after the Question Summary.

## Workflow

1. **Ground the interview**
   - Search/read relevant vault artifacts: domain docs, decisions, research, design, structure, plans, and related docs.
   - Inspect the code for existing behavior, vocabulary, UI/API surfaces, state/persistence seams, and tests; inspect the code rather than asking when evidence is available.
   - Answer anything the docs/code can answer. Ask humans only for intent, tradeoffs, priorities, or missing domain facts.
   - Build a working evidence map with file/module/symbol references and label uncertainty explicitly.

2. **Grill the design tree**
   - Walk the design tree branch-by-branch through vocabulary, user-visible behavior, scope, ownership/persistence, compatibility/migration, failure cases, non-goals, and acceptance boundaries.
   - Prefer `ask_user` for 1-3 focused questions at a time. Give a recommended answer for every question.
   - Use concrete scenarios, not abstract prompts.
   - After each answer, update the working decision tree and ask another batch if an unresolved branch could materially change evidence gathering or solution direction.
   - Do not stop after one batch merely because you have plausible defaults.

3. **Emit the handoff**
   - Produce a Question Summary as a context handoff packet, not a polished artifact.
   - Include:
     - intent in project vocabulary
     - evidence map: docs/code read, relevant symbols, current behavior, uncertainty
     - resolved answers with rationale
     - decision tree covered
     - blocking open questions only
     - recommended defaults and explicit non-goals
     - **Context seed for research**: established answers plus factual claims to verify

## Quality bar

- The output should preserve enough context that later work can continue from the conversation alone.
- Do not make the research handoff merely a list of generic questions.
- Do not create or update vault artifacts by default.
