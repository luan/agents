---
name: grill-with-docs
description: Run a relentless round-by-round design-tree interview while recording resolved vocabulary and durable decisions in the project vault.
disable-model-invocation: true
---

Run a `$grilling` session and use `$domain-modeling` inline as terms and decisions crystallise.

Load `$vault` before the first `vlt` operation. Follow its context routing before the first context write. Keep the conversation stateless until something is actually resolved, then record:

- canonical vocabulary with `vlt context set`, passing `--context <name>` in a mapped project
- rare, hard-to-reverse trade-offs as `decision` artifacts

Keep specifications, plans, and implementation work for later skills. Finish when the user confirms shared understanding.
