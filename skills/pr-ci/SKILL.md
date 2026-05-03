---
name: pr-ci
description: "Fix failing CI/GitHub Actions checks."
argument-hint: "[--auto]"
user-invocable: true
allowed-tools:
  - "Bash(gh pr view:*)"
  - "Bash(gh pr checks:*)"
  - "Bash(gh pr list:*)"
  - "Bash(gh run view:*)"
  - "Bash(gh run list:*)"
  - "Bash(gh repo view:*)"
  - "Bash(git branch --show-current)"
  - "Bash(git add:*)"
  - "Bash(git commit:*)"
  - "Bash(git push:*)"
  - Skill
  - Read
  - Glob
  - Grep
---

# PR GHA Fixer

Fix failed GitHub Actions checks.

**Safety: never rebases. Push requires confirmation (unless `--auto`).**

## Agentic loop

1. **Intake** — Restate the requested outcome, inputs, constraints, and stop conditions. If the request is ambiguous or unsafe, ask before acting.
2. **Discover** — Gather the minimum evidence needed: user context, repo/vault state, relevant files, commands, docs, or external state. Prefer direct source/tool evidence over memory.
3. **Decide** — Choose the smallest valid path for `pr-ci`. Name assumptions, blockers, and what is explicitly out of scope before side effects.
4. **Execute** — Fetch failing checks, reproduce or inspect the failure, fix the cause, and verify the CI-relevant command.
5. **Verify** — Check the result against the request and this skill's rules using concrete evidence: tests, command output, diffs, links, artifacts, or reviewed findings.
6. **Close** — Provide only the concrete handoff the next actor needs: changed paths/artifacts/findings, verification status, remaining blockers, and the next command/action.

Guardrail: Fix the failure, not just the symptom in logs.

## Steps

1. **Detect PR**: `gh pr view --json number -q '.number'` or ask user
2. **Verify branch** (if PR specified manually)

3. **Fetch failed checks**:

   ```bash
   gh pr checks <PR> --json name,state,bucket,link
   ```

   `--auto` → fix all failed checks. Without `--auto` → display as numbered list, ask "Which to fix?"

4. **Fetch logs**:

   ```bash
   gh run list --branch <BRANCH> --json databaseId,name,conclusion --limit 20
   gh run view <RUN_ID> --log-failed
   ```

5. **Plan fixes**: Identify root cause, create concise plan. `--auto` → proceed. Without `--auto` → ask "Ready to execute?"

6. **Execute**: Apply fixes, summarize changes.

7. **Commit**: Use `Skill(commit)` to generate message and commit. `--auto` → commit directly. Without `--auto` → ask first.

8. **Push** (optional): `--auto` → push automatically. Without `--auto` → ask first. Detect stack tool: `gt log --stack 2>/dev/null` succeeds → `Skill(gt:submit)`. Otherwise `git push`.

## Common Failures & Remediation

- **Build** — missing imports, type errors, syntax → read error output, fix source directly
- **Test** — outdated assertions, missing fixtures → update expectations or add missing test data
- **Lint** — formatting, unused imports/vars → run the project formatter, remove dead code
- **Infra** — secrets, rate limits, runner issues → can't fix locally; inform user to check repo/org settings
