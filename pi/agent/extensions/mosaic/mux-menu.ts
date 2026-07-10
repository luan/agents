import { DynamicBorder, rawKeyHint, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import { Container, Spacer, visibleWidth } from "@earendil-works/pi-tui";
import { truncateToWidthCompat } from "../shared/tui";
import { killTarget } from "./multiplexer.js";
import * as heartbeat from "./mux-heartbeat.js";

type Scope = "cwd" | "all";
type Mode = "list" | "confirm-kill" | "confirm-kill-all";

interface TreeRow {
	hb: heartbeat.Heartbeat;
	depth: number;
	isLast: boolean;
	ancestorContinues: boolean[];
}

export interface MuxMenuOptions {
	tui: TUI;
	theme: Theme;
	currentPaneId: string;
	currentCwd: string;
	done: (result: undefined) => void;
}

export class MuxMenu extends Container implements Focusable {
	focused = true;
	private scope: Scope = "cwd";
	private mode: Mode = "list";
	private selectedIndex = 0;
	private rows: TreeRow[] = [];
	private pendingConfirmMessage = "";
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly currentPaneId: string;
	private readonly currentCwd: string;
	private readonly done: (result: undefined) => void;
	private refreshTimer?: ReturnType<typeof setInterval>;
	private readonly list: MuxList;

	constructor(opts: MuxMenuOptions) {
		super();
		this.tui = opts.tui;
		this.theme = opts.theme;
		this.currentPaneId = opts.currentPaneId;
		this.currentCwd = opts.currentCwd;
		this.done = opts.done;
		this.list = new MuxList(this);
		this.buildLayout();
		this.refresh();
		this.refreshTimer = setInterval(() => {
			this.refresh();
			this.tui.requestRender();
		}, 500);
		if (typeof this.refreshTimer.unref === "function") this.refreshTimer.unref();
	}

	private buildLayout(): void {
		this.clear();
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((s) => this.theme.fg("accent", s)));
		this.addChild(new Spacer(1));
		this.addChild(this.list);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((s) => this.theme.fg("accent", s)));
	}

	dispose(): void {
		if (this.refreshTimer) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = undefined;
		}
	}

	private refresh(): void {
		const all = heartbeat.listActive();
		const inScope = this.scope === "all" ? all : all.filter((e) => e.cwd === this.currentCwd);
		this.rows = buildHeartbeatTree(inScope);
		if (this.selectedIndex >= this.rows.length) {
			this.selectedIndex = Math.max(0, this.rows.length - 1);
		}
	}

	getRows(): TreeRow[] {
		return this.rows;
	}
	getSelectedIndex(): number {
		return this.selectedIndex;
	}
	getMode(): Mode {
		return this.mode;
	}
	getPendingConfirmMessage(): string {
		return this.pendingConfirmMessage;
	}
	getScope(): Scope {
		return this.scope;
	}
	getCurrentPaneId(): string {
		return this.currentPaneId;
	}
	getTheme(): Theme {
		return this.theme;
	}

	private killTargets(): heartbeat.Heartbeat[] {
		return this.rows.map((r) => r.hb).filter((hb) => hb.paneId !== this.currentPaneId);
	}

	private selectedRow(): heartbeat.Heartbeat | undefined {
		return this.rows[this.selectedIndex]?.hb;
	}

	handleInput(data: string): void {
		if (this.mode !== "list") {
			this.handleConfirmInput(data);
			return;
		}
		if (data === "\r" || data === "\n" || data === "\u001b" || data === "q") {
			this.done(undefined);
			return;
		}
		if (data === "\t") {
			this.scope = this.scope === "cwd" ? "all" : "cwd";
			this.selectedIndex = 0;
			this.refresh();
			this.tui.requestRender();
			return;
		}
		if (data === "\u001b[A" || data === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.tui.requestRender();
			return;
		}
		if (data === "\u001b[B" || data === "j") {
			const max = this.rows.length - 1;
			this.selectedIndex = Math.min(max, this.selectedIndex + 1);
			this.tui.requestRender();
			return;
		}
		if (data === "d") {
			const row = this.selectedRow();
			if (!row) return;
			if (row.paneId === this.currentPaneId) return;
			const name = row.label?.trim() || "(empty session)";
			const snippet = name.length > 40 ? `${name.slice(0, 37)}…` : name;
			this.pendingConfirmMessage = `Kill "${snippet}"? [y/N]`;
			this.mode = "confirm-kill";
			this.tui.requestRender();
			return;
		}
		if (data === "D") {
			const targets = this.killTargets();
			if (targets.length === 0) return;
			const scopeLabel = this.scope === "cwd" ? "in this folder" : "across all folders";
			this.pendingConfirmMessage = `Kill ${targets.length} backgrounded ${scopeLabel}? [y/N]`;
			this.mode = "confirm-kill-all";
			this.tui.requestRender();
			return;
		}
	}

	private handleConfirmInput(data: string): void {
		const confirmed = data === "y" || data === "Y";
		if (confirmed && this.mode === "confirm-kill") {
			const row = this.selectedRow();
			if (row && row.paneId !== this.currentPaneId) {
				this.killPane(row);
			}
			this.refresh();
			this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.rows.length - 1));
			this.mode = "list";
			this.tui.requestRender();
			return;
		}
		if (confirmed && this.mode === "confirm-kill-all") {
			for (const row of this.killTargets()) {
				this.killPane(row);
			}
			this.refresh();
			this.mode = "list";
			this.selectedIndex = 0;
			if (this.rows.length === 0) {
				this.done(undefined);
				return;
			}
			this.tui.requestRender();
			return;
		}
		this.mode = "list";
		this.tui.requestRender();
	}

	private killPane(row: heartbeat.Heartbeat): void {
		try {
			killTarget(row);
		} catch {}
	}
}

class MuxList implements Component {
	constructor(private readonly parent: MuxMenu) {}

	invalidate(): void {}

	render(width: number): string[] {
		const theme = this.parent.getTheme();
		const rows = this.parent.getRows();
		const currentPaneId = this.parent.getCurrentPaneId();
		const selectedIndex = this.parent.getSelectedIndex();
		const mode = this.parent.getMode();

		const scope = this.parent.getScope();
		const title = theme.bold("mosaic");
		const scopeText =
			scope === "cwd"
				? `${theme.fg("accent", "◉ Current Folder")}${theme.fg("muted", " | ○ All")}`
				: `${theme.fg("muted", "○ Current Folder | ")}${theme.fg("accent", "◉ All")}`;
		const spacingN = Math.max(1, width - visibleWidth(title) - visibleWidth(scopeText));
		const header = title + " ".repeat(spacingN) + scopeText;

		const lines: string[] = [];
		lines.push(truncateToWidthCompat(header, width, ""));

		if (mode !== "list") {
			lines.push(truncateToWidthCompat(theme.fg("error", this.parent.getPendingConfirmMessage()), width, "…"));
		} else {
			const sep = theme.fg("muted", " · ");
			const hints = [
				rawKeyHint("d", "kill"),
				rawKeyHint("D", "kill all"),
				rawKeyHint("tab", "scope"),
				rawKeyHint("q", "close"),
			].join(sep);
			lines.push(truncateToWidthCompat(hints, width, "…"));
		}
		lines.push("");

		if (rows.length === 0) {
			lines.push(theme.fg("muted", "  (no pi sessions tracked)"));
		} else {
			for (let i = 0; i < rows.length; i++) {
				const node = rows[i]!;
				const row = node.hb;
				const isCurrent = row.paneId === currentPaneId;
				const isSelected = i === selectedIndex;

				const cursor = isSelected ? theme.fg("accent", "› ") : "  ";
				const prefixPlain = buildTreePrefix(node);
				const prefixStyled = theme.fg("dim", prefixPlain);

				const rawName = row.label?.trim() || "(empty session)";
				const normalizedName = rawName.replace(/[\x00-\x1f\x7f]/g, " ").trim();

				const tagParts: string[] = [];
				if (isCurrent) tagParts.push("current");
				else if (row.windowId) tagParts.push("window");
				else tagParts.push("open");
				if (row.busy && !isCurrent) tagParts.push("busy");
				const tagPlain = `[${tagParts.join(" · ")}]`;
				const tagStyled = theme.fg("dim", tagPlain);

				const cwdShort = row.cwd.replace(process.env.HOME ?? "", "~");

				const cursorWidth = visibleWidth(cursor);
				const prefixWidth = visibleWidth(prefixPlain);
				const tagWidth = visibleWidth(tagPlain);
				const cwdWidth = visibleWidth(cwdShort);
				const minGap = 6;
				const availableForName = Math.max(5, width - cursorWidth - prefixWidth - 1 - tagWidth - minGap - cwdWidth);
				const truncatedName = truncateToWidthCompat(normalizedName, availableForName, "…");
				const styledName = isCurrent ? theme.fg("accent", truncatedName) : truncatedName;
				const boldedName = isSelected ? theme.bold(styledName) : styledName;

				const leftPart = `${cursor}${prefixStyled}${boldedName} ${tagStyled}`;
				const leftWidth = visibleWidth(leftPart);
				const spacing = Math.max(minGap, width - leftWidth - cwdWidth);
				let line = leftPart + " ".repeat(spacing) + theme.fg("dim", cwdShort);
				if (isSelected) line = theme.bg("selectedBg", line);
				lines.push(truncateToWidthCompat(line, width, ""));
			}
		}

		return lines;
	}
}

interface TreeNode {
	hb: heartbeat.Heartbeat;
	children: TreeNode[];
}

function buildHeartbeatTree(hbs: heartbeat.Heartbeat[]): TreeRow[] {
	const byPath = new Map<string, TreeNode>();
	for (const hb of hbs) {
		byPath.set(hb.sessionFile, { hb, children: [] });
	}
	const roots: TreeNode[] = [];
	for (const hb of hbs) {
		const node = byPath.get(hb.sessionFile)!;
		const parent = hb.parentSessionFile ? byPath.get(hb.parentSessionFile) : undefined;
		if (parent) parent.children.push(node);
		else roots.push(node);
	}

	const sortNodes = (nodes: TreeNode[]) => {
		nodes.sort((a, b) => a.hb.paneId.localeCompare(b.hb.paneId));
		for (const node of nodes) sortNodes(node.children);
	};
	sortNodes(roots);

	const result: TreeRow[] = [];
	const walk = (node: TreeNode, depth: number, ancestorContinues: boolean[], isLast: boolean) => {
		result.push({ hb: node.hb, depth, isLast, ancestorContinues });
		for (let i = 0; i < node.children.length; i++) {
			const childIsLast = i === node.children.length - 1;
			const continues = depth > 0 ? !isLast : false;
			walk(node.children[i]!, depth + 1, [...ancestorContinues, continues], childIsLast);
		}
	};
	for (let i = 0; i < roots.length; i++) {
		walk(roots[i]!, 0, [], i === roots.length - 1);
	}
	return result;
}

function buildTreePrefix(node: TreeRow): string {
	if (node.depth === 0) return "";
	const parts = node.ancestorContinues.map((c) => (c ? "│  " : "   "));
	const branch = node.isLast ? "└─ " : "├─ ";
	return parts.join("") + branch;
}
