---
name: to-tickets
description: Break a settled vault spec, plan, or conversation into tracer-bullet ticket artifacts with explicit blocking links.
disable-model-invocation: true
---

# To Tickets

Turn settled work into **tracer bullet** tickets: narrow vertical slices, each independently verifiable and linked to everything that blocks it.

Load `/vault` before reading or publishing artifacts.

## Process

### 1. Gather context

Read the supplied vault artifact with `vlt read <stem> --depth 2`. When only conversation context is supplied, search for related specs, decisions, and research with `vlt search`, then follow `vlt links` and `vlt backlinks`.

### 2. Explore the codebase

Explore enough current code to make the slices real. Use vault context vocabulary and respect durable decisions. Look for prefactoring that makes the change easy before making the easy change.

### 3. Draft vertical slices

Each ticket:

- cuts a complete path through every affected layer
- delivers behavior that can be demonstrated or verified alone
- fits one fresh context window
- states acceptance criteria in observable terms
- names every genuine blocker

Use **expand–migrate–contract** for a wide refactor whose blast radius cannot remain green as independent vertical slices. Keep each migration batch green when possible; otherwise make the shared integration point and final verification explicit.

### 4. Grill the breakdown

Present the proposed tickets by title, blockers, and delivered behavior. Use `/grilling` one decision at a time to settle granularity, blocking edges, and merges or splits. Publish only after the user confirms the breakdown.

### 5. Publish vault tickets

Create blockers first:

```bash
vlt create --type ticket --topic "<ticket title>" --source <spec-stem> --tags "stage/ready-for-agent" --json
vlt update <ticket-stem> --stdin --json
```

Link every ticket to its source and blockers:

```bash
vlt link <ticket> <spec> --type derives-from --annotation "Implements one vertical slice"
vlt link <ticket> <blocker> --type blocked-by --annotation "Requires <capability> first"
```

Use this body:

```markdown
## Status

ready_for_agent

## What to build

The end-to-end behavior this ticket makes work.

## Acceptance criteria

- [ ] Independently verifiable criterion

## Blocked by

- Linked ticket title, or `None — can start immediately`

## Out of scope

- Adjacent behavior intentionally excluded

## Delivery evidence

Pending implementation.
```

Keep titles and prose durable: prefer behavior and interfaces over file paths. Inline a small prototype-derived state machine, schema, reducer, or type shape only when it encodes a settled decision more precisely than prose.

Report the **frontier**: ticket artifacts whose `## Status` is `ready_for_agent` and whose `blocked-by` links all point to completed tickets. Work one frontier ticket per fresh context with `/implement`.
