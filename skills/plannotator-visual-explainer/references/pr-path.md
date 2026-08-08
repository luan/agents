# PR path

For PR walkthroughs, diff reviews, code change explainers, and reviewer guides.

Read [`design-system.md`](design-system.md) for theme tokens, typography, and component patterns, and [`pr-components.md`](pr-components.md) for diff rendering, review comment bubbles, risk chips, file cards, and before/after panels.

## Document structure

In order, picking what fits:

1. **Header** — PR title, meta strip (file count, +/- lines, branch, author)
2. **TL;DR** — bordered card with primary accent left border. 2-3 sentences. Readers who see nothing else should get the gist.
3. **Why** — motivation and before/after comparison (two-column grid)
4. **File tour** — collapsible cards per file. Each has: file path + badge (NEW/MOD/DEL) + line stats, a "why" paragraph, and important diff hunks. High-risk files expanded, safe files collapsed.
5. **Risk map** — visual chips showing which files need careful review vs. which are mechanical. Three tiers: attention (destructive), medium (warning), safe (success).
6. **Where to focus** — numbered callout cards. Each names a file/function and describes the concern.
7. **Test plan** — checkbox-style verification checklist
8. **Rollout** (if applicable) — phased deployment with feature flags

Use Pierre diffs via CDN for syntax-highlighted inline diffs — see [`pr-components.md`](pr-components.md) for the pattern.
