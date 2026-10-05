import type { Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { ComponentStack, semanticMarkdownTheme, tuiTheme } from "@luan.sh/pi-libtui";
import { ToolDisclosureAction, ToolViewRegion, type TranscriptEntry } from "@luan.sh/pi-libtui/tool";

/** A context boundary, not an assistant message or a tool activity. */
export class CompactionSection extends ComponentStack {
	private readonly disclosure: ToolDisclosureAction;

	constructor(entry: Extract<TranscriptEntry, { kind: "compaction" }>, theme: Theme, requestRender: () => void) {
		super();
		const region = new ToolViewRegion({
			theme,
			requestRender,
			modes: [
				{ id: "preview", component: { render: () => [], invalidate() {} } },
				{ id: "full", component: new Markdown(entry.summary, 0, 0, semanticMarkdownTheme(theme)) },
			],
		});
		const label = `── Context compacted · ${entry.tokensBefore.toLocaleString()} tokens before `;
		this.disclosure = new ToolDisclosureAction(
			theme,
			{
				render(width) {
					if (width <= 0) return [];
					const line = truncateToWidth(label, Math.max(0, width - 2), "…");
					return [tuiTheme(theme).fg("text.muted", line + "─".repeat(Math.max(0, width - 2 - visibleWidth(line))))];
				},
				invalidate() {},
			},
			region,
			requestRender,
		);
		this.setChildren([this.disclosure, region]);
	}

	dispose(): void {
		this.disclosure.dispose();
	}
}
