---
name: pr-comments
description: "Fix unresolved PR review comments."
argument-hint: "[--auto]"
user-invocable: true
disable-model-invocation: false
allowed-tools:
  - "Bash(*fetch_threads.py *)"
  - "Bash(gh pr view *)"
  - "Bash(gh pr list *)"
  - "Bash(git add *)"
  - "Bash(git push:*)"
  - Skill
  - Read
  - Glob
  - Grep
---

# PR Comments Fixer

Fix unresolved review comments from a PR.

**Safety: never replies to or resolves threads — only fetches and fixes locally. Push requires confirmation (unless `--auto`). `--auto` auto-resolves bot comments only (not human comments).**

## Agentic loop

1. **Intake** — Restate the requested outcome, inputs, constraints, and stop conditions. If the request is ambiguous or unsafe, ask before acting.
2. **Discover** — Gather the minimum evidence needed: user context, repo/vault state, relevant files, commands, docs, or external state. Prefer direct source/tool evidence over memory.
3. **Decide** — Choose the smallest valid path for `pr-comments`. Name assumptions, blockers, and what is explicitly out of scope before side effects.
4. **Execute** — Fetch unresolved review comments, map each to code, apply required fixes, and verify the thread is addressed.
5. **Verify** — Check the result against the request and this skill's rules using concrete evidence: tests, command output, diffs, links, artifacts, or reviewed findings.
6. **Close** — Provide only the concrete handoff the next actor needs: changed paths/artifacts/findings, verification status, remaining blockers, and the next command/action.

Guardrail: Do not mark a comment addressed unless the diff directly satisfies it.

## Steps

1. **Detect PR**: Run `gh pr view --json number,headRefName` and `gh repo view --json nameWithOwner -q .nameWithOwner`. If no PR found, ask user.

2. **Verify branch**: Compare `git branch --show-current` vs PR headRefName — mismatch → ask user and **stop**. Do not proceed to Step 3 until the user confirms or switches branches.

3. **Fetch comments** (execute directly — never prefix with `python3`/`uv run`):

   ```bash
   ${CLAUDE_SKILL_DIR}/scripts/fetch_threads.py --pr <PR> --repo <Repo>
   ```

   `--auto` → fix all comments, auto-resolve bot comments (author is a bot/app). Without `--auto` → display as numbered list with file:line, author, preview. Ask "Which comment(s) to fix?" — options: "Fix all" / "Other"

4. **Plan fixes**: For each comment, read code, create one-line fix description. `--auto` → proceed. Without `--auto` → ask "Ready to execute?"

5. **Execute**: Apply fixes, summarize changes.

6. **Run tests**: Detect and run the project test suite (look for `test` script in package.json, pytest, cargo test, etc.). Fix failures caused by your changes. If 3+ failures persist after fixes, state the blocker and stop.

7. **Commit**: Use `Skill(commit)` to generate message and commit.

8. **Push** (optional): `--auto` → push automatically. Without `--auto` → ask first. Detect stack tool: `gt log --stack 2>/dev/null` succeeds → `Skill(gt:submit)`. Otherwise `git push`.
