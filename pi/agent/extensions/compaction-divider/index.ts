import {
	CompactionSummaryMessageComponent,
	type ExtensionAPI,
	type ExtensionContext,
	getMarkdownTheme,
	keyText,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, type Component, Markdown, type MarkdownTheme, visibleWidth } from "@earendil-works/pi-tui";
import { formatTokenCount } from "./format-tokens";
import { installCompactionPhasePatch } from "./phase-indicator";

const patchKey = Symbol.for("agents.pi.compaction-divider.patch");
// Match OMP's nerd-preset camera glyph because Pi 0.84 has no symbol-preset API.
const compactionIcon = "\uf083";
const horizontalRule = "─";

type RenderTheme = Pick<Theme, "fg" | "bg">;
type CompactionReason = "manual" | "threshold" | "overflow";

type CompactionMetadata = {
	tokensAfter?: number;
	reason?: CompactionReason;
};

type ThemeCapableUI = {
	theme?: RenderTheme;
};

type CompactionMessage = {
	tokensBefore: number;
	summary: string;
	timestamp?: number;
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
	setMetadata(metadata: CompactionMetadata | undefined): void;
	invalidate(): void;
	render(width: number): string[];
};

type PatchState = {
	theme: RenderTheme;
	dividers: WeakMap<CompactionComponent, SummaryDivider>;
	metadataByTimestamp: ReadonlyMap<number, CompactionMetadata>;
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
		private metadata?: CompactionMetadata,
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

	setMetadata(metadata: CompactionMetadata | undefined): void {
		if (this.metadata === metadata) return;
		this.metadata = metadata;
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
		const range =
			this.metadata?.tokensAfter === undefined
				? formatTokenCount(this.message.tokensBefore)
				: `${formatTokenCount(this.message.tokensBefore)} → ${formatTokenCount(this.metadata.tokensAfter)}`;
		const reason = this.metadata?.reason === undefined ? "" : ` (${this.metadata.reason})`;
		const label = `${compactionIcon} compacted ${range}${reason}`;
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
				`**Compacted from ${this.message.tokensBefore.toLocaleString()}${this.metadata?.tokensAfter === undefined ? "" : ` to ${this.metadata.tokensAfter.toLocaleString()}`} tokens${this.metadata?.reason === undefined ? "" : ` (${this.metadata.reason})`}**\n\n${this.message.summary}`,
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function collectMetadata(ctx: ExtensionContext): Map<number, CompactionMetadata> {
	const metadata = new Map<number, CompactionMetadata>();
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "compaction" || !isRecord(entry.details)) continue;
		const requestMeta = entry.details.requestMeta;
		const dividerMeta = entry.details.compactionDivider;
		const tokensAfter =
			isRecord(requestMeta) && typeof requestMeta.tokensAfter === "number" ? requestMeta.tokensAfter : undefined;
		const reason =
			isRecord(dividerMeta) &&
			(dividerMeta.reason === "manual" || dividerMeta.reason === "threshold" || dividerMeta.reason === "overflow")
				? dividerMeta.reason
				: undefined;
		if (tokensAfter === undefined && reason === undefined) continue;
		const timestamp = typeof entry.timestamp === "number" ? entry.timestamp : Date.parse(entry.timestamp);
		if (Number.isFinite(timestamp)) metadata.set(timestamp, { tokensAfter, reason });
	}
	return metadata;
}

function getDivider(state: PatchState, component: CompactionComponent): SummaryDivider {
	const existing = state.dividers.get(component);
	if (existing) return existing;

	const divider = new SummaryDividerComponent(
		component.message,
		component.markdownTheme ?? getMarkdownTheme(),
		state.theme,
		state.metadataByTimestamp.get(component.message.timestamp ?? Number.NaN),
	);
	state.dividers.set(component, divider);
	return divider;
}

function updateDivider(state: PatchState, component: CompactionComponent): SummaryDivider {
	const divider = getDivider(state, component);
	divider.setTheme(state.theme);
	divider.setMetadata(state.metadataByTimestamp.get(component.message.timestamp ?? Number.NaN));
	divider.setExpanded(component.expanded);
	return divider;
}

export function installCompactionDividerPatch(
	theme: RenderTheme = plainTheme,
	metadataByTimestamp: ReadonlyMap<number, CompactionMetadata> = new Map(),
): void {
	const prototype = CompactionSummaryMessageComponent.prototype as unknown as PatchedPrototype;
	const state = prototype[patchKey] ?? { theme, dividers: new WeakMap(), metadataByTimestamp };
	state.theme = theme;
	state.metadataByTimestamp = metadataByTimestamp;
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
	const refresh = (ctx: ExtensionContext): void => {
		if (ctx.mode !== "tui") return;
		const { theme } = ctx.ui as ThemeCapableUI;
		installCompactionDividerPatch(
			theme && typeof theme.fg === "function" && typeof theme.bg === "function" ? theme : plainTheme,
			collectMetadata(ctx),
		);
	};
	pi.on("session_start", (_event, ctx) => refresh(ctx));
	pi.on("session_compact", (_event, ctx) => refresh(ctx));
}
