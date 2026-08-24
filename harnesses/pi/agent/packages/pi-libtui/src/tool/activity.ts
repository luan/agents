import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { BackgroundSurface, TOOL_SURFACE_BACKGROUND } from "../background-surface.ts";
import { type TuiBackgroundToken, tuiTheme } from "../color/theme.ts";
import { ComponentStack } from "../component-stack.ts";
import { sanitizeTuiText } from "../content/terminal-text.ts";
import { renderUnifiedDiff, type UnifiedDiffModel, UnifiedDiffView } from "../diff/index.ts";
import type { TuiMouseEvent } from "../mouse.ts";
import { getTuiRenderEpoch } from "../render-epoch.ts";
import { TerminalOutput } from "../terminal/output.ts";
import { LiveToolAction, type ToolActionView } from "./action.ts";
import { ToolDisclosureAction } from "./disclosure-action.ts";
import { ToolOutput, type ToolOutputViewport } from "./output.ts";
import { ToolTranscript } from "./transcript.ts";
import { ToolViewRegion } from "./view-region.ts";

export interface ToolActivityAction extends Component {
	dispose?(): void;
}

export type ToolOutputUpdate = "replace" | "cumulative";
export type TerminalOutputUpdate = ToolOutputUpdate | "cumulative-tail";

export type ToolActivityPayload =
	| { kind: "text"; text: string; revision: number; update?: ToolOutputUpdate }
	| {
			kind: "terminal";
			text: string;
			revision?: number;
			/** `cumulative-tail` guarantees a truncated cumulative PTY snapshot. */
			update?: TerminalOutputUpdate;
	  }
	| { kind: "diff"; model: UnifiedDiffModel }
	| { kind: "component"; preview: Component; full?: Component; nextHint?: string };

export interface ToolActivityView {
	action: ToolActionView;
	running?: boolean;
	payload?: ToolActivityPayload;
	failure?: string;
	mode?: "preview" | "full";
}

export interface ToolActivityOptions {
	theme: Theme;
	view: ToolActivityView;
	requestRender(): void;
	previewRows?: number;
	fullRows?: number;
	/** Maximum total height of an expanded payload view. */
	maxHeight?: number;
	maxCharacters?: number;
	/** Row selection used when bounded plain-text output is truncated. */
	textSelection?: ToolOutputViewport["selection"];
	/** Optional deliberate override for the shared multiline tool surface. */
	surface?: TuiBackgroundToken;
	/** Tool-specific action grammar; payload rendering remains generic. */
	action?: ToolActivityAction;
}

/** Batteries-included streaming tool activity for plain and terminal output. */
export class ToolActivity implements Component {
	private options: ToolActivityOptions;
	private readonly requestRender = () => this.options.requestRender();
	private action: ToolActivityAction;
	private readonly disclosureAction: ToolDisclosureAction;
	private readonly textOutput: ToolOutput;
	private terminalOutput: TerminalOutput | undefined;
	private terminalPayloadRevision: string | undefined;
	private streamPayloadKind: "text" | "terminal" | undefined;
	private region: ToolViewRegion;
	private detachedRegionWasDisposed = false;
	private transcript: ToolTranscript;
	private readonly surfacedTranscript: BackgroundSurface | undefined;
	private view: ToolActivityView;
	private renderedPayloadWidth = 0;
	private diffDisclosureWidth = 0;
	private diffDisclosure = false;
	private renderedEpoch = getTuiRenderEpoch();

	constructor(options: ToolActivityOptions) {
		this.options = options;
		this.view = options.view;
		this.action =
			options.action ??
			new LiveToolAction({
				theme: options.theme,
				view: options.view.action,
				running: options.view.running,
				requestRender: this.requestRender,
			});
		this.textOutput = new ToolOutput({
			theme: options.theme,
			viewport: { maxRows: previewRowsFor(options, 6), selection: options.textSelection ?? "head-tail" },
			maxCharacters: options.maxCharacters,
		});
		this.replaceOutput();
		this.region = this.createRegion();
		this.setOutputRows(this.region.getMode());
		this.disclosureAction = new ToolDisclosureAction(options.theme, this.action, this.region, this.requestRender);
		this.transcript = this.createTranscript();
		this.surfacedTranscript = new BackgroundSurface({
			theme: options.theme,
			component: this.transcript,
			background: options.surface ?? TOOL_SURFACE_BACKGROUND,
			minimumRows: 3,
		});
	}

	/** Reuse Pi's previous component during streaming, or create the first instance. */
	static reuse(previous: object | undefined, options: ToolActivityOptions): ToolActivity {
		if (previous instanceof ToolActivity && previous.canReuse(options)) {
			previous.options = options;
			previous.update(options.view, options.action, true);
			return previous;
		}
		if (previous instanceof ToolActivity) previous.dispose();
		return new ToolActivity(options);
	}

	update(view: ToolActivityView, action?: ToolActivityAction, replaceAction = false): void {
		const previousPayload = this.view.payload;
		const previouslyRenderedBody = hasRenderedBody(this.view);
		const nextRenderedBody = hasRenderedBody(view);
		const previewRows = previewRowsFor(this.options, 6);
		const payloadChanged =
			payloadStructureChanged(this.view.payload, view.payload) ||
			payloadHasMore(this.view.payload, previewRows) !== payloadHasMore(view.payload, previewRows);
		const modeChanged = view.mode !== this.view.mode;
		const failureChanged = view.failure !== this.view.failure;
		const currentMode = this.region.getMode();
		this.view = view;
		if (payloadChanged) {
			this.diffDisclosureWidth = 0;
			this.diffDisclosure = false;
		}
		let recreatedRegion = false;
		if (!previouslyRenderedBody && nextRenderedBody && this.detachedRegionWasDisposed) {
			this.region = this.createRegion();
			this.disclosureAction.setRegion(this.region);
			this.detachedRegionWasDisposed = false;
			recreatedRegion = true;
		}
		if (replaceAction) {
			const nextAction =
				action ??
				(this.action instanceof LiveToolAction
					? this.action
					: new LiveToolAction({
							theme: this.options.theme,
							view: view.action,
							running: view.running,
							requestRender: this.requestRender,
						}));
			if (nextAction !== this.action) {
				this.disclosureAction.setAction(nextAction);
				this.action = nextAction;
			}
		} else if (action && action !== this.action) {
			this.disclosureAction.setAction(action);
			this.action = action;
		}
		if (this.action instanceof LiveToolAction) this.action.update(view.action, view.running);
		this.replaceOutput();
		if ((payloadChanged || failureChanged) && !recreatedRegion)
			this.updateRegionModes(modeChanged ? undefined : currentMode);
		else this.region.invalidateExpanded();
		if (modeChanged) this.region.setMode(view.mode ?? "preview");
		this.setOutputRows(this.region.getMode());
		this.transcript.setBody(this.bodyComponents());
		// ToolTranscript disposes removed bodies even when the activity has not
		// rendered yet. Remember every removal so a later payload cannot reuse the
		// disposed region (or its disposed nested component).
		if (previouslyRenderedBody && !nextRenderedBody) this.detachedRegionWasDisposed = true;
		disposePayload(previousPayload, view.payload);
	}

	render(width: number): string[] {
		this.refreshForRenderEpoch();
		const renderedWidth = Math.max(0, Math.floor(width));
		const payloadWidth = renderedWidth;
		this.renderedPayloadWidth = payloadWidth;
		this.ensureWrappedTextDisclosure(payloadWidth);
		this.ensureDiffDisclosure(payloadWidth);
		if (this.region.isFolded() && payloadWidth > 0) {
			const preview = this.region.render(payloadWidth);
			this.region.ensureExpandedHeight(preview.length);
		}
		return (this.surfacedTranscript ?? this.transcript).render(width);
	}
	handleViewportInput(data: string): boolean {
		return this.transcript.handleViewportInput(data);
	}
	onMouse(event: TuiMouseEvent): boolean {
		return this.transcript.onMouse(event);
	}
	get children(): readonly Component[] {
		return this.transcript.children;
	}
	getSpans() {
		return this.transcript.getSpans();
	}
	invalidate(): void {
		(this.surfacedTranscript ?? this.transcript).invalidate();
	}
	dispose(): void {
		this.disclosureAction.dispose();
		this.terminalOutput?.dispose();
		disposePayload(this.view.payload);
	}

	private replaceOutput(): void {
		const payload = this.view.payload;
		const streamKind = payload?.kind === "text" || payload?.kind === "terminal" ? payload.kind : undefined;
		if (streamKind !== this.streamPayloadKind) {
			this.textOutput.reset();
			this.terminalOutput?.setText("");
			this.terminalPayloadRevision = undefined;
			this.streamPayloadKind = streamKind;
		} else if (payload?.kind !== "terminal") {
			this.terminalPayloadRevision = undefined;
		}
		const output = payload?.kind === "text" || payload?.kind === "terminal" ? payload.text : "";
		if (payload?.kind === "terminal") {
			const revision =
				payload.revision === undefined ? undefined : `${payload.revision}:${payload.update ?? "replace"}`;
			if (revision !== undefined && revision === this.terminalPayloadRevision) return;
			this.terminalPayloadRevision = revision;
			const terminal = this.ensureTerminalOutput();
			if (payload.update === "cumulative") terminal.appendCumulative(output);
			else if (payload.update === "cumulative-tail") terminal.appendCumulativeTail(output);
			else terminal.setText(output);
			return;
		}
		const revision = payload?.kind === "text" ? payload.revision : output.length;
		if (payload?.kind === "text" && payload.update === "cumulative") {
			this.textOutput.appendCumulative(output, revision);
		} else {
			this.textOutput.replace({ text: output, revision });
		}
	}

	private refreshForRenderEpoch(): void {
		const epoch = getTuiRenderEpoch();
		if (epoch === this.renderedEpoch) return;
		this.renderedEpoch = epoch;
		const mode = this.region.getMode();
		this.updateRegionModes(mode);
		this.transcript.setBody(this.bodyComponents());
	}

	private createRegion(): ToolViewRegion {
		const previewRows =
			this.view.payload?.kind === "diff" ? previewRowsFor(this.options, 24) : previewRowsFor(this.options, 6);
		const expandedRows = this.options.maxHeight ?? Math.max(21, previewRows + 2);
		return new ToolViewRegion({
			theme: this.options.theme,
			modes: this.regionModes(),
			initialMode: this.view.mode ?? "preview",
			requestRender: this.requestRender,
			onModeChange: (mode) => this.setOutputRows(mode),
			disposeReplacedModes: false,
			maxHeight: payloadHeight(expandedRows),
			allowExpandedGrowth: this.options.maxHeight === undefined,
		});
	}

	private ensureWrappedTextDisclosure(width: number): void {
		const payload = this.view.payload;
		if (width <= 0 || (payload?.kind !== "text" && payload?.kind !== "terminal")) return;
		const shouldExpand = hasMoreText(payload.text, previewRowsFor(this.options, 6), width);
		if (this.region.isExpanded() || shouldExpand === this.region.canExpand()) return;
		this.updateRegionModes(this.region.getMode(), shouldExpand);
	}

	private ensureDiffDisclosure(width: number): void {
		const payload = this.view.payload;
		if (width <= 0 || payload?.kind !== "diff" || this.region.isExpanded() || width === this.diffDisclosureWidth)
			return;
		const previewRows = previewRowsFor(this.options, 24);
		const fullRows = this.options.fullRows ?? 500;
		const theme = tuiTheme(this.options.theme);
		const surface = this.options.surface ?? TOOL_SURFACE_BACKGROUND;
		const preview = renderUnifiedDiff(payload.model, {
			width,
			theme,
			surface,
			viewport: { maxRows: previewRows, selection: this.view.running ? "tail" : "head-tail" },
			maxRenderedRows: previewRows + 1,
		});
		const full = renderUnifiedDiff(payload.model, {
			width,
			theme,
			surface,
			viewport: { maxRows: fullRows, selection: "head-tail" },
			maxRenderedRows: fullRows + 1,
		});
		const shouldExpand = preview.omittedRows > full.omittedRows || preview.lines.length < full.lines.length;
		this.diffDisclosureWidth = width;
		if (shouldExpand === this.diffDisclosure) return;
		this.diffDisclosure = shouldExpand;
		this.updateRegionModes(this.region.getMode());
	}

	private updateRegionModes(mode?: string, forceTextDisclosure = false): void {
		this.region.updateModes(this.regionModes(forceTextDisclosure), mode);
	}

	private regionModes(forceTextDisclosure = false) {
		const payload = this.view.payload;
		let preview: Component = this.textOutput;
		let full: Component = this.textOutput;
		let nextHint: string | undefined;
		let activationRow: "omission" | undefined;
		let foldable = false;
		const previewRows = previewRowsFor(this.options, 6);
		const diffPreviewRows = previewRowsFor(this.options, 24);
		if (
			(payload?.kind === "text" || payload?.kind === "terminal") &&
			(forceTextDisclosure || hasMoreText(payload.text, previewRows, this.renderedPayloadWidth))
		) {
			foldable = true;
			activationRow = "omission";
		}
		if (payload?.kind === "terminal") preview = full = this.ensureTerminalOutput();
		else if (payload?.kind === "diff") {
			preview = new UnifiedDiffView({
				model: payload.model,
				theme: tuiTheme(this.options.theme),
				requestRender: this.requestRender,
				surface: this.options.surface ?? TOOL_SURFACE_BACKGROUND,
				viewport: { maxRows: diffPreviewRows, selection: this.view.running ? "tail" : "head-tail" },
				maxRenderedRows: diffPreviewRows + 1,
			});
			const fullRows = this.options.fullRows ?? 500;
			full = new UnifiedDiffView({
				model: payload.model,
				theme: tuiTheme(this.options.theme),
				requestRender: this.requestRender,
				surface: this.options.surface ?? TOOL_SURFACE_BACKGROUND,
				viewport: { maxRows: fullRows, selection: "head-tail" },
				maxRenderedRows: fullRows + 1,
			});
			foldable = this.diffDisclosure;
			if (foldable) activationRow = "omission";
		} else if (payload?.kind === "component") {
			preview = payload.preview;
			full = payload.full ?? payload.preview;
			foldable = Boolean(payload.full && payload.full !== payload.preview);
			nextHint = payload.nextHint;
		}
		if (this.view.failure) {
			foldable = true;
			const error = textComponent(this.view.failure);
			full = payload ? new ComponentStack([full, error]) : error;
			if (!payload) preview = textComponent("");
		}
		const modes = [
			{
				id: "preview",
				component: preview,
				nextHint,
				activationRow,
				activate: "full",
			},
			{
				id: "full",
				component: full,
				activate: "preview",
			},
		];
		return foldable ? modes : modes.slice(0, 1);
	}

	private rowsForMode(mode: string = this.view.mode ?? "preview"): number {
		if (mode === "full") return this.options.fullRows ?? 500;
		return this.view.payload?.kind === "diff" ? previewRowsFor(this.options, 24) : previewRowsFor(this.options, 6);
	}

	private setOutputRows(mode: string): void {
		const maxRows = this.rowsForMode(mode);
		this.textOutput.setViewport({ maxRows, selection: this.options.textSelection ?? "head-tail" });
		this.terminalOutput?.setMaxRows(maxRows);
	}

	private createTranscript(): ToolTranscript {
		return new ToolTranscript({
			theme: this.options.theme,
			action: this.disclosureAction,
			body: this.bodyComponents(),
			maxRows: this.options.maxHeight ?? (this.options.fullRows ?? 500) + 20,
		});
	}

	private bodyComponents(): Component[] {
		return hasRenderedBody(this.view) ? [this.region] : [];
	}

	private ensureTerminalOutput(): TerminalOutput {
		if (!this.terminalOutput) {
			this.terminalOutput = new TerminalOutput({
				requestRender: this.requestRender,
				maxRows: this.rowsForMode(),
			});
		}
		return this.terminalOutput;
	}

	private canReuse(options: ToolActivityOptions): boolean {
		return (
			this.options.theme === options.theme &&
			this.options.previewRows === options.previewRows &&
			this.options.fullRows === options.fullRows &&
			this.options.maxHeight === options.maxHeight &&
			this.options.maxCharacters === options.maxCharacters &&
			(this.options.textSelection ?? "head-tail") === (options.textSelection ?? "head-tail") &&
			(this.options.surface ?? TOOL_SURFACE_BACKGROUND) === (options.surface ?? TOOL_SURFACE_BACKGROUND)
		);
	}
}

function hasMoreText(text: string, previewRows: number, width?: number): boolean {
	if (width !== undefined && width > 0) {
		const visibleText = sanitizeTuiText(text).replace(/\n$/u, "");
		const wrapped = visibleText.length === 0 ? [] : wrapTextWithAnsi(visibleText, width);
		return wrapped.length > previewRows;
	}
	if (text.length > previewRows * 160) return true;
	let rows = text.length === 0 ? 0 : 1;
	for (let index = 0; index < text.length && rows <= previewRows; index += 1) {
		if (text.charCodeAt(index) === 10 && index < text.length - 1) rows += 1;
	}
	return rows > previewRows;
}

function previewRowsFor(options: Pick<ToolActivityOptions, "previewRows" | "maxHeight">, defaultRows: number): number {
	const requested = options.previewRows ?? defaultRows;
	const available =
		options.maxHeight === undefined || !Number.isFinite(options.maxHeight)
			? requested
			: Math.max(1, Math.floor(options.maxHeight) - 1);
	return Math.max(1, Math.min(requested, available));
}

function payloadHeight(maxHeight: number | undefined): number | undefined {
	if (maxHeight === undefined || !Number.isFinite(maxHeight)) return maxHeight;
	// ToolActivity's action is the fold header, but lives outside the payload
	// region. Reserve exactly one row for it when callers bound the whole fold.
	return Math.max(1, Math.floor(maxHeight) - 1);
}

function hasRenderedBody(view: ToolActivityView): boolean {
	return view.payload !== undefined || Boolean(view.failure);
}

function payloadHasMore(payload: ToolActivityPayload | undefined, previewRows: number): boolean {
	if (payload?.kind === "text" || payload?.kind === "terminal") return hasMoreText(payload.text, previewRows);
	return payload?.kind === "component" && Boolean(payload.full && payload.full !== payload.preview);
}

function payloadStructureChanged(
	left: ToolActivityPayload | undefined,
	right: ToolActivityPayload | undefined,
): boolean {
	if (left?.kind !== right?.kind) return true;
	if (left?.kind === "diff" && right?.kind === "diff") return left.model !== right.model;
	if (left?.kind === "component" && right?.kind === "component") {
		return left.preview !== right.preview || left.full !== right.full || left.nextHint !== right.nextHint;
	}
	return false;
}

function textComponent(text: string): Component {
	const safeText = sanitizeTuiText(text);
	return { render: () => (safeText ? safeText.split("\n") : []), invalidate() {} };
}

function disposePayload(payload: ToolActivityPayload | undefined, retainedPayload?: ToolActivityPayload): void {
	if (payload?.kind !== "component") return;
	const retained = payloadComponents(retainedPayload);
	for (const component of payloadComponents(payload)) {
		if (!retained.has(component)) (component as Component & { dispose?(): void }).dispose?.();
	}
}

function payloadComponents(payload: ToolActivityPayload | undefined): Set<Component> {
	if (payload?.kind !== "component") return new Set();
	return new Set([payload.preview, ...(payload.full ? [payload.full] : [])]);
}
