# Vault Context Format

## Term shape

```bash
vlt context set "Order" \
  --definition "A confirmed request for fulfilment." \
  --avoid "Purchase,transaction" \
  --json
```

## Rules

- **Be opinionated.** When multiple words exist for the same concept, pick the best one and list the others under `_Avoid_`.
- **Keep definitions tight.** One or two sentences max. Define what it IS, not what it does.
- **Only include terms specific to this project's context.** General programming concepts (timeouts, error types, utility patterns) don't belong even if the project uses them extensively. Before adding a term, ask: is this a concept unique to this context, or a general programming concept? Only the former belongs.
- **Group terms under subheadings** when natural clusters emerge. If all terms belong to a single cohesive area, a flat list is fine.

## Single and multiple contexts

Use `read vault://current/context#list` and `read vault://current/context?name=map` to discover the project shape.

For a named context, read and edit `vault://current/context?name=<context>`.

Infer the relevant context from the map and current topic. Ask one focused question when the choice changes the meaning.
