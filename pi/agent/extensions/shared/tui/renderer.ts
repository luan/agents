import { visibleWidth } from "@earendil-works/pi-tui";
import { paintAnsiBackgroundRow } from "./text";
import type { RenderOptions, RenderTheme, Tone, ViewNode } from "./types";

const DEFAULT_THEME: RenderTheme = {
	fg: (_role, text) => text,
	bg: (_role, text) => text,
	bold: (text) => text,
};

export function renderView(node: ViewNode, options: RenderOptions): string[] {
	const theme = options.theme ?? DEFAULT_THEME;
	const width = Math.max(1, options.width);
	const height = options.height ?? Number.POSITIVE_INFINITY;
	const lines = renderNode(node, { ...options, width, theme });
	const rendered = lines.slice(0, height).map((line) => truncateStyled(line, width));
	const background = options.background;
	if (!background) return rendered;
	return rendered.map((line) => paintThemeBackground(line, width, theme, background));
}

function renderNode(
	node: ViewNode,
	options: Required<Pick<RenderOptions, "width" | "theme">> & RenderOptions,
): string[] {
	switch (node.kind) {
		case "text":
			return [style(options.theme, node.tone ?? "text", emphasize(options.theme, node.text, node.emphasis))];
		case "badge":
			return [style(options.theme, node.tone ?? "accent", node.text)];
		case "keyHints":
			return [style(options.theme, "dim", node.hints.join(" · "))];
		case "row":
			return [renderRow(node.children, options, node.gap ?? 1)];
		case "stack":
			return renderStack(node.children, options, node.gap ?? 0);
		case "panel":
			return renderPanel(node, options);
		case "list":
			return renderList(node, options);
		case "rawLines":
			return node.render(options);
		case "component":
			return node.component.render(options.width);
		case "empty":
			return [];
	}
}

function renderRow(
	children: ViewNode[],
	options: Required<Pick<RenderOptions, "width" | "theme">> & RenderOptions,
	gap: number,
): string {
	const separator = " ".repeat(gap);
	const rendered = children.map((child) => renderNode(child, options)[0] ?? "");
	return truncateStyled(rendered.join(separator), options.width);
}

function renderStack(
	children: ViewNode[],
	options: Required<Pick<RenderOptions, "width" | "theme">> & RenderOptions,
	gap: number,
): string[] {
	const lines: string[] = [];
	for (const [index, child] of children.entries()) {
		if (index > 0) {
			for (let gapRow = 0; gapRow < gap; gapRow++) lines.push("");
		}
		lines.push(...renderNode(child, options));
	}
	return lines;
}

function renderPanel(
	node: Extract<ViewNode, { kind: "panel" }>,
	options: Required<Pick<RenderOptions, "width" | "theme">> & RenderOptions,
): string[] {
	const width = Math.max(4, options.width);
	const innerWidth = width - 4;
	const title = node.title ? (renderNode(node.title, { ...options, width: innerWidth })[0] ?? "") : "";
	const topLabel = title ? `─ ${title} ` : "─";
	const topFill = "─".repeat(Math.max(0, width - 2 - visibleStyledWidth(topLabel)));
	const lines = [`╭${topLabel}${topFill}╮`];
	for (const child of node.children) {
		for (const line of renderNode(child, { ...options, width: innerWidth })) {
			const body = padStyled(truncateStyled(line, innerWidth), innerWidth);
			lines.push(`│ ${body} │`);
		}
	}
	lines.push(`╰${"─".repeat(width - 2)}╯`);
	return lines;
}

function renderList(
	node: Extract<ViewNode, { kind: "list" }>,
	options: Required<Pick<RenderOptions, "width" | "theme">> & RenderOptions,
): string[] {
	const maxRows = node.maxRows ?? options.height ?? node.items.length;
	const rows: string[] = [];
	const visibleItems =
		node.overflow === "summarize" && node.items.length > maxRows
			? node.items.slice(0, Math.max(0, maxRows - 1))
			: node.items;
	for (const item of visibleItems) {
		const marker = item.id === node.selectedId ? "› " : "";
		const label = renderNode(item.label, options)[0] ?? "";
		const meta = item.meta ? ` ${renderNode(item.meta, options)[0] ?? ""}` : "";
		rows.push(truncateStyled(`${marker}${label}${meta}`, options.width));
	}
	if (node.overflow === "summarize" && node.items.length > maxRows) {
		rows.push(style(options.theme, "dim", `+${node.items.length - visibleItems.length} more`));
	}
	return rows.slice(0, maxRows);
}

function style(theme: RenderTheme, tone: Tone, text: string): string {
	return theme.fg(tone, text);
}

function paintThemeBackground(line: string, width: number, theme: RenderTheme, role: string): string {
	const backgroundAnsi = theme.getBgAnsi?.(role);
	if (backgroundAnsi) return paintAnsiBackgroundRow(line, width, backgroundAnsi);
	return theme.bg?.(role, padStyled(line, width)) ?? line;
}

function emphasize(theme: RenderTheme, text: string, emphasis: string | undefined): string {
	if (emphasis === "bold") return theme.bold?.(text) ?? text;
	return text;
}

function padStyled(value: string, width: number): string {
	const padding = Math.max(0, width - visibleStyledWidth(value));
	return `${value}${" ".repeat(padding)}`;
}

function truncateStyled(value: string, width: number): string {
	if (visibleStyledWidth(value) <= width) return value;
	const target = Math.max(0, width - 1);
	let visible = 0;
	let output = "";
	const openTags: string[] = [];
	const tokens = value.match(/<[^>]+>|[\s\S]/gu) ?? [];
	for (const token of tokens) {
		if (token.startsWith("<") && token.endsWith(">")) {
			output += token;
			const close = token.match(/^<\/([^>]+)>$/);
			if (close) {
				const index = openTags.lastIndexOf(close[1]!);
				if (index >= 0) openTags.splice(index, 1);
			} else {
				const open = token.match(/^<([^/\s>]+)[^>]*>$/);
				if (open) openTags.push(open[1]!);
			}
			continue;
		}
		const tokenWidth = visibleWidth(token);
		if (visible + tokenWidth > target) {
			output += "…";
			for (const tag of [...openTags].reverse()) output += `</${tag}>`;
			return output;
		}
		output += token;
		visible += tokenWidth;
	}
	return output;
}

function visibleStyledWidth(value: string): number {
	return visibleWidth(value.replace(/<[^>]+>/g, ""));
}
