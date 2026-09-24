import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { renderEditorCompositionStatus } from "@luan.sh/pi-libtui/editor";
import { getCustomEditorSettings } from "../config/settings.ts";
import { resolveEditorComposition } from "../core/composition.ts";
import { CONTEXT_WINDOW_STATUS, FAST_MODE_STATUS, type TuiState } from "../runtime/state.ts";
import { renderStatusGroups } from "./status.ts";

type FooterFactory = Parameters<ExtensionContext["ui"]["setFooter"]>[0];
type FooterData = Parameters<NonNullable<FooterFactory>>[2];

class PiFooter implements Component {
	private readonly removeBranchListener: () => void;
	private readonly readStatuses: () => ReadonlyMap<string, string>;

	constructor(
		private readonly tui: TUI,
		private readonly ctx: ExtensionContext,
		private readonly theme: Theme,
		private readonly data: FooterData,
		private readonly state: TuiState,
		private readonly getThinkingLabel?: () => string | undefined,
	) {
		this.updateBranch();
		this.readStatuses = () => data.getExtensionStatuses();
		state.readStatuses = this.readStatuses;
		this.removeBranchListener = data.onBranchChange(() => {
			this.updateBranch();
			tui.requestRender();
		});
	}

	render(width: number): string[] {
		const statuses = this.data.getExtensionStatuses();
		this.state.setModelStatus(statuses.get(CONTEXT_WINDOW_STATUS), statuses.get(FAST_MODE_STATUS) === "fast");
		const composition = resolveEditorComposition(getCustomEditorSettings());
		const status = renderStatusGroups({
			ctx: this.ctx,
			state: this.state,
			theme: this.theme,
			left: composition.bottomLeftSegments,
			right: composition.bottomRightSegments,
			separator: composition.style.statusSeparator,
			width,
			getThinkingLabel: this.getThinkingLabel,
		});
		return renderEditorCompositionStatus(this.theme, composition.style, status, width, {
			active: this.state.active,
			elapsedMs: this.state.elapsed(),
		});
	}

	invalidate(): void {
		this.tui.requestRender();
	}

	dispose(): void {
		this.removeBranchListener();
		if (this.state.readStatuses === this.readStatuses) this.state.readStatuses = () => new Map();
	}

	private updateBranch(): void {
		this.state.branch = this.data.getGitBranch() ?? undefined;
	}
}

export function createFooter(
	ctx: ExtensionContext,
	state: TuiState,
	getThinkingLabel?: () => string | undefined,
): NonNullable<FooterFactory> {
	return (tui, theme, data) => new PiFooter(tui, ctx, theme, data, state, getThinkingLabel);
}

export { contextStatus, readUsage, workingStatus } from "./status.ts";
