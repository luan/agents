# Vault Decision Doc Format

Decision docs live in the blueprints vault as `doc` artifacts. They record architectural decisions that future agents should not re-litigate without cause. Create or update them through the vault workflow: MCP `create`/edit/MCP `commit`, or the equivalent `ct vault` commands.

## Template

```md
# {Short title of the decision}

{1-3 sentences: what's the context, what did we decide, and why.}
```

That's it. A decision doc can be a single paragraph. The value is in recording *that* a decision was made and *why* — not in filling out sections.

## Optional sections

Only include these when they add genuine value. Most decision docs won't need them.

- **Status** frontmatter (`proposed | accepted | deprecated | superseded by [[stem]]`) — useful when decisions are revisited
- **Considered Options** — only when the rejected alternatives are worth remembering
- **Consequences** — only when non-obvious downstream effects need to be called out

## When to offer a decision doc

All three of these must be true:

1. **Hard to reverse** — the cost of changing your mind later is meaningful
2. **Surprising without context** — a future reader will look at the code and wonder why it works this way
3. **The result of a real trade-off** — there were genuine alternatives and one was picked for specific reasons

If a decision is easy to reverse, skip it. If it's not surprising, skip it. If there was no real alternative, skip it.

### What qualifies

- **Architectural shape.** "We're using a monorepo." "The write model is event-sourced, the read model is projected into Postgres."
- **Integration patterns between contexts.** "Ordering and Billing communicate via domain events, not synchronous HTTP."
- **Technology choices that carry lock-in.** Database, message bus, auth provider, deployment target.
- **Boundary and scope decisions.** "Customer data is owned by the Customer context; other contexts reference it by ID only."
- **Deliberate deviations from the obvious path.** "We're using manual SQL instead of an ORM because X."
- **Constraints not visible in the code.** "We can't use AWS because of compliance requirements."
- **Rejected alternatives when the rejection is non-obvious.** If you considered GraphQL and picked REST for subtle reasons, record it.
