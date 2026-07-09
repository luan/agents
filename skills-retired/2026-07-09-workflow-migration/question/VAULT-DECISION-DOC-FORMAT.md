# Vault Decision Doc Format

Decision docs live in the blueprints vault as `doc` artifacts. They record architectural decisions that future agents should not re-litigate without cause. Create or update them through the vault workflow: `vlt create`, edit, then `vlt commit`.

## Template

```md
# {Short title of the decision}

{1-3 sentences: what's the context, what did we decide, and why.}
```

Optional sections are useful only when they add genuine value: status, considered options, or non-obvious consequences.

## When to offer a decision doc

All three must be true:

1. Hard to reverse
2. Surprising without context
3. The result of a real trade-off

If a decision is easy to reverse, unsurprising, or not a real trade-off, skip it.
