---
name: to-tickets
description: Split settled conversation or an implementation-ready artifact into independently deliverable tracer-bullet tickets when explicit work decomposition is useful.
disable-model-invocation: true
---

# To Tickets

Turn settled work into tracer-bullet tickets when the user explicitly wants separately tracked work units.

Load `$vault` before reading or publishing artifacts.

## Process

### 1. Gather the source

Use settled conversation as the source when no artifact is supplied. When the user supplies a vault artifact, resolve it with `read vault://current/<artifact>#depth=2`. Require clear scope, implementation approach, acceptance criteria, and verification regardless of source shape. Report missing information and stop when the work is not implementation-ready.

### 2. Confirm current boundaries

Inspect enough current code and tests to verify the proposed slices against real integration points, dependencies, and test seams. Preserve the source scope and decisions.

Look for opportunities to prefactor the code to make the implementation easier. "Make the change easy, then make the easy change." Prefactoring tickets come first.

### 3. Draft tracer bullets

Each ticket:

- delivers observable end-to-end behavior
- can be implemented and verified in one fresh context
- owns explicit source acceptance criteria
- states its verification evidence
- names only genuine blockers
- leaves the repository coherent after completion

**Wide refactors are the exception to vertical slicing.** A **wide refactor** is one mechanical change — rename a column, retype a shared symbol — whose **blast radius** fans across the whole codebase, so a single edit breaks thousands of call sites at once and no vertical slice can land green. Sequence it as **expand–migrate–contract** instead. First expand: add the new form beside the old so nothing breaks. Then migrate the call sites in batches sized by blast radius (per crate, per package, per directory), each batch its own ticket blocked by the expand, keeping checks green batch to batch because the old form still exists. Finally contract: delete the old form once no caller remains, in a ticket blocked by every migrate batch. When even the batches cannot stay green alone, keep the sequence but let them share an integration branch that all block a final integrate-and-verify ticket — green is promised only there.

### 4. Check coverage

Map every source acceptance criterion or settled requirement to one or more tickets. Merge slices that only produce scaffolding, and split slices that exceed one coherent implementation session. Resolve material ambiguity with the user before publishing.

### 5. Publish tickets

Create blockers first:

```bash
vlt create --type ticket --topic "<ticket title>" --tags "stage/ready-for-agent" --json
vlt update <ticket-stem> --stdin --json
```

When a source artifact exists, record and link it:

```bash
vlt link <ticket> <source> --type derives-from --annotation "Implements one vertical slice"
vlt link <ticket> <blocker> --type blocked-by --annotation "Requires <capability> first"
```

Use this body:

```markdown
## Status

ready_for_agent

## What to Build

The end-to-end behavior this ticket delivers.

## Source Coverage

- Source acceptance criterion or settled requirement covered by this ticket.

## Acceptance Criteria

- [ ] Independently verifiable ticket result.

## Verification

- Check or test that proves completion.

## Blocked By

- Linked ticket title, or `None - can start immediately`.

## Out of Scope

- Adjacent behavior owned elsewhere.

## Delivery Evidence

Pending implementation.
```

### 6. Report the work graph

Report every ticket, covered spec criteria, blocking edges, and the initial frontier. A frontier ticket has `ready_for_agent` status and no incomplete blocker.
