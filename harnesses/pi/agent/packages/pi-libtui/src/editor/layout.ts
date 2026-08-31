import type { Component, TUI } from "@earendil-works/pi-tui";

// type-boundary: Pi 0.84.x keeps its active layout root and stack entries private; the guards below narrow them.
type PiLayoutValue = unknown;

interface LayoutEntry {
	component: Component;
	minSize?: number;
}

export interface EditorMinimumRowsLease {
	reconcile(editor: Component): void;
	dispose(): void;
}

function isComponent(value: PiLayoutValue): value is Component {
	return typeof value === "object" && value !== null && typeof Reflect.get(value, "render") === "function";
}

function isLayoutEntry(value: PiLayoutValue): value is LayoutEntry {
	return typeof value === "object" && value !== null && isComponent(Reflect.get(value, "component"));
}

function childComponents(component: Component): readonly Component[] {
	const children = Reflect.get(component, "children") as PiLayoutValue;
	return Array.isArray(children) ? children.filter(isComponent) : [];
}

function layoutEntries(component: Component): readonly LayoutEntry[] {
	const entries = Reflect.get(component, "entries") as PiLayoutValue;
	return Array.isArray(entries) ? entries.filter(isLayoutEntry) : [];
}

function contains(root: Component, target: Component, seen = new Set<object>()): boolean {
	if (root === target) return true;
	if (seen.has(root)) return false;
	seen.add(root);
	return childComponents(root).some((child) => contains(child, target, seen));
}

function editorEntry(root: Component, editor: Component, seen = new Set<object>()): LayoutEntry | undefined {
	if (seen.has(root)) return undefined;
	seen.add(root);
	for (const entry of layoutEntries(root)) {
		const nested = editorEntry(entry.component, editor, seen);
		if (nested) return nested;
		if (contains(entry.component, editor)) return entry;
	}
	for (const child of childComponents(root)) {
		const nested = editorEntry(child, editor, seen);
		if (nested) return nested;
	}
	return undefined;
}

/** Adapt Pi's dock allocation to a borderless editor while tolerating hosts without the expected private layout shape. */
export function installEditorMinimumRows(tui: TUI, minimumRows: number): EditorMinimumRowsLease {
	const rows = Math.max(0, Math.floor(minimumRows));
	let active = true;
	let entry: LayoutEntry | undefined;
	let originalMinimum: number | undefined;
	return {
		reconcile(editor) {
			if (!active) return;
			if (!entry || !contains(entry.component, editor)) {
				const root = Reflect.get(tui as object, "layoutRoot") as PiLayoutValue;
				if (!isComponent(root)) return;
				entry = editorEntry(root, editor);
				if (!entry) return;
				originalMinimum = entry.minSize;
			}
			entry.minSize = rows;
		},
		dispose() {
			if (!active) return;
			active = false;
			if (entry?.minSize === rows) entry.minSize = originalMinimum;
			tui.requestRender();
		},
	};
}
