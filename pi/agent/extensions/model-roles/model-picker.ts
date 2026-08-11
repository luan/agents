import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	decodeKittyPrintable,
	fuzzyFilter,
	Key,
	matchesKey,
	type OverlayHandle,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { RoleCandidate } from "./catalog.js";
import { openChoicePicker } from "./choice-picker.js";

type ModelOption = {
	provider: string;
	id: string;
	name?: string;
};

type ModelScope = "scoped" | "all";

type PickerTheme = {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
};

type PickerTui = Pick<TUI, "requestRender" | "terminal">;

const BORDER = "accent";
const FAST_SERVICE_TIER = "priority";
const ALL_THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function modelKey(model: ModelOption): string {
	return `${model.provider}/${model.id}`;
}

function parseModelKey(key: string | undefined): ModelOption | undefined {
	if (!key) return undefined;
	const slash = key.indexOf("/");
	if (slash <= 0 || slash === key.length - 1) return undefined;
	return { provider: key.slice(0, slash), id: key.slice(slash + 1) };
}

function uniqueModels(models: readonly unknown[]): ModelOption[] {
	const seen = new Set<string>();
	return models
		.filter((model): model is ModelOption => {
			if (!model || typeof model !== "object") return false;
			const candidate = model as ModelOption;
			return typeof candidate.provider === "string" && typeof candidate.id === "string";
		})
		.filter((model) => {
			const key = modelKey(model);
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.sort((left, right) => modelKey(left).localeCompare(modelKey(right)));
}

function searchText(model: ModelOption): string {
	return `${model.provider} ${model.id} ${model.name ?? ""}`;
}

function printableText(data: string): string | undefined {
	const kittyPrintable = decodeKittyPrintable(data);
	if (kittyPrintable !== undefined) return kittyPrintable;
	if (
		!data ||
		[...data].some((char) => {
			const code = char.charCodeAt(0);
			return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
		})
	)
		return undefined;
	return data;
}

export async function openModelCandidatePicker(
	ctx: ExtensionContext,
	current?: RoleCandidate,
): Promise<RoleCandidate | undefined> {
	if (!ctx.hasUI || !ctx.ui.custom) return undefined;
	let picker: ModelCandidatePicker | undefined;
	return ctx.ui.custom<RoleCandidate | undefined>(
		(tui, theme, _keybindings, done) => {
			picker = new ModelCandidatePicker(ctx, tui, theme, done, current);
			return picker;
		},
		{
			overlay: true,
			overlayOptions: { width: "100%", anchor: "bottom-left" },
			onHandle: (handle) => picker?.setOverlayHandle(handle),
		},
	);
}

class ModelCandidatePicker {
	private readonly allModels: ModelOption[];
	private readonly scopedModels: ModelOption[];
	private readonly currentModel?: string;
	private scope: ModelScope = "scoped";
	private query = "";
	private searching = false;
	private selected = 0;
	private thinking: ThinkingLevel;
	private serviceTier?: string;
	private overlayHandle?: OverlayHandle;

	constructor(
		private readonly ctx: ExtensionContext,
		private readonly tui: PickerTui,
		private readonly theme: PickerTheme,
		private readonly done: (candidate: RoleCandidate | undefined) => void,
		current?: RoleCandidate,
	) {
		this.currentModel = current?.model;
		this.thinking = current?.thinking ?? "medium";
		this.serviceTier = current?.service_tier;
		const all = uniqueModels(ctx.modelRegistry.getAll());
		this.allModels = uniqueModels([...all, parseModelKey(this.currentModel)]);
		this.scopedModels = uniqueModels(ctx.scopedModels.map((entry) => entry.model));
		this.selectCurrent(this.currentModel);
	}

	setOverlayHandle(handle: OverlayHandle): void {
		this.overlayHandle = handle;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.ctrl("s"))) {
			this.toggleScope();
			return;
		}
		if (matchesKey(data, Key.escape)) {
			if (this.searching || this.query) {
				this.searching = false;
				this.query = "";
				this.selectCurrent();
				this.tui.requestRender();
			} else this.done(undefined);
			return;
		}
		if (!this.searching && data === "q") {
			this.done(undefined);
			return;
		}
		if (this.searching) {
			this.handleSearchInput(data);
			return;
		}
		if (data === "/" || matchesKey(data, Key.ctrl("f"))) {
			this.searching = true;
			this.tui.requestRender();
			return;
		}
		if (data === "t") {
			void this.changeThinking();
			return;
		}
		if (data === "s") {
			void this.changeServiceTier();
			return;
		}
		if (data === "j" || matchesKey(data, Key.down)) {
			this.move(1);
			return;
		}
		if (data === "k" || matchesKey(data, Key.up)) {
			this.move(-1);
			return;
		}
		if (matchesKey(data, Key.home)) {
			this.select(0);
			return;
		}
		if (data === "G" || matchesKey(data, Key.end)) {
			this.select(this.visibleModels().length - 1);
			return;
		}
		if (matchesKey(data, Key.enter) || data === "\r" || data === "\n") this.chooseSelected();
	}

	render(width: number): string[] {
		const terminalHeight = this.tui.terminal.rows;
		if (width < 32 || terminalHeight < 8) return [];
		const innerWidth = Math.max(28, width - 2);
		const bodyHeight = Math.max(1, Math.min(8, terminalHeight - 5));
		const models = this.visibleModels();
		const start = Math.max(0, Math.min(this.selected - bodyHeight + 1, models.length - bodyHeight));
		const position = models.length > 0 ? this.theme.fg("dim", ` ${this.selected + 1}/${models.length}`) : "";
		const lines = [
			this.frame(`${this.theme.fg("accent", this.theme.bold("Select model"))}${position}`, innerWidth),
			this.frame(this.searchLine(innerWidth), innerWidth),
		];
		if (models.length === 0) lines.push(this.frame(this.theme.fg("muted", "No matching models."), innerWidth));
		else {
			for (const [offset, model] of models.slice(start, start + bodyHeight).entries()) {
				lines.push(this.frame(this.renderModel(model, start + offset === this.selected, innerWidth), innerWidth));
			}
		}
		lines.push(this.frame(this.statusLine(innerWidth), innerWidth));
		lines.push(this.frame(this.theme.fg("dim", this.hints(innerWidth)), innerWidth));
		lines.push(this.bottom(innerWidth));
		return lines;
	}

	invalidate(): void {}

	dispose(): void {}

	private handleSearchInput(data: string): void {
		if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
			this.query = this.query.slice(0, -1);
			this.selectCurrent();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.ctrl("u"))) {
			this.query = "";
			this.selectCurrent();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.enter) || data === "\r" || data === "\n") {
			this.searching = false;
			this.chooseSelected();
			return;
		}
		const text = printableText(data);
		if (text === undefined) return;
		this.query += text;
		this.selectCurrent();
		this.tui.requestRender();
	}

	private visibleModels(): ModelOption[] {
		const models = this.baseModels();
		return this.query ? fuzzyFilter(models, this.query, searchText) : models;
	}

	private baseModels(): ModelOption[] {
		const models = this.scope === "scoped" && this.scopedModels.length > 0 ? this.scopedModels : this.allModels;
		if (!this.currentModel || models.some((model) => modelKey(model) === this.currentModel)) return models;
		const current =
			this.allModels.find((model) => modelKey(model) === this.currentModel) ?? parseModelKey(this.currentModel);
		return current ? [current, ...models] : models;
	}

	private selectCurrent(preferredKey = this.selectedModelKey()): void {
		const models = this.visibleModels();
		const index = preferredKey ? models.findIndex((model) => modelKey(model) === preferredKey) : -1;
		this.selected = index >= 0 ? index : Math.min(this.selected, Math.max(0, models.length - 1));
	}

	private selectedModelKey(): string | undefined {
		return this.visibleModels()[this.selected] && modelKey(this.visibleModels()[this.selected]!);
	}

	private selectedModel(): ModelOption | undefined {
		return this.visibleModels()[this.selected];
	}

	private move(delta: number): void {
		this.select(this.selected + delta);
	}

	private select(index: number): void {
		const count = this.visibleModels().length;
		if (count === 0) return;
		this.selected = Math.max(0, Math.min(count - 1, index));
		this.tui.requestRender();
	}

	private toggleScope(): void {
		const key = this.selectedModelKey();
		this.scope = this.scope === "scoped" ? "all" : "scoped";
		this.selectCurrent(key);
		this.tui.requestRender();
	}

	private async changeThinking(): Promise<void> {
		const model = this.selectedModel();
		if (!model) return;
		const levels = this.supportedThinkingLevels(model);
		const options = levels.map((level) => (level === this.thinking ? `${level} (current)` : level));
		const current = options.find((option) => option.startsWith(`${this.thinking} `) || option === this.thinking);
		const selected = await this.nested(() => openChoicePicker(this.ctx, "Thinking level", options, current));
		if (!selected) return;
		this.thinking = selected.replace(/ \(current\)$/, "") as ThinkingLevel;
		this.tui.requestRender();
	}

	private async changeServiceTier(): Promise<void> {
		const options = ["off", "priority (fast)"];
		if (this.serviceTier && this.serviceTier !== FAST_SERVICE_TIER) options.unshift(`${this.serviceTier} (current)`);
		const current = this.serviceTier === FAST_SERVICE_TIER ? "priority (fast)" : (this.serviceTier ?? "off");
		const selected = await this.nested(() => openChoicePicker(this.ctx, "Service tier", options, current));
		if (selected === undefined) return;
		this.serviceTier =
			selected === "off"
				? undefined
				: selected === "priority (fast)"
					? FAST_SERVICE_TIER
					: selected.replace(/ \(current\)$/, "");
		this.tui.requestRender();
	}

	private supportedThinkingLevels(model: ModelOption): ThinkingLevel[] {
		const selectedModel = this.ctx.modelRegistry.find(model.provider, model.id);
		return selectedModel ? getSupportedThinkingLevels(selectedModel) : ALL_THINKING_LEVELS;
	}

	private async nested<T>(action: () => Promise<T>): Promise<T> {
		this.overlayHandle?.setHidden(true);
		try {
			return await action();
		} finally {
			this.overlayHandle?.setHidden(false);
			this.tui.requestRender();
		}
	}

	private chooseSelected(): void {
		const model = this.selectedModel();
		if (!model) return;
		const levels = this.supportedThinkingLevels(model);
		const thinking = levels.includes(this.thinking) ? this.thinking : (levels[0] ?? "off");
		const candidate: RoleCandidate = {
			model: modelKey(model),
			thinking,
			...(this.serviceTier ? { service_tier: this.serviceTier } : {}),
		};
		this.done(candidate);
	}

	private renderModel(model: ModelOption, selected: boolean, width: number): string {
		const key = modelKey(model);
		const cursor = selected ? this.theme.fg("accent", "› ") : "  ";
		const name = model.name && model.name !== model.id ? this.theme.fg("muted", ` — ${model.name}`) : "";
		const current = key === this.currentModel ? this.theme.fg("muted", " (current)") : "";
		const label = selected ? this.theme.bold(key) : key;
		const raw = ` ${cursor}${label}${name}${current}`;
		const clipped = truncateToWidth(raw, width);
		return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
	}

	private searchLine(width: number): string {
		const scope = this.scope === "scoped" ? "scoped" : "all";
		const search = this.searching || this.query ? `search ${this.query || "_"}` : "/ search";
		return truncateToWidth(`${this.theme.fg("dim", `scope ${scope}`)}  ${this.theme.fg("muted", search)}`, width);
	}

	private statusLine(width: number): string {
		const model = this.selectedModel();
		const thinking = model
			? this.supportedThinkingLevels(model).includes(this.thinking)
				? this.thinking
				: "off"
			: "off";
		const tier =
			this.serviceTier === FAST_SERVICE_TIER
				? this.theme.fg("success", "fast")
				: this.theme.fg("muted", this.serviceTier ?? "off");
		return truncateToWidth(
			`${this.theme.fg("dim", "thinking")} ${thinking}  ${this.theme.fg("dim", "tier")} ${tier}`,
			width,
		);
	}

	private hints(width: number): string {
		const scope = this.scope === "scoped" ? "all" : "scoped";
		const text = this.searching
			? "type search  backspace edit  enter save  ctrl+s scope  esc clear"
			: `↑↓/jk move  enter save  / search  t thinking  s tier  ctrl+s ${scope}  esc cancel`;
		return truncateToWidth(text, width);
	}

	private frame(content: string, width: number): string {
		const clipped = truncateToWidth(content, width);
		return `${this.theme.fg(BORDER, "│")}${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}${this.theme.fg(BORDER, "│")}`;
	}

	private bottom(width: number): string {
		return this.theme.fg(BORDER, `└${"─".repeat(Math.max(0, width))}┘`);
	}
}
