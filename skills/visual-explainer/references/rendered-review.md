# Chrome Rendered Review

Use Chrome through `$computer-use` for substantial HTML unless the user forbids browser or GUI use. Rendered review catches geometry failures that source and accessibility checks cannot prove.

1. Open the local artifact and capture the first viewport.
2. Scroll through every section and exercise every control from its initial state.
3. Inspect desktop width, 200% zoom, and a narrow viewport when available.
4. Check navigation against `./responsive-nav.md` and containment/connector behavior against `./css-patterns.md`.
5. Fix defects and repeat from the top; never approve from one screenshot.

Specifically reject detached arrowheads, stale progressive edges, leaking labels, clipped focus rings, obscured anchors, unintended page-level horizontal scrolling, or controls whose visual consequence is unclear.

If a narrow Chrome viewport is unavailable, pair desktop review with static narrow-layout checks and disclose the missing rendered gate.
