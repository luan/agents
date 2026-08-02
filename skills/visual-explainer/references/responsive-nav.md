# Persistent Navigation

Use this shell for substantial HTML with four or more peer sections. Short or strongly linear artifacts may omit it.

Provide:

- a sticky top bar for document identity and document-level destinations;
- a page-local table of contents for the current page's `h2` sections.

Keep the title and explanatory summary in the content. The top bar is navigation, not a second masthead.

## Implementation

Reuse `navigation-shell-pattern`, its styles, and `initVeToc()` from `../templates/architecture.html`.

The semantic contract is:

```html
<header data-ve-topbar>...</header>
<div id="top" class="ve-page-shell">
  <aside>
    <nav data-ve-toc aria-label="Page contents">
      <a href="#[section-id]">[Exact h2 text]</a>
    </nav>
  </aside>
  <main class="ve-page">...</main>
</div>
```

## Rules

- Every table-of-contents link matches a stable section ID and repeats its source-native `h2` label.
- Do not add a detached row of navigation chips below the masthead.
- Keep the top bar visible without covering anchored headings.
- Keep the desktop table of contents sticky and independently scrollable.
- At narrow widths, recompose the table of contents as a horizontally scrollable row below the top bar.
- Preserve visible focus, operable overflow, and `aria-current="location"`.
- Size the rail from measured labels; it must not push the main teaching surface below a readable width.

Navigation passes when every link lands correctly, current-section state tracks scrolling, narrow overflow remains operable, and the main teaching surface stays dominant.
