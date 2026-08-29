import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	FloatingOverlay,
	FullscreenOverlay,
	fullscreenOverlayOptions,
	PtyPane,
	PtyProcess,
	SearchableSelect,
	type SidePanelContent,
	type SidePanelSession,
	type SidePanelTab,
	type SplitPaneHost,
	tuiThemeAppearance,
} from "pi-libtui";
import {
	listTuicrTargets,
	prepareTuicrReview,
	type TuicrComment,
	type TuicrReview,
	type TuicrRuntime,
	type TuicrTarget,
	type TuicrTargetId,
} from "./tuicr-review.ts";

interface ReviewTab {
	readonly id: string;
	readonly targets: readonly TuicrTarget[];
	readonly target?: TuicrTarget;
	readonly review?: TuicrReview;
	readonly process?: PtyProcess;
	readonly stopWatching?: () => void;
	readonly choosing: boolean;
}

export class TuicrManager {
	private panel: SidePanelSession | undefined;
	private removeEmptyAction: (() => void) | undefined;
	private readonly reviews = new Map<string, ReviewTab>();
	private nextNumber = 1;
	private disposed = false;

	constructor(
		private readonly context: ExtensionContext,
		private readonly runtime: TuicrRuntime,
		private readonly publishComments: (comments: readonly TuicrComment[]) => void,
		private readonly scope: typeof globalThis,
	) {}

	attachPanel(panel: SidePanelSession): () => void {
		if (this.disposed) return () => {};
		this.panel = panel;
		this.removeEmptyAction = panel.registerEmptyAction({
			id: "tuicr.open",
			label: "Review",
			actionId: "side-panel.tuicr.open",
		});
		return () => {
			this.removeEmptyAction?.();
			this.removeEmptyAction = undefined;
			for (const id of this.reviews.keys()) panel.removeTab(id);
			if (this.panel === panel) this.panel = undefined;
		};
	}

	async open(): Promise<void> {
		if (this.disposed) return;
		if (!this.panel) {
			await this.openOverlay();
			return;
		}
		const active = this.panel.activeTabId();
		if (active && this.reviews.has(active)) {
			this.setReview(active, { ...this.reviews.get(active)!, choosing: true });
			return;
		}
		const result = listTuicrTargets(this.context.cwd, this.runtime);
		if (!result.ok) {
			this.context.ui.notify(result.message, "error");
			return;
		}
		const targets = result.targets;
		if (targets.length === 0) return;
		const number = this.nextNumber++;
		const id = `tuicr:${number}`;
		this.reviews.set(id, { id, targets, choosing: true });
		this.panel.addTab(this.panelTab(id), { activate: true, focus: true });
	}

	async select(id: string, targetId: TuicrTargetId): Promise<void> {
		if (this.disposed) return;
		const state = this.reviews.get(id);
		const target = state?.targets.find((candidate) => candidate.id === targetId);
		if (!state || !target) return;
		if (state.target?.id === targetId) {
			this.setReview(id, { ...state, choosing: false });
			return;
		}
		const review = await prepareTuicrReview(this.context, target, this.runtime);
		if (!review || this.disposed || this.reviews.get(id) !== state) return;
		this.releaseRuntime(state);
		const process = new PtyProcess({
			label: "Review",
			command: tuicrCommand(review.args, tuiThemeAppearance(this.context.ui.theme)),
			context: this.context,
			onExit: () => this.close(id),
			scope: this.scope,
		});
		const next: ReviewTab = { ...state, target, review, process, choosing: false };
		this.setReview(id, next);
		const current = this.reviews.get(id);
		if (current !== next) return;
		const stopWatching = review.watch((comments) => {
			if (comments.length > 0) this.publishComments(comments);
		});
		this.setReview(id, { ...next, stopWatching });
	}

	cancel(id: string): void {
		const state = this.reviews.get(id);
		if (!state) return;
		if (!state.target) this.close(id);
		else this.setReview(id, { ...state, choosing: false });
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.removeEmptyAction?.();
		this.removeEmptyAction = undefined;
		for (const state of this.reviews.values()) this.releaseRuntime(state);
		this.reviews.clear();
		this.panel = undefined;
	}

	private panelTab(id: string): SidePanelTab {
		const state = this.reviews.get(id)!;
		return {
			id,
			label: this.reviews.size === 1 ? "Review" : `Review ${id.slice("tuicr:".length)}`,
			icon: { glyph: "" },
			headerAction: { label: state.target?.label ?? "Review target", actionId: "side-panel.tuicr.open" },
			inputActions: ["side-panel.tuicr.open"],
			create: (host, theme) => this.createContent(id, host, theme),
			onClose: () => this.close(id),
		};
	}

	private createContent(id: string, host: SplitPaneHost, theme: Theme): SidePanelContent {
		const state = this.reviews.get(id)!;
		const base: SidePanelContent = state.process
			? new PtyPane(state.process, {
					tui: host.tui,
					rows: () => Math.max(1, host.getTerminalSize().rows - 1),
					requestRender: () => host.requestRender(),
				})
			: new BlankReview(host);
		if (!state.choosing) return base;
		const picker = new SearchableSelect({
			title: "Review target",
			description: "Choose what tuicr should review",
			options: state.targets.map((target) => ({ value: target.id, label: target.label })),
			...(state.target ? { selected: state.target.id } : {}),
			theme,
			onSelect: (target) => void this.select(id, target),
			onCancel: () => this.cancel(id),
			requestRender: () => host.requestRender(),
		});
		return new FloatingOverlay({
			base,
			overlay: picker,
			overlayWidth: (width) => Math.min(Math.max(28, Math.floor(width * 0.72)), width),
			maxHeight: () => Math.max(1, host.getTerminalSize().rows - 1),
			surface: { theme, background: "surface.raised" },
		});
	}

	private setReview(id: string, state: ReviewTab): void {
		this.reviews.set(id, state);
		this.panel?.updateTab(this.panelTab(id));
	}

	private close(id: string): void {
		const state = this.reviews.get(id);
		if (!state) return;
		this.releaseRuntime(state);
		this.reviews.delete(id);
		this.panel?.removeTab(id);
	}

	private releaseRuntime(state: ReviewTab): void {
		state.stopWatching?.();
		if (state.review) {
			const comments = state.review.comments();
			if (comments.length > 0) this.publishComments(comments);
		}
		state.process?.dispose();
	}

	private async openOverlay(): Promise<void> {
		if (this.disposed) return;
		const result = listTuicrTargets(this.context.cwd, this.runtime);
		if (!result.ok) {
			this.context.ui.notify(result.message, "error");
			return;
		}
		const targets = result.targets;
		if (targets.length === 0) return;
		const targetLabel = await this.context.ui.select(
			"Review target",
			targets.map((target) => target.label),
		);
		if (this.disposed) return;
		const target = targets.find((candidate) => candidate.label === targetLabel);
		if (!target) return;
		const review = await prepareTuicrReview(this.context, target, this.runtime);
		if (!review || this.disposed || !this.context.ui.custom) return;
		await this.context.ui.custom<void>(
			(tui, theme, _keys, done) => {
				const process = new PtyProcess({
					label: "Review",
					command: tuicrCommand(review.args, tuiThemeAppearance(theme)),
					context: this.context,
					onExit: () => {
						const comments = review.comments();
						if (comments.length > 0) this.publishComments(comments);
						done(undefined);
					},
					scope: this.scope,
				});
				const pane = new PtyPane(process, {
					tui,
					rows: () => Math.max(1, tui.terminal.rows - 2),
					requestRender: () => tui.requestRender(),
				});
				const stop = review.watch((comments) => {
					if (comments.length > 0) this.publishComments(comments);
				});
				const overlay = new FullscreenOverlay(tui, theme, pane, "Review");
				const dispose = overlay.dispose.bind(overlay);
				overlay.dispose = () => {
					stop();
					process.dispose();
					dispose();
				};
				return overlay;
			},
			{ overlay: true, overlayOptions: fullscreenOverlayOptions() },
		);
	}
}

class BlankReview implements SidePanelContent {
	constructor(private readonly host: SplitPaneHost) {}
	render(): string[] {
		return Array.from({ length: Math.max(1, this.host.getTerminalSize().rows - 1) }, () => "");
	}
	invalidate(): void {}
}

function tuicrCommand(args: readonly string[], appearance: "dark" | "light"): string {
	return ["tuicr", "--appearance", appearance, ...args].map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}
