import type { Component } from "@earendil-works/pi-tui";
import type {
	BadgeViewNode,
	ComponentViewNode,
	Emphasis,
	KeyHintsViewNode,
	ListItem,
	ListViewNode,
	PanelViewNode,
	RawLinesViewNode,
	RenderOptions,
	RowViewNode,
	StackViewNode,
	TextViewNode,
	Tone,
	ViewNode,
} from "./types";

export const view = {
	text(text: string, options: { tone?: Tone; emphasis?: Emphasis } = {}): TextViewNode {
		return { kind: "text", text, ...options };
	},

	row(children: ViewNode[], options: { gap?: number } = {}): RowViewNode {
		return { kind: "row", children, ...options };
	},

	stack(children: ViewNode[], options: { gap?: number } = {}): StackViewNode {
		return { kind: "stack", children, ...options };
	},

	panel(options: { title?: ViewNode; children: ViewNode[] }): PanelViewNode {
		return { kind: "panel", ...options };
	},

	statusBadge(text: string, options: { tone?: Tone } = {}): BadgeViewNode {
		return { kind: "badge", text, ...options };
	},

	keyHints(hints: string[]): KeyHintsViewNode {
		return { kind: "keyHints", hints };
	},

	list(options: { items: ListItem[]; selectedId?: string; maxRows?: number; overflow?: ListViewNode["overflow"] }) {
		return { kind: "list", ...options } satisfies ListViewNode;
	},

	empty(): ViewNode {
		return { kind: "empty" };
	},

	rawLines(render: (options: RenderOptions) => string[]): RawLinesViewNode {
		return { kind: "rawLines", render };
	},

	component(component: Component): ComponentViewNode {
		return { kind: "component", component };
	},
};
