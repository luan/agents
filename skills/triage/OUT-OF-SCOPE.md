# Out-of-Scope Decisions

Store durable rejected-enhancement reasoning as `decision` artifacts in the vault. One decision covers one domain concept and may link to many requests.

## Purpose

- Preserve why the enhancement is beyond the product's scope.
- Surface earlier reasoning when a similar request returns.

## Create or update

1. Search first: `vlt search --type decision "<concept> out of scope"`.
2. Read the closest candidates and their backlinks.
3. Update the matching decision or create one with `vlt create --type decision --topic "<concept> out of scope" --tags "scope/out-of-scope" --json`.
4. Link the rejected source artifact with `vlt link <decision> <source> --type governs --annotation "Records why this enhancement is out of scope"`.

## Body

```markdown
## Decision

This project excludes <concept>.

## Why

Durable product, domain, or architectural reasoning.

## Reconsider when

Concrete conditions that would justify reopening the decision.
```

Use this record for rejected enhancements. Already-implemented behavior points to the implementation instead, and verified bugs continue through normal triage.
