import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import {
	ComponentStack,
	DialogOverlay,
	SelectableList,
	SemanticInput,
	sanitizeTuiText,
	tuiTheme,
	type DialogHost,
} from "@luan.sh/pi-libtui";
import type { TokenBurdenReport } from "../core/report.ts";
import { nextTab, type ReportTab } from "../core/report-navigation.ts";
import type { ToolControlService } from "../runtime/tool-controls.ts";
import { createReportDialog } from "./report-dialog.ts";
import { reportRows, type ReportRow } from "./report-rows.ts";
import { reportSummary } from "./burden-bar.ts";

export interface ScreenHost {
	theme: Theme;
	keybindings: Pick<KeybindingsManager, "matches" | "getKeys">;
	dialogs: DialogHost;
	requestRender(): void;
	height(): number;
	close(): void;
	toolControls?: ToolControlService;
}

const singleLine = (text: string): string => sanitizeTuiText(text).replace(/[\r\n]+/g, " ");
const DOT_HUES = ["magenta", "red", "yellow", "yellow", "green", "cyan", "blue"] as const;

/** The old compact overlay; shared components retain input and pointer ownership. */
export class ReportScreen extends DialogOverlay {
	private tab: ReportTab = "Overview";
	private readonly list: SelectableList<ReportRow>;
	private readonly body: ComponentStack;
	private readonly search: SemanticInput;
	private readonly header: Component;
	private readonly footer: Component;
	private readonly tail: Component;
	private readonly empty: Component;
	private headerLines: string[] = [];
	private footerLines: string[] = [];
	private tailLines: string[] = [];
	private searching = false;
	private bodyHeight = 1;
	private visibleRows = 8;
	private modalClose: (() => void) | undefined;
	private controlMessage = "";
	private changingTool = false;
	private overviewIndex = 0;

	constructor(
		private readonly report: TokenBurdenReport,
		private readonly host: ScreenHost,
	) {
		const body = new ComponentStack([], { height: () => this.bodyHeight, anchorLastChild: true });
		super(host.theme, body, "Token Burden");
		this.body = body;
		// Stable children preserve shared pointer capture across selection redraws.
		const label = (get: () => string[]): Component => ({ render: () => get(), invalidate() {} });
		this.header = label(() => this.headerLines);
		this.footer = label(() => this.footerLines);
		this.tail = label(() => this.tailLines);
		this.empty = label(() => [` No ${this.tab.toLowerCase()} reported.`]);
		this.search = new SemanticInput(host.theme);
		this.search.onFocus = () => {
			this.search.focused = true;
			host.requestRender();
		};
		this.list = new SelectableList({
			items: this.rows(),
			wrap: true,
			requestRender: host.requestRender,
			renderItem: (row, context) => {
				const colors = tuiTheme(host.theme);
				const prefix = colors.fg(context.selected ? "accent" : "text.muted", context.selected ? "▸" : "·");
				const value = singleLine(row.value ?? "");
				const share =
					row.share && context.width >= 36 && row.share.total > 0
						? `   ${((row.share.value / row.share.total) * 100).toFixed(1)}%`
						: "";
				const suffix = `${value}${share}`;
				const available = Math.max(0, context.width - visibleWidth(suffix) - 6);
				const name = truncateToWidth(singleLine(row.label), available);
				const label = context.selected ? colors.fg("accent", host.theme.bold(name)) : name;
				const gap = Math.max(1, context.width - visibleWidth(name) - visibleWidth(suffix) - 5);
				return ` ${prefix} ${label}${" ".repeat(gap)}${colors.fg("text.secondary", suffix)}  `;
			},
			onActivate: (row) => (row.view ? this.show(row.view) : this.open(row)),
		});
	}

	private rows(): ReportRow[] {
		const rows = reportRows(this.report, this.tab);
		return this.searching && this.search.getValue()
			? fuzzyFilter(rows, this.search.getValue(), (row) => row.label)
			: rows;
	}

	private show(tab: ReportTab): void {
		if (this.tab === "Overview" && tab !== "Overview") {
			const selected = this.list.getSelectedItem();
			this.overviewIndex = Math.max(
				0,
				reportRows(this.report, "Overview").findIndex((row) => row.label === selected?.label),
			);
		}
		this.tab = tab;
		this.searching = false;
		this.search.focused = false;
		this.search.setValue("");
		this.list.setItems(this.rows(), tab === "Overview" ? this.overviewIndex : 0);
		this.host.requestRender();
	}

	private footerText(): string {
		const key = (id: Parameters<KeybindingsManager["getKeys"]>[0]) =>
			(this.host.keybindings.getKeys(id)[0] ?? "")
				.replace(/^up$/, "↑")
				.replace(/^down$/, "↓")
				.replace(/^escape$/, "esc");
		return `${key("tui.select.up")}/${key("tui.select.down")}/jk navigate  ${key("tui.select.confirm")}${this.tab === "Overview" ? "/l drill-in" : " view"}${this.tab === "Tools" ? "  space toggle" : ""}${this.tab === "Overview" ? "  u turns" : ""}  / search  ${key("tui.select.cancel")}/${this.tab === "Overview" ? "q close" : "h/q back"}`;
	}

	private open(row: ReportRow): void {
		this.dispose();
		const dialog = createReportDialog({
			title: singleLine(row.label),
			content: row.detail,
			theme: this.host.theme,
			keybindings: this.host.keybindings,
			requestRender: this.host.requestRender,
			onClose: () => {
				this.dispose();
				this.host.requestRender();
			},
			height: () => Math.max(1, this.host.height() - 2),
		});
		this.modalClose = this.host.dialogs.open(dialog, { title: singleLine(row.label), width: 80, maxHeight: "90%" });
	}

	override handleInput(data: string): void {
		const kb = this.host.keybindings;
		const cancel = kb.matches(data, "tui.select.cancel") || matchesKey(data, "escape") || matchesKey(data, "ctrl+c");
		if (this.searching && this.search.focused) {
			if (cancel) {
				this.searching = false;
				this.search.focused = false;
				this.search.setValue("");
				this.list.setItems(this.rows(), 0);
			} else if (kb.matches(data, "tui.select.confirm")) this.search.focused = false;
			else {
				this.search.handleInput(data);
				this.list.setItems(this.rows(), 0);
			}
			this.host.requestRender();
			return;
		}
		if (cancel || data === "q" || (data === "h" && this.tab !== "Overview")) {
			if (this.modalClose) this.dispose();
			else if (this.tab !== "Overview") this.show("Overview");
			else {
				this.dispose();
				this.host.close();
			}
			this.host.requestRender();
			return;
		}
		if (data === "?") {
			this.open({
				label: "Token burden help",
				detail: `${this.footerText()}\n\nEnter drills into prompt sections, tools, or skills. Escape returns to the overview. Left/right switch report views; u opens recorded usage. Space on Tools changes active tools for future turns only.\n\n~ marks character-based estimates, not provider tokenization. Context files overlap the prompt; skill wrapper estimates are not additive. Recorded usage is cumulative work, not current context or independently verified billing. Arbitrary prompt changes, provider rewrites, hidden tool reach, and unreported nested work cannot be attributed via public APIs. Reopen to refresh the snapshot.\n\nCommands (excluding Pi built-ins):\n${this.report.commands.map((command) => `/${command.name} · ${command.source}\n${command.path}`).join("\n\n") || "No commands reported."}`,
			});
			return;
		}
		if (data === "/") {
			this.searching = true;
			this.search.focused = true;
			this.host.requestRender();
			return;
		}
		if (data === "u") {
			this.show("Usage");
			return;
		}
		if (matchesKey(data, "left") || matchesKey(data, "right")) {
			this.show(nextTab(this.tab, matchesKey(data, "left") ? -1 : 1));
			return;
		}
		if (data === " " && this.tab === "Tools") {
			void this.toggleSelectedTool();
			return;
		}
		const delta =
			kb.matches(data, "tui.select.down") || data === "j"
				? 1
				: kb.matches(data, "tui.select.up") || data === "k"
					? -1
					: kb.matches(data, "tui.select.pageDown")
						? this.visibleRows
						: kb.matches(data, "tui.select.pageUp")
							? -this.visibleRows
							: 0;
		if (delta) {
			const count = this.rows().length;
			if (count) this.list.setSelectedIndex((this.list.getSelectedIndex() + delta + count) % count);
		}
		if (matchesKey(data, "home")) this.list.setSelectedIndex(0);
		if (matchesKey(data, "end")) this.list.setSelectedIndex(this.rows().length - 1);
		if (kb.matches(data, "tui.select.confirm") || data === "l" || data === "e") {
			const row = this.list.getSelectedItem();
			if (row) {
				if (row.view && data !== "e") this.show(row.view);
				else this.open(row);
			}
		}
		this.host.requestRender();
	}

	private async toggleSelectedTool(): Promise<void> {
		if (this.changingTool) return;
		const tool = this.report.tools.find((candidate) => candidate.name === this.list.getSelectedItem()?.toolName);
		if (!tool) return;
		if (!this.host.toolControls) {
			this.controlMessage = "Tool changes unavailable (read-only host)";
			this.host.requestRender();
			return;
		}
		this.controlMessage = `${tool.name}: waiting for idle…`;
		this.changingTool = true;
		this.host.requestRender();
		const result = await this.host.toolControls.toggle(tool.name, !tool.active);
		this.controlMessage = result.message;
		this.changingTool = false;
		if (result.applied) {
			for (const item of this.report.tools) item.active = result.active.includes(item.name);
			if (this.tab === "Tools") this.list.setItems(this.rows());
		}
		this.host.requestRender();
	}

	override render(width: number): string[] {
		width = Math.max(0, Math.min(80, Math.floor(width)));
		const height = Math.max(0, Math.floor(this.host.height()));
		const inner = Math.max(0, width - 2);
		const colors = tuiTheme(this.host.theme);
		const header = reportSummary(this.report, this.host.theme, inner, height);
		if (this.tab !== "Overview" && height >= 12) {
			header.push(` ${this.host.theme.bold(this.tab)}  ${colors.fg("text.muted", "← esc to go back")}`, "");
		}
		if (this.controlMessage && this.tab === "Tools")
			header.push(` ${colors.fg("text.secondary", singleLine(this.controlMessage))}`);
		const footer =
			height >= 12
				? ["─".repeat(inner), "", ` ${colors.fg("text.muted", this.footerText())}`]
				: [colors.fg("text.muted", "↑↓ select  enter view  esc back")];
		const searchRows = this.searching ? 1 : 0;
		this.visibleRows = Math.max(1, Math.min(8, height - 2 - header.length - footer.length - searchRows - 2));
		this.list.setMaxVisible(this.visibleRows);
		const rows = this.rows();
		const content = rows.length ? this.list : this.empty;
		const tail =
			rows.length > this.visibleRows && height >= 12
				? [
						"",
						` ${Array.from({ length: 10 }, (_, i) => colors.fg({ hue: DOT_HUES[i % DOT_HUES.length] ?? "blue", shade: 3 }, i < Math.round(((this.list.getSelectedIndex() + 1) / rows.length) * 10) ? "●" : "○")).join(" ")}  ${colors.fg("text.muted", `${this.list.getSelectedIndex() + 1}/${rows.length}`)}`,
					]
				: [""];
		this.headerLines = header;
		this.tailLines = tail;
		this.footerLines = footer;
		const children = [this.header, ...(this.searching ? [this.search] : []), content, this.tail, this.footer];
		this.bodyHeight = Math.max(
			0,
			Math.min(
				height - 2,
				children.reduce((sum, child) => sum + child.render(inner).length, 0),
			),
		);
		this.body.setChildren(children);
		const lines = super.render(width).slice(0, height);
		if (width >= 4 && lines.length) {
			const title = truncateToWidth(" Token Burden ", inner, "");
			const left = Math.floor((inner - visibleWidth(title)) / 2);
			lines[0] = colors.fg("border", `╭${"─".repeat(left)}${title}${"─".repeat(inner - left - visibleWidth(title))}╮`);
		}
		return lines.map((line) => {
			if (line.includes("─".repeat(inner)) && inner > 0 && line.includes("│"))
				line = line.replace("│", "├").replace(/│([^│]*)$/, "┤$1");
			return truncateToWidth(line, width, "");
		});
	}

	dispose(): void {
		const close = this.modalClose;
		this.modalClose = undefined;
		close?.();
	}
}
