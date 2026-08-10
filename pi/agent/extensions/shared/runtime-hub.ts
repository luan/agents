import { spawn } from "node:child_process";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { paintAnsiBackgroundRow } from "./tui/text";

export type RuntimeHubKind = "agent" | "terminal" | "job" | "session";
export type RuntimeHubScope = "current" | "project" | "global";
export type RuntimeHubFilter = "all" | "agents" | "subagents" | "ttys";

export function cycleRuntimeHubScope(scope: RuntimeHubScope): RuntimeHubScope {
	return scope === "current" ? "global" : scope === "global" ? "project" : "current";
}

export function cycleRuntimeHubFilter(filter: RuntimeHubFilter): RuntimeHubFilter {
	return filter === "all" ? "agents" : filter === "agents" ? "subagents" : filter === "subagents" ? "ttys" : "all";
}

export function filterRuntimeHubEntries(entries: RuntimeHubEntry[], filter: RuntimeHubFilter): RuntimeHubEntry[] {
	if (filter === "agents") return entries.filter((entry) => entry.kind === "session");
	if (filter === "subagents") return entries.filter((entry) => entry.kind === "agent");
	if (filter === "ttys") return entries.filter((entry) => entry.kind === "terminal");
	return entries;
}
export interface RuntimeAttachment {
	command: string;
	args: string[];
}

export function runtimeAttachmentEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	return { ...env, TMUX: undefined, TMUX_PANE: undefined, RMUX: undefined, RMUX_PANE: undefined };
}

export async function attachRuntimeTerminal(
	attachment: RuntimeAttachment,
	tui: Pick<TUI, "requestRender" | "start" | "stop">,
): Promise<boolean> {
	tui.stop();
	try {
		return await new Promise<boolean>((resolve) => {
			const child = spawn(attachment.command, attachment.args, {
				stdio: "inherit",
				env: runtimeAttachmentEnv(),
			});
			child.once("error", () => resolve(false));
			child.once("close", (code) => resolve(code === 0));
		});
	} finally {
		tui.start();
		tui.requestRender(true);
	}
}

export interface RuntimeHubEntry {
	key: string;
	kind: RuntimeHubKind;
	label: string;
	status: string;
	description?: string;
	parent?: string;
	parentKey?: string;
	lastActivity: number;
	open(tui: Pick<TUI, "requestRender" | "start" | "stop" | "terminal">): Promise<void> | void;
	stop?(): Promise<boolean> | boolean;
	attach?(tui: Pick<TUI, "requestRender" | "start" | "stop" | "terminal">): Promise<boolean> | boolean;
	restart?(): Promise<boolean> | boolean;
}

export interface RuntimeHubSource {
	list(ctx: ExtensionContext, scope: RuntimeHubScope): RuntimeHubEntry[];
	refresh?(ctx: ExtensionContext, scope: RuntimeHubScope): Promise<void>;
}

const sourcesKey = Symbol.for("agents.runtimeHub.sources");
const sharedGlobal = globalThis as typeof globalThis & Record<symbol, Map<string, RuntimeHubSource> | undefined>;

function sources(): Map<string, RuntimeHubSource> {
	const existing = sharedGlobal[sourcesKey];
	if (existing) return existing;
	const created = new Map<string, RuntimeHubSource>();
	sharedGlobal[sourcesKey] = created;
	return created;
}

export function registerRuntimeHubSource(name: string, source: RuntimeHubSource): () => void {
	sources().set(name, source);
	return () => {
		if (sources().get(name) === source) sources().delete(name);
	};
}

const shortcutPatchKey = Symbol.for("agents.runtimeHub.command-shortcut-context");

export function installRuntimeHubShortcutPatch(): void {
	const prototype = InteractiveMode.prototype as unknown as {
		[shortcutPatchKey]?: boolean;
		setupExtensionShortcuts(extensionRunner: {
			getShortcuts(config: unknown): Map<string, { handler: (ctx: ExtensionContext) => Promise<void> | void }>;
		}): void;
	};
	if (prototype[shortcutPatchKey]) return;
	const original = prototype.setupExtensionShortcuts;
	prototype.setupExtensionShortcuts = function setupRuntimeHubShortcuts(this: any, extensionRunner): void {
		let shortcuts: Map<string, { handler: (ctx: ExtensionContext) => Promise<void> | void }> | undefined;
		const getShortcuts = extensionRunner.getShortcuts;
		extensionRunner.getShortcuts = (config: unknown) => {
			shortcuts = getShortcuts.call(extensionRunner, config);
			return shortcuts;
		};
		try {
			original.call(this, extensionRunner);
		} finally {
			extensionRunner.getShortcuts = getShortcuts;
		}
		for (const shortcut of shortcuts?.values() ?? []) {
			const handler = shortcut.handler;
			shortcut.handler = (ctx) =>
				handler(
					Object.assign(ctx, {
						switchSession: (sessionPath: string, options?: unknown) =>
							this.handleResumeSession(sessionPath, options),
					}) as ExtensionCommandContext,
				);
		}
	};
	prototype[shortcutPatchKey] = true;
}

async function refreshSources(ctx: ExtensionContext, scope: RuntimeHubScope): Promise<string | undefined> {
	const results = await Promise.allSettled([...sources().values()].map((source) => source.refresh?.(ctx, scope)));
	const failed = results.find((result) => result.status === "rejected");
	if (!failed || failed.status !== "rejected") return undefined;
	return failed.reason instanceof Error ? failed.reason.message : String(failed.reason);
}

function entries(ctx: ExtensionContext, scope: RuntimeHubScope): RuntimeHubEntry[] {
	return [...sources().values()]
		.flatMap((source) => source.list(ctx, scope))
		.sort(
			(left, right) =>
				statusOrder(left.status) - statusOrder(right.status) || right.lastActivity - left.lastActivity,
		);
}

export async function openRuntimeHub(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI || !ctx.ui.custom) return;
	const notice = await refreshSources(ctx, "current");
	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => new RuntimeHubOverlay(ctx, tui, theme, () => done(), notice),
		{
			overlay: true,
			overlayOptions: {
				width: "100%",
				maxHeight: "100%",
				anchor: "top-left",
				margin: 0,
			},
		},
	);
}

class RuntimeHubOverlay {
	focused = true;
	private selected = 0;
	private hovered: number | null = null;
	private rows: RuntimeHubEntry[] = [];
	private rowOrder?: Map<string, number>;
	private treeBranches = new Map<string, string>();
	private viewMode: "roster" | "tree" = "roster";
	private scope: RuntimeHubScope = "current";
	private filter: RuntimeHubFilter = "all";
	private narrowDetailsOpen = false;
	private detailOffset = 0;
	private hitRows: Array<number | undefined> = [];
	private splitRosterWidth?: number;
	private flatHit?: [number, number];
	private treeHit?: [number, number];
	private currentScopeHit?: [number, number];
	private projectScopeHit?: [number, number];
	private globalScopeHit?: [number, number];
	private allFilterHit?: [number, number];
	private agentsFilterHit?: [number, number];
	private subagentsFilterHit?: [number, number];
	private ttysFilterHit?: [number, number];
	private notice?: string;
	private closed = false;
	private lastLeftTap = 0;
	private readonly timer: ReturnType<typeof setInterval>;

	constructor(
		private readonly ctx: ExtensionContext,
		private readonly tui: Pick<TUI, "requestRender" | "terminal">,
		private readonly theme: {
			fg(color: string, text: string): string;
			bg(color: string, text: string): string;
			getBgAnsi?(color: string): string | undefined;
			bold(text: string): string;
		},
		private readonly done: () => void,
		initialNotice?: string,
	) {
		this.notice = initialNotice;
		this.refresh();
		this.timer = setInterval(() => {
			void refreshSources(this.ctx, this.scope).then((notice) => {
				this.notice = notice;
				this.refresh();
				this.tui.requestRender();
			});
		}, 5_000);
		this.timer.unref();
	}

	handleInput(data: string): void {
		if (this.handleMouse(data)) return;
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.alt("a")) || data === "q") {
			if (this.narrowDetailsOpen && this.splitRosterWidth === undefined) {
				this.narrowDetailsOpen = false;
				this.tui.requestRender();
			} else {
				this.close();
			}
			return;
		}
		if ((matchesKey(data, Key.tab) || data === "\t") && this.splitRosterWidth === undefined) {
			if (this.rows.length > 0) this.narrowDetailsOpen = !this.narrowDetailsOpen;
			this.tui.requestRender();
			return;
		}
		if (data === "g") {
			this.setScope(cycleRuntimeHubScope(this.scope));
			return;
		}
		if (data === "t") {
			this.setViewMode(this.viewMode === "roster" ? "tree" : "roster");
			return;
		}
		if (data === "f") {
			this.setFilter(cycleRuntimeHubFilter(this.filter));
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.scrollDetails(-1);
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.scrollDetails(1);
			return;
		}
		if (matchesKey(data, Key.left)) {
			if (this.narrowDetailsOpen && this.splitRosterWidth === undefined) {
				this.narrowDetailsOpen = false;
				this.tui.requestRender();
				return;
			}
			const now = Date.now();
			if (now - this.lastLeftTap < 500) this.close();
			else this.lastLeftTap = now;
			return;
		}
		this.hovered = null;
		if (data === "j" || matchesKey(data, Key.down)) this.move(1);
		else if (data === "k" || matchesKey(data, Key.up)) this.move(-1);
		else if (matchesKey(data, Key.home)) this.select(0);
		else if (data === "G" || matchesKey(data, Key.end)) this.select(this.rows.length - 1);
		else if (matchesKey(data, Key.enter) || data === "\r" || data === "\n") void this.activateSelected();
		else if (data === "o") void this.openSelected();
		else if (data === "a") void this.attachSelected();
		else if (data === "r") void this.restartSelected();
		else if (data === "x") void this.stopSelected();
	}

	render(width: number): string[] {
		this.refresh();
		const height = this.tui.terminal.rows;
		if (width < 24 || height < 8) return [];

		const split = this.splitWidth(width);
		const showingNarrowDetails = split === undefined && Boolean(this.narrowDetailsOpen && this.rows[this.selected]);
		const footer = this.footer(width - 4, showingNarrowDetails);
		const bodyRows = height - footer.length - 3;
		this.splitRosterWidth = split;
		this.hitRows = [];
		const lines: string[] = [];

		if (split !== undefined) {
			const detailWidth = width - split - 7;
			const roster = this.renderRoster(split, bodyRows);
			const details = this.renderDetails(detailWidth, bodyRows);
			lines.push(this.topBorder(width, "Agent Hub", split));
			for (let index = 0; index < bodyRows; index++) {
				const hit = roster.hits[index];
				if (hit !== undefined) this.hitRows[lines.length] = hit;
				lines.push(this.splitRow(roster.lines[index] ?? "", details[index] ?? "", width, split));
			}
			lines.push(this.divider(width, split));
		} else {
			const innerWidth = width - 4;
			lines.push(
				this.topBorder(width, showingNarrowDetails ? `Agent Hub · ${this.rows[this.selected].label}` : "Agent Hub"),
			);
			const panel = showingNarrowDetails
				? { lines: this.renderDetails(innerWidth, bodyRows), hits: [] }
				: this.renderRoster(innerWidth, bodyRows);
			for (let index = 0; index < bodyRows; index++) {
				const hit = panel.hits[index];
				if (hit !== undefined) this.hitRows[lines.length] = hit;
				lines.push(this.boxRow(panel.lines[index] ?? "", width));
			}
			lines.push(this.divider(width));
		}

		lines.push(...footer.map((line) => this.boxRow(line, width)), this.bottomBorder(width));
		return lines.slice(0, height);
	}

	invalidate(): void {}

	dispose(): void {
		this.close(false);
	}

	private refresh(): void {
		const selectedKey = this.rows[this.selected]?.key;
		const next = filterRuntimeHubEntries(entries(this.ctx, this.scope), this.filter);
		if (!this.rowOrder) {
			this.rowOrder = new Map(next.map((entry, index) => [entry.key, index]));
		} else {
			next.sort(
				(left, right) =>
					(this.rowOrder?.get(left.key) ?? Number.MAX_SAFE_INTEGER) -
					(this.rowOrder?.get(right.key) ?? Number.MAX_SAFE_INTEGER),
			);
			for (const entry of next) {
				if (!this.rowOrder.has(entry.key)) this.rowOrder.set(entry.key, this.rowOrder.size);
			}
		}
		if (this.viewMode === "tree") {
			const tree = projectRuntimeTree(next);
			this.rows = tree.rows;
			this.treeBranches = tree.branches;
		} else {
			this.rows = next;
			this.treeBranches.clear();
		}
		const kept = selectedKey ? this.rows.findIndex((entry) => entry.key === selectedKey) : -1;
		this.selected = kept >= 0 ? kept : Math.min(this.selected, Math.max(0, this.rows.length - 1));
	}

	private renderRoster(width: number, height: number): { lines: string[]; hits: Array<number | undefined> } {
		const lines = this.summaryLines(width);
		const hits: Array<number | undefined> = Array.from({ length: lines.length });
		if (height >= 8) {
			lines.push("");
			hits.push(undefined);
		}
		const budget = Math.max(0, height - lines.length - (this.notice ? 1 : 0));
		if (this.rows.length === 0) {
			const empty = [
				`${this.theme.fg("muted", "◌")} ${this.theme.bold("No managed work")}`,
				this.theme.fg("dim", "Agents, terminals, and jobs appear here."),
			];
			for (const line of empty.slice(0, budget)) {
				lines.push(line);
				hits.push(undefined);
			}
		} else if (budget > 0) {
			const window = this.renderRosterWindow(width, budget);
			lines.push(...window.lines);
			hits.push(...window.hits);
		}
		if (this.notice) {
			lines.push(this.theme.fg("error", sanitize(this.notice, width)));
			hits.push(undefined);
		}
		while (lines.length < height) {
			lines.push("");
			hits.push(undefined);
		}
		return { lines: lines.slice(0, height), hits: hits.slice(0, height) };
	}

	private renderRosterWindow(width: number, budget: number): { lines: string[]; hits: Array<number | undefined> } {
		const rendered = new Map<number, string[]>();
		const entryAt = (index: number) => {
			const cached = rendered.get(index);
			if (cached) return cached;
			const value = this.renderEntry(this.rows[index], index === this.selected, index === this.hovered, width);
			rendered.set(index, value);
			return value;
		};
		let start = this.selected;
		let end = this.selected + 1;
		let used = entryAt(this.selected).length;
		if (used > budget) {
			return {
				lines: entryAt(this.selected).slice(0, budget),
				hits: Array.from({ length: budget }, () => this.selected),
			};
		}
		for (let grew = true; grew; ) {
			grew = false;
			if (end < this.rows.length && used + entryAt(end).length <= budget) {
				used += entryAt(end).length;
				end++;
				grew = true;
			}
			if (start > 0 && used + entryAt(start - 1).length <= budget) {
				start--;
				used += entryAt(start).length;
				grew = true;
			}
		}
		while (used + Number(start > 0) + Number(end < this.rows.length) > budget && start < end) {
			if (end - 1 > this.selected) {
				end--;
				used -= entryAt(end).length;
			} else if (start < this.selected) {
				used -= entryAt(start).length;
				start++;
			} else break;
		}
		const lines: string[] = [];
		const hits: Array<number | undefined> = [];
		if (start > 0 && lines.length < budget) {
			lines.push(this.theme.fg("dim", `… ${start} more`));
			hits.push(undefined);
		}
		for (let index = start; index < end; index++) {
			for (const line of entryAt(index)) {
				lines.push(line);
				hits.push(index);
			}
		}
		if (end < this.rows.length && lines.length < budget) {
			lines.push(this.theme.fg("dim", `… ${this.rows.length - end} more`));
			hits.push(undefined);
		}
		return { lines, hits };
	}

	private renderEntry(entry: RuntimeHubEntry, selected: boolean, hovered: boolean, width: number): string[] {
		const branch = this.viewMode === "tree" ? (this.treeBranches.get(entry.key) ?? "") : "";
		const cursor = selected ? this.theme.fg("accent", "❯") : " ";
		const metadata = [
			this.theme.fg("dim", entry.kind),
			entry.parent ? this.theme.fg("dim", `of ${sanitize(entry.parent)}`) : undefined,
			this.theme.fg("dim", age(entry.lastActivity)),
		]
			.filter(Boolean)
			.join(" · ");
		const first = truncateToWidth(
			`${cursor} ${branch}${statusGlyph(entry.status, this.theme)} ${this.theme.bold(sanitize(entry.label))} · ${metadata}`,
			width,
			"",
		);
		const result = [first];
		if (entry.description) {
			const indent = Math.min(width - 1, 4 + visibleWidth(branch));
			const detailWidth = Math.max(1, width - indent);
			for (const line of wrapTextWithAnsi(this.theme.fg("muted", sanitize(entry.description)), detailWidth)) {
				result.push(`${" ".repeat(indent)}${line}`);
			}
		}
		if (!hovered) return result;
		const background = this.theme.getBgAnsi?.("selectedBg");
		return result.map((line) =>
			background ? paintAnsiBackgroundRow(line, width, background) : this.theme.bg("selectedBg", fit(line, width)),
		);
	}

	private renderDetails(width: number, height: number): string[] {
		const entry = this.rows[this.selected];
		if (!entry) return Array.from({ length: height }, () => "");
		const lines = [
			`${statusGlyph(entry.status, this.theme)} ${this.theme.bold(sanitize(entry.label))}`,
			this.theme.fg("dim", `${entry.status} · ${entry.kind} · ${age(entry.lastActivity)}`),
			"",
		];
		if (entry.parent) lines.push(`${this.theme.fg("muted", "Parent")}  ${sanitize(entry.parent)}`, "");
		lines.push(this.theme.bold("Work"));
		const description = entry.description?.trim() || "No description.";
		lines.push(
			...wrapTextWithAnsi(
				this.theme.fg(entry.description ? "text" : "dim", sanitize(description)),
				Math.max(1, width),
			),
		);
		lines.push("", this.theme.bold("Actions"));
		if (entry.kind === "session" && entry.status === "current") lines.push("Current session");
		else lines.push(`Enter  ${entry.attach ? "attach" : "open"}`);
		if (entry.attach) lines.push("a      attach", this.theme.fg("dim", "Ctrl+] detach"));
		if (entry.restart) lines.push("r      restart");
		if (entry.stop) lines.push("x      stop");
		const maxOffset = Math.max(0, lines.length - height);
		this.detailOffset = Math.min(this.detailOffset, maxOffset);
		const visible = lines.slice(this.detailOffset, this.detailOffset + height);
		while (visible.length < height) visible.push("");
		return visible.map((line) => truncateToWidth(line, width, ""));
	}

	private summaryLines(width: number): string[] {
		const active = (label: string) =>
			this.theme.bg("selectedBg", this.theme.bold(this.theme.fg("accent", ` ${label} `)));
		const inactive = (label: string) => this.theme.fg("muted", ` ${label} `);
		const globalLabel = " Global ";
		const projectLabel = " Project ";
		const sessionLabel = " Session ";
		const globalStart = 2 + visibleWidth("Scope (g) · ");
		this.globalScopeHit = [globalStart, globalStart + visibleWidth(globalLabel)];
		const projectStart = this.globalScopeHit[1] + 1;
		this.projectScopeHit = [projectStart, projectStart + visibleWidth(projectLabel)];
		const sessionStart = this.projectScopeHit[1] + 1;
		this.currentScopeHit = [sessionStart, sessionStart + visibleWidth(sessionLabel)];
		const scope = [
			this.scope === "global" ? active("Global") : inactive("Global"),
			this.scope === "project" ? active("Project") : inactive("Project"),
			this.scope === "current" ? active("Session") : inactive("Session"),
		].join(this.theme.fg("dim", "/"));
		const flatLabel = " Flat ";
		const treeLabel = " By parent ";
		const flatStart = 2 + visibleWidth("View (t) · ");
		this.flatHit = [flatStart, flatStart + visibleWidth(flatLabel)];
		const treeStart = this.flatHit[1] + 1;
		this.treeHit = [treeStart, treeStart + visibleWidth(treeLabel)];
		const projection =
			this.viewMode === "roster"
				? `${active("Flat")}${this.theme.fg("dim", "/")}${inactive("By parent")}`
				: `${inactive("Flat")}${this.theme.fg("dim", "/")}${active("By parent")}`;
		const filterLabels = [" All ", " Agents ", " Subagents ", " TTYs "] as const;
		const filterHits = [
			(value: [number, number]) => (this.allFilterHit = value),
			(value: [number, number]) => (this.agentsFilterHit = value),
			(value: [number, number]) => (this.subagentsFilterHit = value),
			(value: [number, number]) => (this.ttysFilterHit = value),
		];
		let filterStart = 2 + visibleWidth("Filter (f) · ");
		const filterLine = filterLabels
			.map((label, index) => {
				filterHits[index]([filterStart, filterStart + visibleWidth(label)]);
				filterStart += visibleWidth(label) + 1;
				const value = ["all", "agents", "subagents", "ttys"][index];
				return this.filter === value ? active(label.trim()) : inactive(label.trim());
			})
			.join(this.theme.fg("dim", "/"));
		const counts = this.summary();
		const lines = [
			...wrapTextWithAnsi(`${this.theme.bold("Scope (g)")} · ${scope}`, width),
			...wrapTextWithAnsi(`${this.theme.bold("View (t)")} · ${projection}`, width),
			...wrapTextWithAnsi(
				`${this.theme.bold("Filter (f)")} · ${filterLine}${counts ? ` · ${this.theme.fg("dim", counts)}` : ""}`,
				width,
			),
		];
		const attachable = this.rows.filter((entry) => entry.attach).length;
		lines.push(this.theme.fg("dim", `Managed · ${this.rows.length} total · ${attachable} attachable`));
		return lines;
	}

	private footer(width: number, showingDetails: boolean): string[] {
		const entry = this.rows[this.selected];
		const primary = entry?.attach ? "attach" : "open";
		const lines = showingDetails
			? [`PgUp/PgDn/wheel:scroll  Enter:${primary}  o:open`, "Tab/Esc:roster  g:scope  t:view  f:filter"]
			: width < 92
				? [
						`j/k/wheel:select  Enter:${primary}  o/click:open${entry?.attach ? "  a:attach" : ""}`,
						"g:scope  t:view  f:filter  Tab:details  Esc:close",
					]
				: [`j/k/wheel:select  Enter:${primary}  o/click:open  g:scope  t:view  f:filter  Esc:close`];
		return lines.map((line) => this.theme.fg("dim", truncateToWidth(line, width, "")));
	}

	private handleMouse(data: string): boolean {
		const match = data.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
		if (!match) return false;
		const button = Number(match[1]);
		const column = Number(match[2]) - 1;
		const row = Number(match[3]) - 1;
		if (button === 64 || button === 65) {
			if (this.narrowDetailsOpen || (this.splitRosterWidth !== undefined && column > this.splitRosterWidth + 2)) {
				this.scrollDetails(button === 64 ? -1 : 1);
			} else {
				this.move(button === 64 ? -1 : 1);
			}
			return true;
		}
		if (button === 0 && row === 1) {
			const nextScope = inRange(column, this.globalScopeHit)
				? "global"
				: inRange(column, this.projectScopeHit)
					? "project"
					: inRange(column, this.currentScopeHit)
						? "current"
						: undefined;
			if (nextScope) this.setScope(nextScope);
			return true;
		}
		if (button === 0 && row === 2) {
			const nextMode = inRange(column, this.flatHit) ? "roster" : inRange(column, this.treeHit) ? "tree" : undefined;
			if (nextMode) this.setViewMode(nextMode);
			return true;
		}
		if (button === 0 && row === 3) {
			const nextFilter = inRange(column, this.allFilterHit)
				? "all"
				: inRange(column, this.agentsFilterHit)
					? "agents"
					: inRange(column, this.subagentsFilterHit)
						? "subagents"
						: inRange(column, this.ttysFilterHit)
							? "ttys"
							: undefined;
			if (nextFilter) this.setFilter(nextFilter);
			return true;
		}
		const index = this.hitRows[row];
		if (button === 35) {
			if (this.hovered !== (index ?? null)) {
				this.hovered = index ?? null;
				this.tui.requestRender();
			}
			return true;
		}
		if (button === 0 && index !== undefined) {
			this.hovered = index;
			this.select(index);
			if (match[4] === "m") void this.openSelected();
			return true;
		}
		return true;
	}

	private setScope(scope: RuntimeHubScope): void {
		if (scope === this.scope) return;
		this.scope = scope;
		this.rowOrder = undefined;
		this.hovered = null;
		this.selected = 0;
		this.refresh();
		this.tui.requestRender();
		void refreshSources(this.ctx, scope).then((notice) => {
			this.notice = notice;
			this.refresh();
			this.tui.requestRender();
		});
	}

	private setFilter(filter: RuntimeHubFilter): void {
		if (filter === this.filter) return;
		this.filter = filter;
		this.rowOrder = undefined;
		this.hovered = null;
		this.selected = 0;
		this.refresh();
		this.tui.requestRender();
	}

	private setViewMode(mode: "roster" | "tree"): void {
		if (mode === this.viewMode) return;
		this.hovered = null;
		this.viewMode = mode;
		this.refresh();
		this.tui.requestRender();
	}

	private summary(): string {
		const counts = new Map<string, number>();
		for (const entry of this.rows) counts.set(entry.status, (counts.get(entry.status) ?? 0) + 1);
		return [...counts].map(([status, count]) => `${count} ${status}`).join(" · ");
	}

	private move(delta: number): void {
		this.select(this.selected + delta);
	}

	private select(index: number): void {
		const next = Math.max(0, Math.min(index, Math.max(0, this.rows.length - 1)));
		if (next !== this.selected) this.detailOffset = 0;
		this.selected = next;
		this.notice = undefined;
		this.tui.requestRender();
	}

	private scrollDetails(direction: -1 | 1): void {
		this.detailOffset = Math.max(0, this.detailOffset + direction * 5);
		this.tui.requestRender();
	}

	private splitWidth(width: number): number | undefined {
		if (width < 96) return undefined;
		const roster = Math.max(48, Math.min(Math.floor(width * 0.58), width - 34 - 7));
		return width - roster - 7 >= 34 ? roster : undefined;
	}

	private topBorder(width: number, title: string, split?: number): string {
		const shown = truncateToWidth(` ${title} `, Math.max(0, (split ?? width - 2) - 2), "");
		const leftWidth = split === undefined ? width - 2 : split + 2;
		const leftFill = Math.max(0, leftWidth - visibleWidth(shown) - 2);
		const right = split === undefined ? "" : `┬${"─".repeat(Math.max(0, width - leftWidth - 2))}`;
		return (
			this.theme.fg("border", "╭─") +
			this.theme.bold(this.theme.fg("accent", shown)) +
			this.theme.fg("border", `${"─".repeat(leftFill)}${right}╮`)
		);
	}

	private divider(width: number, split?: number): string {
		if (split === undefined) return this.theme.fg("border", `├${"─".repeat(width - 2)}┤`);
		return this.theme.fg("border", `├${"─".repeat(split + 1)}┴${"─".repeat(width - split - 4)}┤`);
	}

	private bottomBorder(width: number): string {
		return this.theme.fg("border", `╰${"─".repeat(width - 2)}╯`);
	}

	private boxRow(content: string, width: number): string {
		return `${this.theme.fg("border", "│")} ${fit(content, width - 4)} ${this.theme.fg("border", "│")}`;
	}

	private splitRow(left: string, right: string, width: number, split: number): string {
		const bar = this.theme.fg("border", "│");
		return `${bar} ${fit(left, split)} ${bar} ${fit(right, width - split - 7)} ${bar}`;
	}

	private async activateSelected(): Promise<void> {
		const entry = this.rows[this.selected];
		if (entry?.attach) await this.attachSelected();
		else await this.openSelected();
	}

	private async openSelected(): Promise<void> {
		const entry = this.rows[this.selected];
		if (!entry) return;
		this.notice = undefined;
		if (entry.kind === "session" && entry.status !== "current") this.close();
		try {
			await entry.open(this.tui as Pick<TUI, "requestRender" | "start" | "stop" | "terminal">);
		} catch (error) {
			this.notice = error instanceof Error ? error.message : String(error);
		}
		if (!this.closed) this.tui.requestRender();
	}

	private async attachSelected(): Promise<void> {
		const entry = this.rows[this.selected];
		if (!entry?.attach) {
			this.notice =
				entry?.kind === "job"
					? "This process is not a TTY. Launch it with exec_command tty:true to attach."
					: "This item has no terminal attachment.";
			this.tui.requestRender();
			return;
		}
		try {
			const attached = await entry.attach(this.tui as Pick<TUI, "requestRender" | "start" | "stop" | "terminal">);
			this.notice = attached ? undefined : "Terminal attachment failed.";
		} catch (error) {
			this.notice = error instanceof Error ? error.message : String(error);
		}
		this.tui.requestRender();
	}

	private async restartSelected(): Promise<void> {
		const entry = this.rows[this.selected];
		if (!entry?.restart) {
			this.notice = "This item cannot be restarted.";
			this.tui.requestRender();
			return;
		}
		try {
			await entry.restart();
			this.notice = undefined;
		} catch (error) {
			this.notice = error instanceof Error ? error.message : String(error);
		}
		this.refresh();
		this.tui.requestRender();
	}

	private async stopSelected(): Promise<void> {
		const entry = this.rows[this.selected];
		if (!entry?.stop) return;
		await entry.stop();
		this.refresh();
		this.tui.requestRender();
	}

	private close(callDone = true): void {
		if (this.closed) return;
		this.closed = true;
		clearInterval(this.timer);
		if (callDone) this.done();
	}
}

function fit(text: string, width: number): string {
	const clipped = truncateToWidth(text, Math.max(0, width), "");
	return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

export function projectRuntimeTree(rows: RuntimeHubEntry[]): {
	rows: RuntimeHubEntry[];
	branches: Map<string, string>;
} {
	const byKey = new Map(rows.map((entry) => [entry.key, entry]));
	const byLabel = new Map(rows.map((entry) => [entry.label, entry]));
	const children = new Map<string, RuntimeHubEntry[]>();
	const roots: RuntimeHubEntry[] = [];
	for (const entry of rows) {
		const parent = (entry.parentKey && byKey.get(entry.parentKey)) || (entry.parent && byLabel.get(entry.parent));
		if (!parent || parent === entry) roots.push(entry);
		else children.set(parent.key, [...(children.get(parent.key) ?? []), entry]);
	}
	const projected: RuntimeHubEntry[] = [];
	const branches = new Map<string, string>();
	const seen = new Set<string>();
	const visit = (entry: RuntimeHubEntry, prefix: string, last: boolean, root: boolean) => {
		if (seen.has(entry.key)) return;
		seen.add(entry.key);
		projected.push(entry);
		branches.set(entry.key, root ? "" : `${prefix}${last ? "└── " : "├── "}`);
		const descendants = children.get(entry.key) ?? [];
		const childPrefix = root ? "" : `${prefix}${last ? "    " : "│   "}`;
		for (const [index, child] of descendants.entries()) {
			visit(child, childPrefix, index === descendants.length - 1, false);
		}
	};
	for (const [index, root] of roots.entries()) visit(root, "", index === roots.length - 1, true);
	for (const entry of rows) visit(entry, "", true, true);
	return { rows: projected, branches };
}

function inRange(value: number, range: [number, number] | undefined): boolean {
	return Boolean(range && value >= range[0] && value < range[1]);
}

function sanitize(text: string, width = Number.MAX_SAFE_INTEGER): string {
	return truncateToWidth(text.replace(/\t/g, "    ").replace(/[\r\n]+/g, " "), width);
}

function statusGlyph(status: string, theme: { fg(color: string, text: string): string }): string {
	const glyph =
		status === "running" || status === "live"
			? "⟳"
			: status === "queued"
				? "⏳"
				: status === "completed" || status === "idle" || status === "current"
					? "●"
					: status === "saved"
						? "◌"
						: status === "error" || status === "aborted" || status === "stopped"
							? "⏹"
							: status === "interrupted" || status === "parked"
								? "◌"
								: "•";
	return theme.fg(statusColor(status), glyph);
}

function statusOrder(status: string): number {
	if (status === "running" || status === "queued" || status === "live" || status === "current") return 0;
	if (status === "completed" || status === "idle") return 1;
	if (status === "saved" || status === "interrupted" || status === "parked") return 2;
	return 3;
}

function statusColor(status: string): string {
	if (status === "running" || status === "queued" || status === "live" || status === "current") return "accent";
	if (status === "completed" || status === "idle") return "success";
	if (status === "error" || status === "aborted" || status === "stopped") return "error";
	return "muted";
}

function age(timestamp: number): string {
	const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}
