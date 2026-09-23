import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Text, matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import {
	ComponentStack,
	DialogOverlay,
	ProgressBar,
	SelectableList,
	ScrollView,
	TabBar,
	sanitizeTuiText,
	tuiTheme,
	type DialogHost,
} from "@luan.sh/pi-libtui";
import type { TokenBurdenReport } from "../core/report.ts";
import { REPORT_TABS, type ReportTab } from "../core/report-navigation.ts";
import { reportRows, type ReportRow } from "./report-rows.ts";
import { createReportDialog } from "./report-dialog.ts";
import { fitBurdenBar, percent } from "./burden-bar.ts";
import { reportColors } from "./report-theme.ts";
import type { ToolControlService } from "../runtime/tool-controls.ts";

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

/** Shared stacks and frames own every pointer translation, including the split. */
export class ReportScreen extends ComponentStack {
	private tab: ReportTab = "Overview";
	private readonly tabs: TabBar;
	private readonly list: SelectableList<ReportRow>;
	private readonly listContent: ComponentStack;
	private readonly listFrame: DialogOverlay;
	private readonly split: ComponentStack;
	private readonly snapshot: DialogOverlay;
	private readonly summary: Component;
	private readonly footer: Component;
	private readonly empty: Component;
	private readonly progress: ProgressBar | undefined;
	private modalClose: (() => void) | undefined;
	private bodyHeight = 1;
	private readonly inspectorView: ScrollView;
	private inspecting = false;
	private wide = false;
	private controlMessage = "";

	constructor(
		private readonly report: TokenBurdenReport,
		private readonly host: ScreenHost,
	) {
		super([], { height: host.height, anchorLastChild: true });
		this.inspectorView = new ScrollView({
			height: () => this.bodyHeight,
			requestRender: host.requestRender,
			renderContent: (width) => this.renderInspectorContent(width),
		});
		const label = (get: () => string): Component => ({
			render: (width) => [truncateToWidth(tuiTheme(host.theme).fg("text.secondary", singleLine(get())), width, "")],
			invalidate() {},
		});
		this.summary = label(() => this.summaryText());
		this.footer = label(() => this.footerText());
		this.empty = label(() => `No ${this.tab.toLowerCase()} reported.`);
		this.tabs = new TabBar(
			REPORT_TABS.map((id) => ({ id, label: id })),
			host.theme,
		);
		this.tabs.onChange = (_tab, index) => {
			this.tab = REPORT_TABS[index] ?? "Overview";
			this.list.setItems(reportRows(report, this.tab), 0);
			this.inspectorView.setOffset(0);
			this.inspecting = false;
			host.requestRender();
		};
		this.list = new SelectableList({
			items: reportRows(report, this.tab),
			wrap: false,
			requestRender: host.requestRender,
			renderItem: (row, context) => {
				const colors = reportColors(host.theme);
				const marker = context.selected ? colors.selected("> ") : "  ";
				const share = row.share
					? ` ${colors.muted(`${percent(row.share.value, row.share.total)}`)} ${colors.estimated(fitBurdenBar(row.share.value, row.share.total, 10))}`
					: "";
				const text = `${marker}${singleLine(row.label)}${share}`;
				return context.selected ? colors.selected(text) : row.state === "unavailable" ? colors.unavailable(text) : text;
			},
			onSelectionChange: () => {
				this.inspectorView.setOffset(0);
				this.inspecting = false;
			},
			onActivate: (row) => this.open(row),
		});
		this.listContent = new ComponentStack([this.list], { height: () => this.bodyHeight });
		this.listFrame = new DialogOverlay(
			host.theme,
			this.listContent,
			() => `${this.tab}${this.inspecting ? "" : " · selected"}`,
		);
		const inspector: Component = this.inspectorView;
		const inspectorContent = new ComponentStack([inspector], { height: () => this.bodyHeight });
		const inspectorFrame = new DialogOverlay(
			host.theme,
			inspectorContent,
			() => `Inspector${this.inspecting ? " · focused" : " · Tab to focus"}`,
		);
		this.split = new ComponentStack([this.listFrame, inspectorFrame], { direction: "horizontal", gap: 2 });
		this.snapshot = new DialogOverlay(
			host.theme,
			new ComponentStack([
				label(
					() =>
						`${report.model ?? "Model unavailable"} · context ${report.context?.tokens ?? "unavailable"} / ${report.context?.contextWindow ?? "unavailable"}`,
				),
				label(
					() =>
						`Prompt ~${report.promptTokens} tokens · ${report.tools.filter((tool) => tool.active).length}/${report.tools.length} active tools · branch recorded ${report.usage.branch.totals?.total ?? "unavailable"} tokens`,
				),
			]),
			"Context snapshot · measured + estimated",
		);
		if (report.context?.percent != null)
			this.progress = new ProgressBar({
				theme: host.theme,
				value: report.context.percent / 100,
				label: "Context",
				showPercentage: true,
			});
	}

	private summaryText(): string {
		if (this.tab === "Prompt")
			return `Prompt sections · ~${this.report.promptTokens} tokens · context files overlap, not additive`;
		if (this.tab === "Tools")
			return `Tool definition estimates · active/inactive only · not historical billing${this.controlMessage ? ` · ${this.controlMessage}` : ""}`;
		if (this.tab === "Usage") return "Recorded branch/session work · cumulative usage, not current context";
		if (this.tab === "Skills") return "Skill advertisements only · bodies are not loaded · estimates are not additive";
		return "What is in context, what it costs, and what can be changed · Enter to inspect";
	}

	private footerText(): string {
		const key = (id: Parameters<KeybindingsManager["getKeys"]>[0]) => this.host.keybindings.getKeys(id).join("/");
		return `←/→ tabs · ${key("tui.select.up")}/${key("tui.select.down")} ${this.inspecting ? "scroll" : "select"} · Tab focus · ${key("tui.select.confirm")} details · Space ${this.tab === "Tools" ? "toggle tool" : "n/a"} · ? help · Esc close`;
	}

	private renderInspectorContent(width: number): string[] {
		if (width <= 0 || this.bodyHeight === 0) return [];
		const row = this.list.getSelectedItem();
		const text = row ? `${row.label}\n\n${row.detail}` : "Select an item to inspect its measurements.";
		const lines = new Text(tuiTheme(this.host.theme).fg("text.primary", sanitizeTuiText(text)), 0, 0).render(
			Math.max(1, width - 1),
		);
		if (row?.share && row.share.total > 0) {
			lines.unshift(
				...new ProgressBar({
					theme: this.host.theme,
					value: row.share.value / row.share.total,
					label: row.share.label,
					showPercentage: true,
				}).render(Math.max(1, width - 1)),
				"",
			);
		}
		return lines;
	}

	private open(row: ReportRow): void {
		this.dispose();
		const close = () => {
			this.dispose();
			this.host.requestRender();
		};
		const dialog = createReportDialog({
			title: singleLine(row.label),
			content: row.detail,
			theme: this.host.theme,
			keybindings: this.host.keybindings,
			requestRender: this.host.requestRender,
			onClose: close,
			height: () => Math.max(0, Math.floor((this.host.height() + 2) * 0.85) - 2),
		});
		this.modalClose = this.host.dialogs.open(dialog, { title: singleLine(row.label), width: "80%", maxHeight: "85%" });
	}

	override handleInput(data: string): void {
		const kb = this.host.keybindings;
		if (data === "?") {
			this.open({
				label: "Token burden help",
				detail: `${this.footerText()}\n\nPage Up/Down and Home/End navigate the focused pane. On narrow terminals, Enter opens the inspector as a dialog. Closing a dialog preserves the selected row.\n\nThis is a read-only snapshot. Reopen to refresh. Token estimates use characters / 4, not provider tokenization. Context files overlap the prompt. Recorded usage is cumulative work, not current context or independently verified billing.`,
			});
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.dispose();
			this.host.close();
			return;
		}
		if (matchesKey(data, "tab") && this.wide) {
			this.inspecting = !this.inspecting;
			this.host.requestRender();
			return;
		}
		if (this.tabs.handleInput(data)) return;
		if (data === " " && this.tab === "Tools" && !this.inspecting) {
			void this.toggleSelectedTool();
			return;
		}
		const delta = kb.matches(data, "tui.select.down")
			? 1
			: kb.matches(data, "tui.select.up")
				? -1
				: kb.matches(data, "tui.select.pageDown")
					? this.bodyHeight
					: kb.matches(data, "tui.select.pageUp")
						? -this.bodyHeight
						: 0;
		if (this.inspecting) {
			this.inspectorView.handleViewportInput(data);
		} else {
			if (delta) this.list.setSelectedIndex(this.list.getSelectedIndex() + delta);
			if (matchesKey(data, "home")) this.list.setSelectedIndex(0);
			if (matchesKey(data, "end")) this.list.setSelectedIndex(reportRows(this.report, this.tab).length - 1);
		}
		if (kb.matches(data, "tui.select.confirm")) {
			const row = this.list.getSelectedItem();
			if (row) this.open(row);
		}
		this.host.requestRender();
	}

	private async toggleSelectedTool(): Promise<void> {
		const row = this.list.getSelectedItem();
		const tool = row ? this.report.tools.find((candidate) => row.label.includes(`· ${candidate.name} ·`)) : undefined;
		if (!tool) {
			this.controlMessage = "Select a tool row to toggle";
			this.host.requestRender();
			return;
		}
		if (!this.host.toolControls) {
			this.controlMessage = "Tool changes unavailable (read-only host)";
			this.host.requestRender();
			return;
		}
		this.controlMessage = `${tool.name}: waiting for idle…`;
		this.host.requestRender();
		const result = await this.host.toolControls.toggle(tool.name, !tool.active);
		this.controlMessage = result.message;
		if (result.applied) tool.active = result.active.includes(tool.name);
		this.host.requestRender();
	}

	override render(width: number): string[] {
		const height = Math.max(0, this.host.height());
		this.wide = width >= 96;
		if (!this.wide) this.inspecting = false;
		// Compact terminals keep navigation and the list; cards return when there is room.
		const header: Component[] =
			height >= 12 ? [this.tabs, this.snapshot, this.summary] : height >= 4 ? [this.tabs] : [];
		if (height >= 12 && this.progress) header.push(this.progress);
		const headerHeight = header.reduce((sum, child) => sum + child.render(width).length, 0);
		this.bodyHeight = Math.max(0, height - headerHeight - 3);
		this.list.setMaxVisible(this.bodyHeight);
		this.listContent.setChildren([this.list.getSelectedItem() ? this.list : this.empty]);
		this.setChildren([
			...header,
			...(height - headerHeight >= 3 ? [this.wide ? this.split : this.listFrame] : []),
			this.footer,
		]);
		return super.render(width).map((line) => truncateToWidth(line, width, ""));
	}

	dispose(): void {
		const close = this.modalClose;
		this.modalClose = undefined;
		close?.();
	}
}
