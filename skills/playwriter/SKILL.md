---
name: playwriter
description: Automate the user's existing Chrome via Playwriter/Playwright for JS-heavy or logged-in sites.
---

## Agentic loop

1. **Intake** — Restate the requested outcome, inputs, constraints, and stop conditions. If the request is ambiguous or unsafe, ask before acting.
2. **Discover** — Gather the minimum evidence needed: user context, repo/vault state, relevant files, commands, docs, or external state. Prefer direct source/tool evidence over memory.
3. **Decide** — Choose the smallest valid path for `playwriter`. Name assumptions, blockers, and what is explicitly out of scope before side effects.
4. **Execute** — Use the existing Chrome session to inspect or automate a live site safely and gather browser-grounded evidence.
5. **Verify** — Check the result against the request and this skill's rules using concrete evidence: tests, command output, diffs, links, artifacts, or reviewed findings.
6. **Close** — Provide only the concrete handoff the next actor needs: changed paths/artifacts/findings, verification status, remaining blockers, and the next command/action.

Guardrail: Read the docs first; avoid blind browser automation.

## REQUIRED: Read Full Documentation First

**Before using playwriter, you MUST run this command:**

```bash
playwriter skill # IMPORTANT! do not use | head here. read in full!
```

This outputs the complete documentation including:

- Session management and timeout configuration
- Selector strategies (and which ones to AVOID)
- Rules to prevent timeouts and failures
- Best practices for slow pages and SPAs
- Context variables, utility functions, and more

**Do NOT skip this step.** The quick examples below will fail without understanding timeouts, selector rules, and common pitfalls from the full docs.

**Read the ENTIRE output.** Do NOT pipe through `head`, `tail`, or any truncation command. The skill output must be read in its entirety — critical rules about timeouts, selectors, and common pitfalls are spread throughout the document, not just at the top.

## Minimal Example (after reading full docs)

```bash
playwriter session new
playwriter -s 1 -e 'await page.goto("https://example.com")'
```

**Always use single quotes** for the `-e` argument. Single quotes prevent bash from interpreting `$`, backticks, and backslashes inside your JS code. Use double quotes or backtick template literals for strings inside the JS.

If `playwriter` is not found, use `npx playwriter@latest` or `bunx playwriter@latest`.
