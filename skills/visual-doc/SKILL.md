---
name: visual-doc
description: Create concise Plannotator-ready HTML visual documents for briefs, issue proposals, implementation evidence, reviews, and manual verification gates. Use when a skill needs a visual companion, visual report, screenshot/recording evidence, Plannotator HTML, or `plannotator annotate --render-html`.
user-invocable: true
---

# Visual Doc

Use this skill whenever another skill needs a temporary visual artifact for
Plannotator. The durable brief, issue proposal, task record, PR, or code remains
the source of truth; the visual doc makes decisions and evidence fast to review.

## Quick start

1. Choose the review purpose: explain, compare, decide, or verify.
2. Read [REFERENCE.md](REFERENCE.md) for the shared HTML base and media patterns.
3. Use [USE-CASES.md](USE-CASES.md) for brief, issues, and implement layouts.
4. Put the most important conclusion in the first viewport.
5. Present once with Plannotator:

```bash
plannotator annotate <artifact.html> --render-html
```

Add `--gate` to that command only when approval is required before continuing.

## Required shape

- Header: artifact purpose, source document/task, review question.
- Summary strip: 3-5 cards with the facts a reviewer needs first.
- Main evidence: one card per slice, scenario, decision, or workflow state.
- Relationships: blocker map, dependency chain, before/after, or matrix.
- Appendix: media paths, commands, test data, caveats.
- Approval callout for gated docs: what approval accepts and what feedback
  means.

## Quality bar

- The first viewport answers what changed, why it matters, and what needs review.
- Visual structure carries the meaning: cards for slices, matrices for coverage,
  timelines for sequence, before/after panels for behavior changes.
- Raw logs and transcripts live in the appendix; evidence panels are the primary
  review surface.
