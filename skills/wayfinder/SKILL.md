---
name: wayfinder
description: Plan an effort too large and foggy for one session as a vault map of decision tickets, then resolve one frontier ticket per session until the route is clear.
disable-model-invocation: true
---

# Wayfinder

Chart a loose, multi-session effort as a shared **map** of decisions. Wayfinding produces clarity, not the destination itself: stop when nothing material remains to decide before implementation.

Load `$vault` before creating or resolving the map.

## Plan, don't do

Wayfinder is **planning** by default: each ticket resolves a decision, and the map is done when the way is clear — nothing left to decide before someone goes and does the thing. The pull to just do the work is usually the signal you have reached the edge of the map and it is time to hand off. An effort can override this in its map `## Notes` — carrying execution into the map itself — but absent that, produce decisions, not deliverables.

## Language

- **Destination** — the clear end state the map is finding a route toward.
- **Map** — one `wayfinder` vault artifact that indexes resolved decisions and fog.
- **Ticket** — one `wayfinding` vault artifact containing a precise question sized for one session.
- **Fog of war** — in-scope questions that are visible but not precise enough to ticket yet.
- **Frontier** — open, unclaimed tickets whose `blocked-by` links are all resolved.

Refer to maps and tickets by their titles in human-facing text. Include stems as links or parenthetical identifiers when needed for `vlt` commands.

## Map shape

```markdown
## Destination

One or two lines describing what reaching the end of the map means.

## Notes

Domain, standing constraints, and skills each session should use.

## Decisions so far

- [[resolved-ticket]] — one-line gist of the answer

## Not yet specified

In-scope fog that cannot yet be phrased as a precise question.

## Out of scope

Work deliberately beyond the destination.
```

The map is an index. Each detailed answer lives in exactly one ticket artifact.

## Ticket shape

```markdown
## Status

open

## Mode

AFK research | HITL prototype | HITL grilling | AFK/HITL task

## Question

The single decision or investigation this ticket resolves.

## Resolution

Pending.
```

Create artifacts and relationships through `vlt`:

```bash
vlt create --type wayfinder --topic "<map title>" --json
vlt create --type wayfinding --topic "<ticket title>" --source <map-stem> --tags "wayfinder/<mode>,stage/open" --json
vlt link <map> <ticket> --type contains --annotation "Decision on the current map"
vlt link <ticket> <blocker> --type blocked-by --annotation "Question depends on this answer"
```

## Ticket modes

- **Research** (AFK): use `$research`; link its vault research artifact to the ticket.
- **Prototype** (HITL): use `$prototype`; capture the learned answer in the ticket or a linked vault artifact.
- **Grilling** (HITL): use `$grilling` with `$domain-modeling`, one frontier round at a time.
- **Task** (AFK or HITL): perform a bounded prerequisite that makes a later decision possible.

A HITL ticket resolves through live user judgment. The agent supplies recommendations and evidence while the user makes the decision.

## Chart a map

1. Run `$grilling` with `$domain-modeling` to name the destination first.
2. Grill breadth-first across the space to surface precise questions and fog. If no fog remains, stop: the effort is small enough to move directly to `$to-spec` or implementation.
3. Create the map artifact with destination, notes, empty decisions, fog, and out-of-scope sections.
4. Create every currently precise ticket, then add `contains` and `blocked-by` links in a second pass.
5. Fire the research subagents. For each research ticket just created, dispatch a subagent to resolve it in parallel. Put the question, the primary-source discipline, and the artifact destination in the prompt itself — a subagent cannot reach `$research`. Link each returned vault research artifact to its ticket.
6. Report the frontier and stop. Charting and resolving are separate sessions.

## Work through a map

Resolve at most one ticket per session — research tickets excepted, since they run as parallel subagents.

1. Read the map at low resolution with `read vault://current/<map>#depth=1`.
2. Select the named ticket or the first frontier ticket. Claim it immediately by replacing `## Status` with `in_progress` and a session identifier when available.
3. Resolve it using the mode-specific skill and only the related artifacts needed for this question.
4. Replace the ticket's `## Resolution`, set its status to `resolved`, and append one linked gist to the map's `## Decisions so far`.
5. Create newly precise tickets, wire blockers, and remove graduated fog from `## Not yet specified`. Move work beyond the destination into `## Out of scope` and set any corresponding ticket status to `out_of_scope`.
6. Report the new frontier and stop.

When every ticket is resolved or out of scope and no fog remains, the map is complete. Hand the settled understanding to `$to-spec`.
