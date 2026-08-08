---
name: research
description: Investigate a question against high-trust primary sources and capture cited findings in a vault research artifact. Use when the user wants a topic researched, documentation or API facts gathered, or reading legwork delegated.
---

Load `$vault`, then spin up a **background agent** to do the research while the primary thread keeps moving.

Its job:

1. Investigate the question against **primary sources** — official docs, source code, specs, first-party APIs — not a secondary write-up of them. Follow every claim back to the source that owns it.
2. Return one cited Markdown body plus a short topic suitable for a vault artifact.
3. Create the durable record with `vlt create --type research --topic "<topic>" --json`, then write the returned body with `vlt update <stem> --stdin --json`.
4. Link the research artifact to its source spec, wayfinding ticket, or decision when one exists using `vlt link`.

Keep transient notes in the OS temporary directory. The vault artifact is the durable output.
