import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text } from "@earendil-works/pi-tui";
import {
	ComponentStack,
	DialogButtonBar,
	type DialogHost,
	sanitizeTuiText,
	ScrollView,
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
	private bodyHeight = 1;
	private readonly reader: ScrollView;
	private readonly actions: DialogButtonBar<"close">;

	constructor(private readonly config: ReportDialogOptions) {
		const colors = tuiTheme(config.theme);
		const reader = new ScrollView({
			height: () => this.bodyHeight,
			requestRender: config.requestRender,
			renderContent: (width) =>
				new Text(colors.fg("text.primary", sanitizeTuiText(config.content)), 0, 0).render(Math.max(1, width)),
		});
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
		super([reader, actions], { height: () => this.maxHeight, anchorLastChild: true });
		this.reader = reader;
		this.actions = actions;
	}

	setMaxHeight(height: number): void {
		this.maxHeight = Math.max(1, Math.floor(height));
	}

	override render(width: number): string[] {
		if (this.config.height) this.setMaxHeight(this.config.height());
		this.bodyHeight = Math.max(0, this.maxHeight - 1);
		return super.render(width);
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
		if (delta) this.reader.setOffset(this.reader.getOffset() + delta);
		if (matchesKey(data, "home")) this.reader.setOffset(0);
		if (matchesKey(data, "end")) this.reader.setOffset(this.reader.getGeometry()?.maxOffset ?? 0);
		this.config.requestRender();
	}
}

export function openReportDialog(host: DialogHost, dialog: ReportDialog): () => void {
	return host.open(dialog, { title: "Details", width: "80%", maxHeight: "85%" });
}

export function createReportDialog(options: ReportDialogOptions): ReportDialog {
	return new ReportDialog(options);
}
