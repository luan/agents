# Vault Domain Doc Format

Domain docs live in the blueprints vault as `doc` artifacts. They define project vocabulary, context boundaries, relationships, and known ambiguities. Create or update them through the vault workflow: `ct vault create`, edit, then `ct vault commit`.

## Structure

```md
# {Context Name}

{One or two sentence description of what this context is and why it exists.}

## Language

**Order**:
{A concise description of the term}
_Avoid_: Purchase, transaction

## Relationships

- An **Order** produces one or more **Invoices**

## Example dialogue

> **Dev:** "When a **Customer** places an **Order**, do we create the **Invoice** immediately?"
> **Domain expert:** "No — an **Invoice** is only generated once a **Fulfillment** is confirmed."

## Flagged ambiguities

- "account" was used to mean both **Customer** and **User** — resolved: these are distinct concepts.
```

## Rules

- Be opinionated: pick the best term and list aliases to avoid.
- Flag conflicts explicitly with a clear resolution.
- Keep definitions tight: one sentence max.
- Show relationships with bold term names and cardinality where obvious.
- Only include project-specific domain concepts.
- Group terms under subheadings when natural clusters emerge.
- Write an example dialogue when it clarifies boundaries between related concepts.
