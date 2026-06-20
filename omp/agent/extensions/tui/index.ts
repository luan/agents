import { buildSessionContext, CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { defaultConfig } from "../../../../pi/agent/extensions/tui/config";
import {
	emptyFooterState,
	estimateContextBreakdown,
	type FooterRenderState,
	renderEditorContextStatus,
	renderEditorTopStatus,
	scaleContextSegmentsToUsage,
	scaleContextSlicesToUsage,
} from "../../../../pi/agent/extensions/tui/footer";

const BLINKING_BEAM_CURSOR = "\x1b[5 q";
const RESET_CURSOR_SHAPE = "\x1b[0 q";
const EDITOR_RAIL_WIDTH = 2;
const EDITOR_CHROME_LINES = 1;
const CONTEXT_STATUS_MAX_WIDTH = 88;

type CursorTerminal = {
	write?: unknown;
};

type CursorTui = {
	terminal?: CursorTerminal;
	getShowHardwareCursor?: unknown;
	setShowHardwareCursor?: unknown;
};

type ExtensionUiWithEditor = {
	setEditorComponent?: unknown;
	notify?: unknown;
	theme?: unknown;
};

type ThemeLike = {
	borderColor?: unknown;
	fg?: unknown;
	hintStyle?: unknown;
};

type EditorTopBorder = {
	content: string;
	width: number;
};

type Keybindings = unknown;

type EditorConstructorArgs = ConstructorParameters<typeof CustomEditor>;
type CustomEditorConstructor = typeof CustomEditor;

type NativeEditorControls = {
	borderColor?: (text: string) => string;
	getTopBorderAvailableWidth?: (terminalWidth: number) => number;
	setBorderVisible?: (visible: boolean) => void;
	setMaxHeight?: (height: number | undefined) => void;
	setPaddingX?: (padding: number) => void;
	setPromptGutter?: (gutter: string | undefined) => void;
	setTopBorder?: (content: EditorTopBorder | undefined) => void;
	setUseTerminalCursor?: (enabled: boolean) => void;
};

export type PromptEditorChrome = {
	contextStatus?: string;
	headerLeft?: string;
	headerRight?: string;
};

export type PromptEditorChromeProvider = (width: number) => PromptEditorChrome | undefined;

function filteredAppActionKeys(action: string, keys: readonly string[]): string[] {
	const editorOwnedKeys =
		action === "app.exit" ? new Set(["ctrl+d"]) : action === "app.model.cycleForward" ? new Set(["ctrl+p"]) : undefined;
	if (!editorOwnedKeys) return [...keys];
	return keys.filter((key) => !editorOwnedKeys.has(key.toLowerCase()));
}

function editorConstructorArgs(
	EditorClass: CustomEditorConstructor,
	tui: CursorTui,
	theme: ThemeLike,
	keybindings: Keybindings,
): EditorConstructorArgs {
	return (
		EditorClass.length >= 3 ? [tui, theme, keybindings] : [theme]
	) as unknown as EditorConstructorArgs;
}

function writeCursorShape(tui: CursorTui, sequence: string): boolean {
	const terminal = tui.terminal;
	const write = terminal?.write;
	if (typeof write !== "function") return false;
	write.call(terminal, sequence);
	return true;
}

function fitLine(line: string, width: number): string {
	const lineWidth = visibleWidth(line);
	if (lineWidth === width) return line;
	if (lineWidth > width) return truncateToWidth(line, width, "");
	return line + " ".repeat(width - lineWidth);
}

function compactContextWidth(width: number): number {
	return Math.max(12, Math.min(CONTEXT_STATUS_MAX_WIDTH, Math.floor(width * 0.6)));
}

function rightAlign(text: string, width: number): string {
	const fitted = truncateToWidth(text, width, "").replace(/\x1b\[0m$/, "");
	return " ".repeat(Math.max(0, width - visibleWidth(fitted))) + fitted;
}

function composeLeftRight(left: string, right: string | undefined, width: number): string {
	if (!right) return truncateToWidth(left, width, "");
	const fittedRight = truncateToWidth(right, width, "");
	if (!left) return rightAlign(fittedRight, width);
	const rightWidth = visibleWidth(fittedRight);
	const leftWidth = Math.max(0, width - rightWidth - 1);
	const fittedLeft = truncateToWidth(left, leftWidth, "");
	const gap = Math.max(1, width - visibleWidth(fittedLeft) - rightWidth);
	return fittedLeft + " ".repeat(gap) + fittedRight;
}

function dim(theme: ThemeLike, text: string): string {
	return typeof theme.hintStyle === "function" ? (theme.hintStyle as (value: string) => string)(text) : text;
}

function fg(theme: ThemeLike, role: string, text: string): string {
	return typeof theme.fg === "function" ? (theme.fg as (role: string, value: string) => string)(role, text) : text;
}

function hasThemeColorSource(theme: ThemeLike): theme is ThemeLike & { fg: (role: string, text: string) => string } {
	return typeof theme.fg === "function";
}

function rail(theme: ThemeLike, colorRail: ((text: string) => string) | unknown): string {
	const glyph =
		typeof colorRail === "function" ? (colorRail as (text: string) => string)("┃") : fg(theme, "accent", "┃");
	return `${glyph}${dim(theme, " ")}`;
}

function configuredEditor(editor: CustomEditor): CustomEditor {
	const controls = editor as unknown as NativeEditorControls;
	controls.setBorderVisible?.(false);
	controls.setPaddingX?.(0);
	controls.setPromptGutter?.(undefined);
	controls.setUseTerminalCursor?.(true);
	return editor;
}

export function createNativeOmpPromptEditor(
	EditorClass: CustomEditorConstructor,
	tui: CursorTui,
	theme: ThemeLike,
	keybindings: Keybindings,
	chromeProvider?: PromptEditorChromeProvider,
	renderTheme: ThemeLike = theme,
): CustomEditor {
	class NativeOmpPromptEditor extends EditorClass {
		#topBorder: EditorTopBorder | undefined;

		getTopBorderAvailableWidth(terminalWidth: number): number {
			return Math.max(0, terminalWidth - EDITOR_RAIL_WIDTH);
		}

		setTopBorder(content: EditorTopBorder | undefined): void {
			this.#topBorder = content;
		}
		setMaxHeight(height: number | undefined): void {
			const baseSetMaxHeight = Object.getPrototypeOf(NativeOmpPromptEditor.prototype).setMaxHeight;
			if (typeof baseSetMaxHeight === "function") {
				baseSetMaxHeight.call(this, height === undefined ? undefined : Math.max(1, height - EDITOR_CHROME_LINES));
			}
		}

		setActionKeys(action: string, keys: string[]): void {
			const baseSetActionKeys = Object.getPrototypeOf(NativeOmpPromptEditor.prototype).setActionKeys;
			if (typeof baseSetActionKeys === "function") {
				baseSetActionKeys.call(this, action, filteredAppActionKeys(action, keys));
			}
		}

		override handleInput(data: string): void {
			if (matchesKey(data, "ctrl+d")) {
				super.handleInput("\x1b[3~");
				return;
			}
			if (matchesKey(data, "ctrl+p")) {
				super.handleInput("\x1b[A");
				return;
			}
			if (matchesKey(data, "ctrl+n")) {
				super.handleInput("\x1b[B");
				return;
			}
			super.handleInput(data);
		}

		override render(width: number): string[] {
			writeCursorShape(tui, BLINKING_BEAM_CURSOR);
			if (width <= EDITOR_RAIL_WIDTH) return [...super.render(width)];

			const innerWidth = Math.max(1, width - EDITOR_RAIL_WIDTH);
			const bodyLines = [...super.render(innerWidth)];
			const chrome = chromeProvider?.(innerWidth);
			const colorRail = (this as unknown as NativeEditorControls).borderColor ?? renderTheme.borderColor ?? theme.borderColor;
			const prefix = rail(renderTheme, colorRail);
			const chromeLine = (line: string) => prefix + fitLine(line, innerWidth);
			const hostStatus = this.#topBorder?.content;
			const header = chrome?.contextStatus
				? composeLeftRight(hostStatus ?? chrome.headerRight ?? "", chrome.contextStatus, innerWidth)
				: composeLeftRight("", hostStatus ?? chrome?.headerRight, innerWidth);

			return [chromeLine(header), ...bodyLines.map(chromeLine)];
		}
	}

	return configuredEditor(new NativeOmpPromptEditor(...editorConstructorArgs(EditorClass, tui, theme, keybindings)));
}

export function installNativeOmpPromptEditor(
	ctx: ExtensionContext,
	EditorClass: CustomEditorConstructor = CustomEditor,
	chromeProvider?: PromptEditorChromeProvider,
): () => void {
	const ui = ctx.ui as ExtensionUiWithEditor;
	const setEditorComponent = ui.setEditorComponent;
	if (typeof setEditorComponent !== "function") {
		if (typeof ui.notify === "function") ui.notify("Native OMP editor unavailable: editor surface is missing", "warning");
		return () => {};
	}

	let activeTui: CursorTui | undefined;
	let previousHardwareCursor: boolean | undefined;

	setEditorComponent.call(ui, (tui: CursorTui, theme: ThemeLike, keybindings: Keybindings) => {
		activeTui = tui;
		previousHardwareCursor =
			typeof tui.getShowHardwareCursor === "function" ? tui.getShowHardwareCursor.call(tui) : undefined;
		if (typeof tui.setShowHardwareCursor === "function") tui.setShowHardwareCursor.call(tui, true);
		writeCursorShape(tui, BLINKING_BEAM_CURSOR);
		const uiTheme = typeof ui.theme === "object" && ui.theme !== null ? (ui.theme as ThemeLike) : undefined;
		const renderTheme = {
			...(uiTheme ?? {}),
			borderColor: theme.borderColor ?? uiTheme?.borderColor,
			hintStyle: theme.hintStyle ?? uiTheme?.hintStyle,
		};
		return createNativeOmpPromptEditor(EditorClass, tui, theme, keybindings, chromeProvider, renderTheme);
	});

	return () => {
		if (activeTui) {
			writeCursorShape(activeTui, RESET_CURSOR_SHAPE);
			if (
				typeof previousHardwareCursor === "boolean" &&
				typeof activeTui.setShowHardwareCursor === "function"
			) {
				activeTui.setShowHardwareCursor.call(activeTui, previousHardwareCursor);
			}
		}
		setEditorComponent.call(ui, undefined);
	};
}

function formatCount(value: number): string {
	if (value < 1000) return `${value}`;
	if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
	return `${Math.round(value / 1000)}k`;
}

function formatProviderLabel(provider: string | undefined): string {
	if (!provider) return "Unknown";
	const known: Record<string, string> = {
		anthropic: "Anthropic",
		gemini: "Google",
		google: "Google",
		ollama: "Ollama",
		openai: "OpenAI",
		"openai-codex": "OpenAI",
	};
	return known[provider] ?? provider.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function systemPromptText(prompt: unknown): string {
	if (typeof prompt === "string") return prompt;
	if (Array.isArray(prompt)) {
		return prompt
			.map((part) => {
				if (typeof part === "string") return part;
				if (part && typeof part === "object" && "text" in part) {
					const text = (part as { text?: unknown }).text;
					return typeof text === "string" ? text : "";
				}
				return "";
			})
			.filter(Boolean)
			.join("\n");
	}
	if (prompt && typeof prompt === "object" && "content" in prompt) {
		return systemPromptText((prompt as { content?: unknown }).content);
	}
	return String(prompt ?? "");
}

function sessionEntries(ctx: ExtensionContext): readonly unknown[] {
	const sessionManager = (ctx as unknown as { sessionManager?: { getEntries?: () => readonly unknown[] } }).sessionManager;
	return sessionManager?.getEntries?.() ?? [];
}

function sessionLeafId(ctx: ExtensionContext): string | undefined {
	const sessionManager = (ctx as unknown as { sessionManager?: { getLeafId?: () => string | null | undefined } })
		.sessionManager;
	return sessionManager?.getLeafId?.() ?? undefined;
}

function usageTotals(ctx: ExtensionContext): { input: number; output: number; cost: number } {
	let input = 0;
	let output = 0;
	let cost = 0;
	for (const entry of sessionEntries(ctx)) {
		if (!entry || typeof entry !== "object") continue;
		const message = (entry as { message?: unknown }).message;
		if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "assistant") continue;
		const usage = (message as { usage?: { input?: number; output?: number; cost?: { total?: number } } }).usage;
		input += usage?.input ?? 0;
		output += usage?.output ?? 0;
		cost += usage?.cost?.total ?? 0;
	}
	return { input, output, cost };
}

function syncFooterState(pi: ExtensionAPI, ctx: ExtensionContext, state: FooterRenderState, activeMessage?: unknown): void {
	const totals = usageTotals(ctx);
	const contextUsage = ctx.getContextUsage?.();
	const contextWindow = ctx.model?.contextWindow ?? contextUsage?.contextWindow ?? 0;
	const measuredContextTokens =
		typeof contextUsage?.tokens === "number" && contextUsage.tokens > 0 ? contextUsage.tokens : undefined;
	const contextMessages = buildSessionContext([...sessionEntries(ctx)] as never, sessionLeafId(ctx)).messages;
	const rawContext = estimateContextBreakdown(
		activeMessage ? [...contextMessages, activeMessage] : contextMessages,
		systemPromptText(ctx.getSystemPrompt?.()),
	);
	const estimatedContextTokens = Object.values(rawContext.segments).reduce((total, value) => total + value, 0);
	const storedContextUsed =
		measuredContextTokens ??
		(contextUsage && contextWindow > 0 && contextUsage.percent !== null
			? Math.round((contextUsage.percent / 100) * contextWindow)
			: estimatedContextTokens);
	const contextUsed =
		activeMessage && measuredContextTokens !== undefined
			? Math.max(measuredContextTokens, estimatedContextTokens)
			: storedContextUsed;

	state.modelLabel = ctx.model?.name ?? "no-model";
	state.providerLabel = formatProviderLabel(ctx.model?.provider);
	state.thinkingLevel = ctx.model?.reasoning ? pi.getThinkingLevel?.() : undefined;
	state.contextPercent = contextUsage?.percent ?? (contextWindow > 0 ? (contextUsed / contextWindow) * 100 : null);
	state.contextTotal = contextWindow;
	state.contextUsed = contextUsed;
	state.contextSegments = scaleContextSegmentsToUsage(rawContext.segments, contextUsed);
	state.contextSlices = scaleContextSlicesToUsage(rawContext.slices, contextUsed);
	state.contextUsageEstimated = measuredContextTokens === undefined;
	state.tokenLabel = `↑${formatCount(totals.input)} ↓${formatCount(totals.output)}`;
	state.costLabel = `$${totals.cost.toFixed(2)}`;
	state.hasTokens = totals.input > 0 || totals.output > 0;
	state.hasCost = totals.cost > 0;
}

export default function (pi: ExtensionAPI): void {
	const state = emptyFooterState();
	let cleanupEditor: (() => void) | undefined;
	let currentCtx: ExtensionContext | undefined;

	const chromeProvider: PromptEditorChromeProvider = (width) => {
		const uiTheme = (currentCtx?.ui as ExtensionUiWithEditor | undefined)?.theme as ThemeLike | undefined;
		if (!uiTheme || !hasThemeColorSource(uiTheme)) {
			return {
				headerLeft: "",
				headerRight: state.modelLabel,
			};
		}
		return {
			contextStatus: renderEditorContextStatus(state, uiTheme as never, compactContextWidth(width)),
			headerLeft: "",
			headerRight: renderEditorTopStatus(state, defaultConfig, currentCtx?.cwd ?? process.cwd(), uiTheme as never, width),
		};
	};

	pi.on("session_start", async (_event, ctx) => {
		cleanupEditor?.();
		currentCtx = ctx;
		syncFooterState(pi, ctx, state);
		cleanupEditor = installNativeOmpPromptEditor(ctx, CustomEditor, chromeProvider);
	});

	pi.on("session_shutdown", async () => {
		cleanupEditor?.();
		cleanupEditor = undefined;
		currentCtx = undefined;
	});

	pi.on("agent_start", async (_event, ctx) => {
		currentCtx = ctx;
		syncFooterState(pi, ctx, state);
	});

	pi.on("agent_end", async (_event, ctx) => {
		currentCtx = ctx;
		syncFooterState(pi, ctx, state);
	});

	pi.on("model_select", async (_event, ctx) => {
		currentCtx = ctx;
		syncFooterState(pi, ctx, state);
	});

	pi.on("message_update", async (event, ctx) => {
		currentCtx = ctx;
		syncFooterState(pi, ctx, state, event.message);
	});

	pi.on("message_end", async (_event, ctx) => {
		currentCtx = ctx;
		syncFooterState(pi, ctx, state);
	});
}
