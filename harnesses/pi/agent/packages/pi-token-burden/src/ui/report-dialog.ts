import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, Text } from "@earendil-works/pi-tui";
import {
	applyScrollbar,
	ComponentStack,
	DialogButtonBar,
	type DialogHost,
	sanitizeTuiText,
	tuiTheme,
} from "@luan.sh/pi-libtui";

export interface ReportDialogOptions {
	theme: Theme;
	keybindings: Pick<KeybindingsManager, "matches" | "getKeys">;
	requestRender(): void;
	onClose(): void;
	title: string;
	content: string;
	height?: () => number;
}

/** Focus-owning, scrollable report detail used inside a native DialogOverlay. */
export class ReportDialog extends ComponentStack {
	private maxHeight = 20;
	private offset = 0;
	private bodyHeight = 1;
	private totalLines = 0;
	private readonly actions: DialogButtonBar<"close">;

	constructor(private readonly config: ReportDialogOptions) {
		const colors = tuiTheme(config.theme);
		const reader: Component = {
			render: (width) => {
				const lines = new Text(colors.fg("text.primary", sanitizeTuiText(config.content)), 0, 0).render(
					Math.max(1, width),
				);
				this.totalLines = lines.length;
				this.offset = Math.min(this.offset, Math.max(0, lines.length - this.bodyHeight));
				return applyScrollbar(lines.slice(this.offset, this.offset + this.bodyHeight), {
					theme: config.theme,
					width,
					height: this.bodyHeight,
					offset: this.offset,
					total: lines.length,
				});
			},
			invalidate() {},
		};
		const actions = new DialogButtonBar({
			theme: config.theme,
			buttons: [
				{
					value: "close",
					label: "Close",
					foreground: "text.primary",
					background: "action.neutral",
					shortcuts: ["escape"],
				},
			],
			requestRender: config.requestRender,
			onActivate: () => config.onClose(),
		});
		super([reader, actions], { anchorLastChild: true });
		this.actions = actions;
	}

	setMaxHeight(height: number): void {
		this.maxHeight = Math.max(1, Math.floor(height));
	}

	override render(width: number): string[] {
		if (this.config.height) this.setMaxHeight(this.config.height());
		this.bodyHeight = Math.max(1, this.maxHeight - 1);
		return super.render(width).slice(0, this.maxHeight);
	}

	override handleInput(data: string): void {
		if (
			this.config.keybindings.matches(data, "tui.select.cancel") ||
			matchesKey(data, "escape") ||
			matchesKey(data, "ctrl+c")
		) {
			this.config.onClose();
			return;
		}
		this.actions.handleInput(data);
		const delta = this.config.keybindings.matches(data, "tui.select.down")
			? 1
			: this.config.keybindings.matches(data, "tui.select.up")
				? -1
				: this.config.keybindings.matches(data, "tui.select.pageDown")
					? this.bodyHeight
					: this.config.keybindings.matches(data, "tui.select.pageUp")
						? -this.bodyHeight
						: 0;
		if (delta) this.offset = Math.max(0, Math.min(this.offset + delta, Math.max(0, this.totalLines - this.bodyHeight)));
		if (matchesKey(data, "home")) this.offset = 0;
		if (matchesKey(data, "end")) this.offset = Math.max(0, this.totalLines - this.bodyHeight);
		this.config.requestRender();
	}
}

export function openReportDialog(host: DialogHost, dialog: ReportDialog): () => void {
	return host.open(dialog, { title: "Details", width: "80%", maxHeight: "85%" });
}

export function createReportDialog(options: ReportDialogOptions): ReportDialog {
	return new ReportDialog(options);
}
