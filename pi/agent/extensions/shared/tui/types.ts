import type { Component } from "@earendil-works/pi-tui";

export type Tone = "text" | "muted" | "dim" | "accent" | "success" | "warning" | "error" | "info";
export type Emphasis = "normal" | "bold" | "italic" | "inverse";
export type OverflowMode = "clip" | "scroll" | "summarize" | "expandable";

export interface RenderTheme {
	fg(role: string, text: string): string;
	bg?(role: string, text: string): string;
	getBgAnsi?(role: string): string | undefined;
	bold?(text: string): string;
}

export interface RenderOptions {
	width: number;
	height?: number;
	theme?: RenderTheme;
	background?: string;
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

export interface EmptyViewNode {
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
