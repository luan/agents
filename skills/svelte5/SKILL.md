---
name: svelte5
description: Svelte 5 runes, the replacements for Svelte 4 syntax, placement rules, and verification. Use when writing or reviewing `.svelte` or `.svelte.ts` files, and when extending a component that still uses Svelte 4 syntax.
---

# Svelte 5

## Modern forms

Svelte 4 syntax still parses in some places.
Use the Svelte 5 form.

This matters most in a file already written in Svelte 4. Matching the surrounding style there adds new `export let` props and new `on:click` handlers to a codebase that is trying to leave them behind. Write the new code in the Svelte 5 form even when the file around it has not moved yet.

| Purpose | Svelte 5 form | Replaces |
|---|---|---|
| Reactive state | `$state()` | A reactive `let`; stores (`writable`, `readable`) |
| Computed values | `$derived()` | `$: x = ...`; `$:` reactive statements |
| Side effects | `$effect()` | `$: { ... }`; `$:` reactive statements |
| Component props | `$props()` | `export let` |
| Two-way bindable props | `$bindable()` | — |
| Dynamic components | dynamic component syntax | `svelte:component` |
| Event handlers | `onclick`, `onchange` | `on:click`, `on:change` |
| Content projection | snippets (`{#snippet}`) | `<slot>`, `<slot name="x">` |

## Placement

Place `{@const}` inside `{#each}`, `{#if}`, or a component boundary.
A `{@const}` inside a plain HTML element such as `<button>` or `<div>` fails to compile.

## Verification

After Svelte changes, run the project's configured Svelte check command.
If the project has no configured command, run `npx svelte-check`.
An observed post-edit hook result from `svelte-check --threshold error` also satisfies the check.
Finish with zero errors.
