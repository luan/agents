---
name: fact-check
description: Verify a generated document against actual code and git history
---

Load the visual-explainer skill and fact-check the document named by `$@`. If no argument is given, use the most recently modified HTML file in `~/.agent/diagrams/`.

## Claim extraction

Read the target document. Extract verifiable claims about file paths, function/type/module names, behavior, architecture, data flow, APIs, commands, dependencies, tests, performance/security assertions, and git history. Skip subjective design opinions.

## Verification

For each claim, inspect the actual source or git history. Re-read referenced files. For diff reviews, compare before/after with `git show` or the relevant range. For plan docs, verify referenced files/functions/types exist and behave as described.

Classify claims as verified, corrected, unsupported, or unverifiable. Preserve the document's reader-facing structure and correct factual errors in place. Report the verification work in chat unless the user explicitly requested an audit section. For HTML, inspect the corrected artifact in Dia when permitted; never launch Chrome or Chromium.
