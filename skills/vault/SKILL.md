---
name: vault
description: "Find and manage blueprints vault artifacts with resource tools. Use for vault research, plans, docs, domain notes, decisions, and explicit vlt CLI workflows."
argument-hint: "<topic-or-stem> [--all-projects] [--archived]"
---

# Vault resources

Use resource tools first. Use `vlt` only for explicit CLI workflows or operations without a resource surface.

## Resource model

- `vault://current/<type>/<stem>` reads a normal artifact.
- `vault://current/context` reads root `CONTEXT.md`.
- `vault://current/context?name=<context>` reads a named context.
- `vault://current/<artifact>#frontmatter` reads frontmatter.
- `vault://current/<artifact>#depth=2` reads linked artifacts within two hops.
- `vault://current/<artifact>#links` reads outgoing links.
- `vault://current/<artifact>#backlinks` reads incoming links.
- `vault://current/<artifact>#similar?limit=10` reads similar artifacts.
- `vault://current/<artifact>#related` reads topic-related artifacts.
- `vault://current/_search?query=<text>` reads search results.
- `vault://current/_related?topic=<text>` reads related results.
- `vault://current/_similar?file=<artifact>` reads similar results.
- `vault://current/_links?file=<artifact>` reads outgoing links.
- `vault://current/_backlinks?file=<artifact>` reads incoming links.
- `vault://current/_graph` reads the vault graph.
- `vault://current/_review` reads vault health.
- `vault://current/_check` reads unresolved links.
- `vault://current/_status` reads vault status.
- `vault://current/_types` reads available artifact types.
- `vault://current/context#list` reads available context docs.

Use `read` for known resources. Use `search` for topic matching. Use `find` for artifact discovery and query filters. Use `write` or `edit` for existing artifacts and context docs.

## CLI-only operations

Use `vlt` when the user asks for CLI syntax or when no resource operation exists yet:

- create
- archive or prune
- rename
- retag
- link mutation
- commit control

Read `vlt <command> --help` for exact flags.

## Discovery loop

1. Search by topic words.
2. Read the best match.
3. Follow links, backlinks, related, or similar views when needed.
4. Write or edit the artifact when the user asks for a change.
5. Call out conflicts between vault intent, tasks, and code.

## Structural model

- Context docs are project structure: `CONTEXT.md`, `CONTEXT-MAP.md`, and named `contexts/<name>/CONTEXT.md` files.
- Normal artifacts are typed docs under `<project>/<type>/<stem>.md`.
- Numeric stems are stable identifiers.
- Artifact types are workflow-owned directory names. Custom types are valid.
- Archived artifacts are history. Confirm before presenting one as current.
