import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

export type Tone = "text" | "muted" | "dim" | "accent" | "success" | "warning" | "error" | "info";
export type Emphasis = "normal" | "bold" | "italic" | "inverse";
export type OverflowMode = "clip" | "scroll" | "summarize" | "expandable";

/**
 * The background roles pi's `Theme.bg` accepts, read off pi's own signature. `ThemeBg` is not re-exported from the
 * package root, and hand-spelling it drifted immediately: the copy had 6 members against pi's 7, missing
 * `"scrollbarThumb"`, and a union that differs by one member makes `Theme` assignable to no `RenderTheme` parameter at
 * all through contravariance — the 12 errors `fileops` shows when typechecked. Derived, it cannot drift again.
 *
 * Declaring `role: string` was the original lie: no caller needs an arbitrary role, every one passes a literal or a
 * named subset (`CardBackgroundColor`, `ToolPanelBg`).
 */
export type ThemeBackgroundRole = Parameters<Theme["bg"]>[0];

export interface RenderTheme {
	fg(role: string, text: string): string;
	bg?(role: ThemeBackgroundRole, text: string): string;
	getBgAnsi?(role: string): string | undefined;
	bold?(text: string): string;
}

export interface RenderOptions {
	width: number;
	height?: number;
	theme?: RenderTheme;
	/** Narrowed with `RenderTheme.bg`: the only caller is tui/facade.ts:182 with a literal. */
	background?: ThemeBackgroundRole;
}

export interface TextViewNode {
	kind: "text";
	text: string;
	tone?: Tone;
	emphasis?: Emphasis;
}

export interface RowViewNode {
	kind: "row";
	children: ViewNode[];
	gap?: number;
}

export interface StackViewNode {
	kind: "stack";
	children: ViewNode[];
	gap?: number;
}

export interface PanelViewNode {
	kind: "panel";
	title?: ViewNode;
	children: ViewNode[];
}

export interface BadgeViewNode {
	kind: "badge";
	text: string;
	tone?: Tone;
}

export interface KeyHintsViewNode {
	kind: "keyHints";
	hints: string[];
}

export interface ListItem {
	id: string;
	label: ViewNode;
	meta?: ViewNode;
}

export interface ListViewNode {
	kind: "list";
	items: ListItem[];
	selectedId?: string;
	maxRows?: number;
	overflow?: OverflowMode;
}

interface EmptyViewNode {
	kind: "empty";
}

export interface RawLinesViewNode {
	kind: "rawLines";
	render(options: RenderOptions): string[];
}

export interface ComponentViewNode {
	kind: "component";
	component: Component;
}

export type ViewNode =
	| TextViewNode
	| RowViewNode
	| StackViewNode
	| PanelViewNode
	| BadgeViewNode
	| KeyHintsViewNode
	| ListViewNode
	| EmptyViewNode
	| RawLinesViewNode
	| ComponentViewNode;
