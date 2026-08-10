import {
	CompactionSummaryMessageComponent,
	type ExtensionAPI,
	type ExtensionContext,
	getMarkdownTheme,
	keyText,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, type Component, Markdown, type MarkdownTheme, visibleWidth } from "@earendil-works/pi-tui";
import { installCompactionPhasePatch } from "./phase-indicator";

const patchKey = Symbol.for("agents.pi.compaction-divider.patch");
// Match OMP's nerd-preset camera glyph because Pi 0.84 has no symbol-preset API.
const compactionIcon = "\uf083";
const horizontalRule = "─";

type RenderTheme = Pick<Theme, "fg" | "bg">;

type ThemeCapableUI = {
	theme?: RenderTheme;
};

type CompactionMessage = {
	tokensBefore: number;
	summary: string;
};

type CompactionComponent = {
	expanded: boolean;
	message: CompactionMessage;
	markdownTheme?: MarkdownTheme;
	clear: () => void;
};

type SummaryDivider = {
	setExpanded(expanded: boolean): void;
	setTheme(theme: RenderTheme): void;
	invalidate(): void;
	render(width: number): string[];
};

type PatchState = {
	theme: RenderTheme;
	dividers: WeakMap<CompactionComponent, SummaryDivider>;
};

type PatchedPrototype = {
	[patchKey]?: PatchState;
	updateDisplay(this: CompactionComponent): void;
	render(this: CompactionComponent, width: number): string[];
	invalidate(this: CompactionComponent): void;
};

const plainTheme: RenderTheme = {
	fg: (_color, text) => text,
	bg: (_color, text) => text,
};

class SummaryDividerComponent implements SummaryDivider, Component {
	private expanded = false;
	private cache?: { width: number; lines: string[] };
	private detail?: Box;

	constructor(
		private readonly message: CompactionMessage,
		private readonly markdownTheme: MarkdownTheme,
		private theme: RenderTheme,
	) {}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		this.cache = undefined;
	}

	setTheme(theme: RenderTheme): void {
		if (this.theme === theme) return;
		this.theme = theme;
		this.invalidate();
	}

	invalidate(): void {
		this.cache = undefined;
		this.detail = undefined;
	}

	render(width: number): string[] {
		width = Math.max(1, width);
		if (this.cache?.width === width) return this.cache.lines;

		// Pi 0.84 inserts Spacer(1) before this component, so omit OMP's leading blank.
		const lines = this.expanded
			? [this.renderDivider(width), "", ...this.renderDetail().render(width)]
			: [this.renderDivider(width), ""];
		this.cache = { width, lines };
		return lines;
	}

	private renderDivider(width: number): string {
		const label = `${compactionIcon} compacted`;
		const expandKey = keyText("app.tools.expand") || "ctrl+o";
		const hint = `· ${expandKey}`;
		const plainWidth = visibleWidth(`${label} ${hint}`);
		const remaining = width - plainWidth - 2;

		if (remaining < 4) return this.theme.fg("muted", label);

		const left = Math.floor(remaining / 2);
		const right = remaining - left;
		return (
			this.theme.fg("dim", horizontalRule.repeat(left)) +
			` ${this.theme.fg("muted", label)} ${this.theme.fg("dim", hint)} ` +
			this.theme.fg("dim", horizontalRule.repeat(right))
		);
	}

	private renderDetail(): Box {
		if (this.detail) return this.detail;

		const box = new Box(1, 1, (text) => this.theme.bg("customMessageBg", text));
		box.addChild(
			new Markdown(
				`**Compacted from ${this.message.tokensBefore.toLocaleString()} tokens**\n\n${this.message.summary}`,
				0,
				0,
				this.markdownTheme,
				{ color: (text) => this.theme.fg("customMessageText", text) },
			),
		);
		this.detail = box;
		return box;
	}
}

function getDivider(state: PatchState, component: CompactionComponent): SummaryDivider {
	const existing = state.dividers.get(component);
	if (existing) return existing;

	const divider = new SummaryDividerComponent(
		component.message,
		component.markdownTheme ?? getMarkdownTheme(),
		state.theme,
	);
	state.dividers.set(component, divider);
	return divider;
}

function updateDivider(state: PatchState, component: CompactionComponent): SummaryDivider {
	const divider = getDivider(state, component);
	divider.setTheme(state.theme);
	divider.setExpanded(component.expanded);
	return divider;
}

export function installCompactionDividerPatch(theme: RenderTheme = plainTheme): void {
	const prototype = CompactionSummaryMessageComponent.prototype as unknown as PatchedPrototype;
	const state = prototype[patchKey] ?? { theme, dividers: new WeakMap() };
	state.theme = theme;
	state.dividers = new WeakMap();
	prototype[patchKey] = state;
	prototype.updateDisplay = function updateCompactionDividerDisplay(this: CompactionComponent): void {
		this.clear();
		updateDivider(state, this);
	};
	prototype.render = function renderCompactionDivider(this: CompactionComponent, width: number): string[] {
		return updateDivider(state, this).render(width);
	};
	prototype.invalidate = function invalidateCompactionDivider(this: CompactionComponent): void {
		state.dividers.get(this)?.invalidate();
	};
}

export default function compactionDividerExtension(pi: ExtensionAPI): void {
	installCompactionPhasePatch(pi);
	installCompactionDividerPatch();
	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		const { theme } = ctx.ui as ThemeCapableUI;
		if (theme && typeof theme.fg === "function" && typeof theme.bg === "function") {
			installCompactionDividerPatch(theme);
		}
	});
}
