---
name: brief
description: "Create or revise a compact durable vault brief/PRD from settled intent, optionally using visual review artifacts for UX/workflow clarity. Use after `$grill` or equivalent context when the desired behavior, scope, non-goals, acceptance model, risks, and verification strategy are ready for user review."
argument-hint: "<topic-or-context>"
user-invocable: true
---

# Brief

This skill takes the current conversation context and codebase understanding and produces a "breif" / PRD. Do NOT interview the user — just synthesize what you already know.

## Process

1. Load/use `$vault` before running nontrivial `vlt` workflows. Load project language with `vlt context list`, `vlt context check`, and `vlt context show [name]` before drafting terms or scope language.
2. Explore the repo to understand the current state of the codebase, if you haven't already. Use the project's domain glossary vocabulary throughout the PRD, and respect any ADRs in the area you're touching.
3. Sketch out the major modules you will need to build or modify to complete the implementation. Actively look for opportunities to extract deep modules that can be tested in isolation.
   A deep module (as opposed to a shallow module) is one which encapsulates a lot of functionality in a simple, testable interface which rarely changes.
   Check with the user that these modules match their expectations. Check with the user which modules they want tests written for.
4. Write the PRD using the template below. Load/use `$plannotator-annotate` and run its artifact-gate workflow for the absolute path. Then publish it to the project vault.

<prd-template>

## Problem Statement

The problem that the user is facing, from the user's perspective.

## Solution

The solution to the problem, from the user's perspective.

## User Stories

A LONG, numbered list of user stories. Each user story should be in the format of:

1. As an <actor>, I want a <feature>, so that <benefit>

<user-story-example>
1. As a mobile bank customer, I want to see balance on my accounts, so that I can make better informed decisions about my spending
</user-story-example>

This list of user stories should be extremely extensive and cover all aspects of the feature.

## Implementation Decisions

A list of implementation decisions that were made. This can include:

- The modules that will be built/modified
- The interfaces of those modules that will be modified
- Technical clarifications from the developer
- Architectural decisions
- Schema changes
- API contracts
- Specific interactions

Do NOT include specific file paths or code snippets. They may end up being outdated very quickly.

Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it within the relevant decision and note briefly that it came from a prototype. Trim to the decision-rich parts — not a working demo, just the important bits.

## Testing Decisions

A list of testing decisions that were made. Include:

- A description of what makes a good test (only test external behavior, not implementation details)
- Which modules will be tested
- Prior art for the tests (i.e. similar types of tests in the codebase)

## Out of Scope

A description of the things that are out of scope for this PRD.

## Further Notes

Any further notes about the feature.

</prd-template>
