import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { ComponentStack, icon, SyntaxText, sanitizeTuiField, TabBar, tuiTheme } from "pi-libtui";
import type { TuiMouseEvent } from "pi-libtui/mouse";
import { ToolActivity, type ToolTranscriptStatus } from "pi-libtui/tool";
import { getNestedToolAdapterRegistry, type NestedToolPresentationComponent } from "../protocol/nested-tools.ts";
import type { CodeModeToolDetails, NestedToolTrace } from "../protocol/types.ts";

interface RendererContext {
	readonly state: object;
	readonly executionStarted: boolean;
	readonly isError: boolean;
	readonly expanded?: boolean;
	readonly invalidate: () => void;
	readonly lastComponent: object | undefined;
	readonly cwd?: string;
}

interface PresentationComponent {
	render(width: number): string[];
	invalidate(): void;
	dispose?(): void;
}

/** Code Mode stays quiet while exposing source and result as separate view modes. */
export function renderCodeModeCall(
	_tool: "exec" | "wait",
	_args: { code?: string; cell_id?: string; terminate?: boolean },
	_theme: Theme,
	_context: RendererContext,
): PresentationComponent {
	return new ComponentStack();
}

export function renderCodeModeResult(
	result: AgentToolResult<CodeModeToolDetails>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: RendererContext,
): CodeModeResultComponent {
	if (context.lastComponent instanceof CodeModeResultComponent) {
		context.lastComponent.update(result, context.isError, options.expanded);
		return context.lastComponent;
	}
	return new CodeModeResultComponent(
		theme,
		context.invalidate,
		result,
		context.isError,
		options.expanded,
		context.cwd ?? "",
		context.executionStarted,
	);
}

export class CodeModeResultComponent implements PresentationComponent {
	private readonly nested = new Map<string, NestedCallView>();
	private readonly disclosure: CodeModeDisclosure;
	private readonly stack = new ComponentStack();
	private compactResult: LazyCodeModeResult | undefined;
	private snapshot: CodeModePresentationSnapshot;

	constructor(
		private readonly theme: Theme,
		private readonly requestRender: () => void,
		private result: AgentToolResult<CodeModeToolDetails>,
		private hostError: boolean,
		private expanded: boolean,
		private readonly cwd: string,
		private readonly executionStarted: boolean,
	) {
		this.snapshot = codeModePresentationSnapshot(result, hostError, expanded);
		this.disclosure = new CodeModeDisclosure(theme, requestRender, disclosureView(result, expanded));
		this.rebuild();
	}

	update(result: AgentToolResult<CodeModeToolDetails>, hostError: boolean, expanded: boolean): void {
		const snapshot = codeModePresentationSnapshot(result, hostError, expanded);
		if (sameCodeModePresentation(this.snapshot, snapshot)) {
			this.result = result;
			return;
		}
		this.snapshot = snapshot;
		this.result = result;
		this.hostError = hostError;
		this.expanded = expanded;
		this.rebuild();
	}

	render(width: number): string[] {
		return this.stack.render(width);
	}
	get children(): readonly PresentationComponent[] {
		return this.stack.getChildren();
	}
	getSpans() {
		return this.stack.getSpans();
	}
	invalidate(): void {
		this.stack.invalidate();
	}
	dispose(): void {
		this.disclosure.dispose();
		this.compactResult?.dispose();
		for (const view of this.nested.values()) view.dispose();
	}

	private rebuild(): void {
		const details = this.result.details;
		const traces = restoredNestedCalls(details);
		const activeIds = new Set(traces.map((trace) => trace.id));
		for (const [id, view] of this.nested) {
			if (activeIds.has(id)) continue;
			view.dispose();
			this.nested.delete(id);
		}

		const nested: PresentationComponent[] = [];
		const localOwners = new Map<string, NestedCallView>();
		for (const trace of traces) {
			const localOwner = localOwners.get(tracePresentationKey(trace));
			let view = this.nested.get(trace.id);
			if (view) view.update(trace, this.expanded, localOwner);
			else {
				view = new NestedCallView(
					this.theme,
					this.requestRender,
					trace,
					this.expanded,
					this.cwd,
					this.executionStarted,
					() => this.disclosure.invalidate(),
					localOwner,
				);
				this.nested.set(trace.id, view);
			}
			if (!localOwner && view.isVisible) localOwners.set(view.ownerKey, view);
			if (view.isVisible && isTranscriptTrace(trace)) nested.push(view.component);
		}
		if (!hasTranscriptResult(this.result, this.hostError)) {
			this.stack.setChildren([]);
			return;
		}
		if (!this.expanded && !hasCodeModeFailure(this.result, this.hostError)) {
			const output = nested.length === 0 ? scriptOutput(this.result) : "";
			if (output) {
				if (this.compactResult) this.compactResult.update(output);
				else this.compactResult = new LazyCodeModeResult(this.theme, output, this.requestRender);
			} else if (this.compactResult) {
				this.compactResult.dispose();
				this.compactResult = undefined;
			}
			this.stack.setChildren(this.compactResult ? [...nested, this.compactResult] : nested);
			return;
		}

		// Keep the nested rows inside the disclosure payload. The outer activity
		// owns the single fold state and bounded viewport for the complete result;
		// nested activities still retain their own row-level interaction contracts.
		this.disclosure.update(disclosureView(this.result, this.expanded), nested);
		this.stack.setChildren([this.disclosure]);
	}
}

interface ContentItemSnapshot {
	readonly item: object | undefined;
	readonly type: unknown;
	readonly text: unknown;
}

interface NestedTraceSnapshot {
	readonly id: string;
	readonly name: string;
	readonly kind: NestedToolTrace["kind"];
	readonly input: unknown;
	readonly status: NestedToolTrace["status"];
	readonly startedAtMs: number;
	readonly durationMs: number | undefined;
	readonly error: string | undefined;
	readonly value: unknown;
	readonly resultContent: readonly ContentItemSnapshot[];
	readonly resultDetails: unknown;
	readonly presentationKey: string;
}

interface CodeModePresentationSnapshot {
	readonly hostError: boolean;
	readonly expanded: boolean;
	readonly tool: CodeModeToolDetails["tool"] | undefined;
	readonly status: CodeModeToolDetails["status"] | undefined;
	readonly cellId: string | undefined;
	readonly isError: boolean | undefined;
	readonly scriptError: string | undefined;
	readonly missingCell: boolean | undefined;
	readonly durationMs: number | undefined;
	readonly code: string | undefined;
	readonly notificationText: string | undefined;
	readonly notificationTruncated: boolean | undefined;
	readonly content: readonly ContentItemSnapshot[];
	readonly traces: readonly NestedTraceSnapshot[];
}

function codeModePresentationSnapshot(
	result: AgentToolResult<CodeModeToolDetails>,
	hostError: boolean,
	expanded: boolean,
): CodeModePresentationSnapshot {
	const details = result.details;
	return {
		hostError,
		expanded,
		tool: details?.tool,
		status: details?.status,
		cellId: details?.cellId,
		isError: details?.isError,
		scriptError: details?.scriptError,
		missingCell: details?.missingCell,
		durationMs: details?.timing?.durationMs,
		code: codeText(details?.input),
		notificationText: details?.notification?.text,
		notificationTruncated: details?.notification?.truncated,
		content: contentSnapshot(result.content),
		traces: restoredNestedCalls(details).map((trace) => ({
			id: trace.id,
			name: trace.name,
			kind: trace.kind,
			input: trace.input,
			status: trace.status,
			startedAtMs: trace.startedAtMs,
			durationMs: trace.durationMs,
			error: trace.error,
			value: trace.value,
			resultContent: contentSnapshot(trace.result?.content),
			resultDetails: trace.result?.details,
			presentationKey: tracePresentationKey(trace),
		})),
	};
}

function contentSnapshot(content: readonly unknown[] | undefined): ContentItemSnapshot[] {
	if (!content) return [];
	return content.map((value) => ({
		item: value && typeof value === "object" ? value : undefined,
		type: value && typeof value === "object" ? Reflect.get(value, "type") : undefined,
		text: value && typeof value === "object" ? Reflect.get(value, "text") : value,
	}));
}

function sameCodeModePresentation(left: CodeModePresentationSnapshot, right: CodeModePresentationSnapshot): boolean {
	return (
		left.hostError === right.hostError &&
		left.expanded === right.expanded &&
		left.tool === right.tool &&
		left.status === right.status &&
		left.cellId === right.cellId &&
		left.isError === right.isError &&
		left.scriptError === right.scriptError &&
		left.missingCell === right.missingCell &&
		left.durationMs === right.durationMs &&
		left.code === right.code &&
		left.notificationText === right.notificationText &&
		left.notificationTruncated === right.notificationTruncated &&
		sameContentSnapshot(left.content, right.content) &&
		left.traces.length === right.traces.length &&
		left.traces.every((trace, index) => sameNestedTraceSnapshot(trace, right.traces[index]!))
	);
}

function sameNestedTraceSnapshot(left: NestedTraceSnapshot, right: NestedTraceSnapshot): boolean {
	return (
		left.id === right.id &&
		left.name === right.name &&
		left.kind === right.kind &&
		left.input === right.input &&
		left.status === right.status &&
		left.startedAtMs === right.startedAtMs &&
		left.durationMs === right.durationMs &&
		left.error === right.error &&
		left.value === right.value &&
		left.resultDetails === right.resultDetails &&
		left.presentationKey === right.presentationKey &&
		sameContentSnapshot(left.resultContent, right.resultContent)
	);
}

function sameContentSnapshot(left: readonly ContentItemSnapshot[], right: readonly ContentItemSnapshot[]): boolean {
	return (
		left.length === right.length &&
		left.every(
			(item, index) =>
				item.item === right[index]!.item && item.type === right[index]!.type && item.text === right[index]!.text,
		)
	);
}

/** Delay syntax setup until compact result content is actually visible. */
class LazyCodeModeResult implements PresentationComponent {
	private result: SyntaxText | undefined;

	constructor(
		private readonly theme: Theme,
		private text: string,
		private readonly requestRender: () => void,
	) {}

	update(text: string): void {
		this.text = text;
		this.result?.setText(prettify(text));
	}

	render(width: number): string[] {
		return this.ensureResult().render(width);
	}

	invalidate(): void {
		this.result?.invalidate();
	}

	dispose(): void {
		this.result?.invalidate();
		this.result = undefined;
	}

	private ensureResult(): SyntaxText {
		this.result ??= new SyntaxText({
			theme: this.theme,
			text: prettify(this.text),
			path: ".json",
			maxRows: 1_000,
			requestRender: this.requestRender,
		});
		return this.result;
	}
}

interface CodeDisclosureView {
	tool: "exec" | "wait";
	code: string;
	result: string;
	meta?: string;
	initialMode?: string;
}

class CodeModeDisclosure implements PresentationComponent {
	private readonly activity: ToolActivity;
	private readonly action: CodeModeAction;
	private readonly nestedBody = new ComponentStack();
	private readonly body = new ComponentStack();
	private tabs: LazyCodeModeTabs | undefined;
	private view: CodeDisclosureView;

	constructor(
		private readonly theme: Theme,
		private readonly requestRender: () => void,
		view: CodeDisclosureView,
	) {
		this.view = view;
		this.action = new CodeModeAction(theme, view);
		this.updateBody([]);
		this.activity = new ToolActivity({
			theme,
			requestRender,
			maxHeight: 20,
			action: this.action,
			view: this.activityView(),
		});
	}

	update(view: CodeDisclosureView, nested: readonly PresentationComponent[] = []): void {
		this.view = view;
		this.action.update(view);
		this.updateBody(nested);
		this.activity.update(this.activityView(), this.action);
	}

	render(width: number): string[] {
		return this.activity.render(width);
	}
	get children() {
		return this.activity.children;
	}

	invalidate(): void {
		this.activity.invalidate();
	}

	dispose(): void {
		this.activity.dispose();
		this.tabs?.dispose();
	}

	private activityView() {
		const hasDetails = this.body.getChildren().length > 0;
		const full = this.tabs ? this.body : undefined;
		return {
			action: { verb: codeModeLabel(this.view), status: "succeeded" as const, marker: false as const },
			payload: hasDetails
				? {
						kind: "component" as const,
						preview: this.nestedBody,
						...(full ? { full } : {}),
					}
				: undefined,
			mode: this.view.initialMode === "details" && full ? ("full" as const) : ("preview" as const),
		};
	}

	private updateBody(nested: readonly PresentationComponent[]): void {
		if (this.view.code || this.view.result) {
			if (this.tabs) this.tabs.update(this.view.code, this.view.result);
			else this.tabs = new LazyCodeModeTabs(this.theme, this.view.code, this.view.result, this.requestRender);
		} else if (this.tabs) {
			this.tabs.dispose();
			this.tabs = undefined;
		}
		this.nestedBody.setChildren(nested);
		this.body.setChildren(this.tabs ? [this.tabs, ...nested] : nested);
	}
}

/** Delay both Shiki construction and rendering until the details tab is visible. */
class LazyCodeModeTabs implements PresentationComponent {
	private tabs: CodeModeTabs | undefined;

	constructor(
		private readonly theme: Theme,
		private code: string,
		private result: string,
		private readonly requestRender: () => void,
	) {}

	update(code: string, result: string): void {
		this.code = code;
		this.result = result;
		this.tabs?.update(code, result);
	}

	render(width: number): string[] {
		return this.ensureTabs().render(width);
	}

	handleInput(data: string): boolean {
		return this.tabs?.handleInput(data) ?? false;
	}

	onMouse(event: Parameters<TabBar["onMouse"]>[0]): boolean {
		return this.tabs?.onMouse(event) ?? false;
	}

	invalidate(): void {
		this.tabs?.invalidate();
	}

	dispose(): void {
		this.tabs?.invalidate();
		this.tabs = undefined;
	}

	private ensureTabs(): CodeModeTabs {
		if (!this.tabs) this.tabs = new CodeModeTabs(this.theme, this.code, this.result, this.requestRender);
		return this.tabs;
	}
}

class CodeModeAction implements PresentationComponent {
	constructor(
		private readonly theme: Theme,
		private view: CodeDisclosureView,
	) {}

	update(view: CodeDisclosureView): void {
		this.view = view;
	}

	render(width: number): string[] {
		const colors = tuiTheme(this.theme);
		return [
			colors.fg(
				"text.muted",
				truncateToWidth(`${icon("code-mode")} ${codeModeLabel(this.view)}`, Math.max(0, width), "…"),
			),
		];
	}

	invalidate(): void {}
}

class CodeModeTabs implements PresentationComponent {
	private readonly tabs: TabBar;
	private active = 0;
	private readonly code: SyntaxText;
	private readonly result: SyntaxText;
	private cachedWidth = -1;
	private cachedActive = -1;
	private knownContentHeight = 0;
	private cachedActiveLines: string[] | undefined;
	private cachedLines: string[] | undefined;

	constructor(theme: Theme, code: string, result: string, requestRender: () => void) {
		this.code = new SyntaxText({
			theme,
			text: code || "(no code)",
			path: ".js",
			maxRows: 500,
			requestRender,
		});
		this.result = new SyntaxText({
			theme,
			text: result ? prettify(result) : "(no result)",
			path: ".json",
			maxRows: 1_000,
			requestRender,
		});
		this.tabs = new TabBar(
			[
				{ id: "code", label: "Code" },
				{ id: "result", label: "Result" },
			],
			theme,
		);
		this.tabs.onChange = (_tab, index) => {
			this.active = index;
			this.cachedLines = undefined;
			requestRender();
		};
	}

	update(code: string, result: string): void {
		this.code.setText(code || "(no code)");
		this.result.setText(result ? prettify(result) : "(no result)");
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedWidth !== width) this.knownContentHeight = 0;
		const active = this.active === 0 ? this.code.render(width) : this.result.render(width);
		this.knownContentHeight = Math.max(this.knownContentHeight, active.length);
		if (
			this.cachedWidth === width &&
			this.cachedActive === this.active &&
			this.cachedActiveLines === active &&
			this.cachedLines
		) {
			return this.cachedLines;
		}
		const lines = [
			...this.tabs.render(width),
			...active,
			...Array.from({ length: this.knownContentHeight - active.length }, () => ""),
		];
		this.cachedWidth = width;
		this.cachedActive = this.active;
		this.cachedActiveLines = active;
		this.cachedLines = lines;
		return lines;
	}

	handleInput(data: string): boolean {
		return this.tabs.handleInput(data);
	}

	onMouse(event: Parameters<TabBar["onMouse"]>[0]): boolean {
		return event.row === 0 ? this.tabs.onMouse(event) : false;
	}

	invalidate(): void {
		this.tabs.invalidate();
		this.code.invalidate();
		this.result.invalidate();
		this.knownContentHeight = 0;
		this.cachedWidth = -1;
		this.cachedActive = -1;
		this.cachedActiveLines = undefined;
		this.cachedLines = undefined;
	}
}

function codeModeLabel(view: CodeDisclosureView): string {
	return `Code Mode · ${view.tool}${view.meta ? ` · ${sanitizeTuiField(view.meta)}` : ""}`;
}

function disclosureView(result: AgentToolResult<CodeModeToolDetails>, expanded: boolean): CodeDisclosureView {
	const details = result.details;
	const scriptError =
		details && typeof details === "object" && typeof details.scriptError === "string" ? details.scriptError : "";
	const output = [scriptOutput(result), scriptError].filter(Boolean).join("\n");
	const durationMs =
		details && typeof details === "object" && Number.isFinite(details.timing?.durationMs)
			? details.timing.durationMs
			: 0;
	return {
		tool: details?.tool === "wait" ? "wait" : "exec",
		code: codeText(details?.input) ?? "",
		result: output,
		meta: durationMs > 0 ? formatDuration(durationMs) : undefined,
		initialMode: expanded ? "details" : "summary",
	};
}

function prettify(text: string): string {
	try {
		return JSON.stringify(JSON.parse(text), null, 2);
	} catch {
		return text;
	}
}

class NestedCallView {
	private custom: NestedToolPresentationComponent | undefined;
	private fallback: ToolActivity | undefined;
	private hidden = false;
	private presentationKey: string;
	private readonly state = {};

	constructor(
		private readonly theme: Theme,
		private readonly requestRender: () => void,
		private trace: NestedToolTrace,
		private expanded: boolean,
		private readonly cwd: string,
		private readonly executionStarted: boolean,
		private readonly invalidateOwner: () => void,
		localOwner?: NestedCallView,
	) {
		this.presentationKey = tracePresentationKey(trace);
		this.route(localOwner);
	}

	get component(): PresentationComponent {
		return this;
	}

	update(trace: NestedToolTrace, expanded: boolean, localOwner?: NestedCallView): void {
		const previousKey = this.presentationKey;
		this.trace = trace;
		this.expanded = expanded;
		this.presentationKey = tracePresentationKey(trace);
		if (this.presentationKey !== previousKey) releaseTracePresentation(previousKey, this);
		this.route(localOwner);
	}

	dispose(): void {
		releaseTracePresentation(this.presentationKey, this);
		this.custom?.dispose?.();
		this.fallback?.dispose();
	}

	render(width: number): string[] {
		return this.hidden ? [] : (this.custom ?? this.fallback!).render(width);
	}

	invalidate(): void {
		(this.custom ?? this.fallback!)?.invalidate();
	}

	get children(): readonly PresentationComponent[] {
		if (this.hidden) return [];
		const component = this.custom ?? this.fallback;
		if (!component) return [];
		return "children" in component
			? ((component as PresentationComponent & { children: readonly PresentationComponent[] }).children ?? [])
			: [];
	}

	getSpans() {
		if (this.hidden) return [];
		const component = this.custom ?? this.fallback;
		return component && "getSpans" in component
			? (component as PresentationComponent & { getSpans(): readonly unknown[] }).getSpans()
			: [];
	}

	onMouse(event: TuiMouseEvent): boolean {
		if (this.hidden) return false;
		const component = this.custom ?? this.fallback;
		return component?.onMouse?.(event) ?? false;
	}

	handleViewportInput(data: string): boolean {
		if (this.hidden) return false;
		const component = this.custom ?? this.fallback;
		if (!component) return false;
		return (
			component.handleViewportInput?.(data) ??
			("handleInput" in component ? Boolean(component.handleInput?.(data)) : false)
		);
	}

	get ownerKey(): string {
		return this.presentationKey;
	}
	get currentTrace(): NestedToolTrace {
		return this.trace;
	}

	get isVisible(): boolean {
		return !this.hidden;
	}

	acceptContinuation(trace: NestedToolTrace): void {
		if (this.hidden || tracePresentationKey(trace) !== this.presentationKey) return;
		this.trace = trace;
		this.rebuild();
		this.invalidateOwner();
	}

	private route(localOwner?: NestedCallView): void {
		if (localOwner && localOwner !== this) {
			releaseTracePresentation(this.presentationKey, this);
			this.hidden = true;
			localOwner.acceptContinuation(this.trace);
			return;
		}
		this.hidden = !claimTracePresentation(this, isTranscriptTrace(this.trace));
		if (!this.hidden) this.rebuild();
	}

	private rebuild(): void {
		const adapter = getNestedToolAdapterRegistry().adapters.get(this.trace.name);
		const previous = this.custom;
		let next: NestedToolPresentationComponent | undefined;
		try {
			const candidate = adapter?.renderTrace?.(this.trace, {
				theme: this.theme,
				requestRender: () => {
					this.invalidateOwner();
					this.requestRender();
				},
				executionStarted: this.executionStarted,
				cwd: this.cwd,
				state: this.state,
				lastComponent: previous,
			});
			if (candidate && typeof candidate.render === "function" && typeof candidate.invalidate === "function")
				next = candidate;
		} catch {
			next = undefined;
		}
		if (previous && previous !== next) previous.dispose?.();
		this.custom = next;
		if (next) {
			this.fallback?.dispose();
			this.fallback = undefined;
			return;
		}
		const view = fallbackView(this.trace, this.expanded);
		if (this.fallback) this.fallback.update(view);
		else
			this.fallback = new ToolActivity({
				theme: this.theme,
				requestRender: this.requestRender,
				view,
			});
	}
}

const MAX_TRACKED_TRACE_PRESENTATIONS = 1_000;
const tracePresentationOwner = new Map<string, NestedCallView>();

function claimTracePresentation(view: NestedCallView, present: boolean): boolean {
	const owner = tracePresentationOwner.get(view.ownerKey);
	if (owner && owner !== view) {
		owner.acceptContinuation(view.currentTrace);
		return false;
	}
	if (!present) return false;
	tracePresentationOwner.set(view.ownerKey, view);
	while (tracePresentationOwner.size > MAX_TRACKED_TRACE_PRESENTATIONS) {
		const oldest = tracePresentationOwner.keys().next().value;
		if (oldest === undefined) break;
		tracePresentationOwner.delete(oldest);
	}
	return true;
}

function releaseTracePresentation(id: string, view: NestedCallView): void {
	if (tracePresentationOwner.get(id) === view) tracePresentationOwner.delete(id);
}

function fallbackView(trace: NestedToolTrace, expanded: boolean) {
	const status = nestedStatus(trace);
	const output = traceOutput(trace);
	return {
		action: {
			verb:
				trace.status === "running"
					? `Running ${trace.name}`
					: trace.status === "error"
						? `Failed ${trace.name}`
						: `Used ${trace.name}`,
			status,
			detail: compactInput(trace.input),
			meta: trace.durationMs === undefined ? undefined : [formatDuration(trace.durationMs)],
		},
		running: trace.status === "running",
		failure: trace.error,
		payload: output ? { kind: "text" as const, text: output, revision: output.length } : undefined,
		mode: expanded ? ("full" as const) : ("preview" as const),
	};
}

function nestedStatus(trace: NestedToolTrace): ToolTranscriptStatus {
	if (trace.status === "error") return "failed";
	return trace.status === "running" ? "running" : "succeeded";
}

function scriptOutput(result: AgentToolResult<CodeModeToolDetails>): string {
	const texts = (Array.isArray(result.content) ? result.content : []).flatMap((item) => {
		if (!item || typeof item !== "object") return [];
		const type = Reflect.get(item, "type");
		const text = Reflect.get(item, "text");
		return type === "text" && typeof text === "string" ? [text] : [];
	});
	const traces = restoredNestedCalls(result.details);
	if (result.details?.notification) return texts.join("\n");
	if (traces.length > 0 && texts[0] === nestedSummary(traces)) texts.shift();
	if (texts[0] === resultStatusText(result.details)) texts.shift();
	return texts.join("\n");
}

function hasTranscriptResult(result: AgentToolResult<CodeModeToolDetails>, hostError: boolean): boolean {
	if (hostError || result.details?.isError || result.details?.scriptError) return true;
	if (result.details?.notification) return true;
	if (result.details?.tool === "wait") return false;
	const traces = restoredNestedCalls(result.details);
	if (traces.length > 0 && traces.every((trace) => !isTranscriptTrace(trace))) return false;
	if (visibleNestedCalls(result.details).length > 0) return true;
	if (scriptOutput(result)) return true;
	return (Array.isArray(result.content) ? result.content : []).some(
		(item) => item && typeof item === "object" && Reflect.get(item, "type") !== "text",
	);
}

function hasCodeModeFailure(result: AgentToolResult<CodeModeToolDetails>, hostError: boolean): boolean {
	return Boolean(hostError || result.details?.isError || result.details?.scriptError);
}

function visibleNestedCalls(details: CodeModeToolDetails | undefined): NestedToolTrace[] {
	return restoredNestedCalls(details).filter(isTranscriptTrace);
}

function isTranscriptTrace(trace: NestedToolTrace): boolean {
	return trace.name !== "write_stdin" || trace.status === "error";
}

function tracePresentationKey(trace: NestedToolTrace): string {
	const adapter = getNestedToolAdapterRegistry().adapters.get(trace.name);
	try {
		const key = adapter?.presentationKey?.(trace);
		if (!key) return trace.id;
		// Session ids can repeat; the trace prefix scopes continuations to one Code Mode runtime.
		const runtime = /^(.*):\d+:tool-\d+$/u.exec(trace.id)?.[1];
		return runtime ? `${runtime}/${key}` : key;
	} catch {
		return trace.id;
	}
}

function nestedSummary(traces: readonly NestedToolTrace[]): string {
	return traces
		.map(
			(trace) =>
				`• ${trace.status === "running" ? "Running" : trace.status === "error" ? "Failed" : "Ran"} ${trace.name}`,
		)
		.join("\n");
}

function resultStatusText(details: CodeModeToolDetails): string {
	if (!details || typeof details !== "object") return "Script failed";
	if (details.scriptError) return `Script error: ${details.scriptError}`;
	if (details.status === "yielded")
		return `Still running (exec cell "${details.cellId}"). Use wait near expected completion.`;
	if (details.status === "terminated") return "Script terminated";
	return "Script completed";
}

// type-boundary: restored Code Mode details may predate the current trace schema; this validator narrows each entry.
type RestoredTraceValue = unknown;

function restoredNestedCalls(details: CodeModeToolDetails | undefined): NestedToolTrace[] {
	if (!details || typeof details !== "object") return [];
	const value = Reflect.get(details, "nestedCalls") as RestoredTraceValue;
	if (!Array.isArray(value)) return [];
	const unique = new Map<string, NestedToolTrace>();
	for (const trace of value) if (isNestedToolTrace(trace)) unique.set(trace.id, trace);
	return [...unique.values()];
}

function isNestedToolTrace(value: RestoredTraceValue): value is NestedToolTrace {
	if (!value || typeof value !== "object") return false;
	const status = Reflect.get(value, "status");
	const error = Reflect.get(value, "error");
	return (
		Reflect.get(value, "version") === 1 &&
		typeof Reflect.get(value, "id") === "string" &&
		typeof Reflect.get(value, "name") === "string" &&
		(status === "running" || status === "done" || status === "error") &&
		(error === undefined || typeof error === "string")
	);
}

function traceOutput(trace: NestedToolTrace): string {
	if (trace.error) return "";
	const content = trace.result?.content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((item) => {
			if (!item || typeof item !== "object") return [];
			const type = Reflect.get(item, "type");
			const text = Reflect.get(item, "text");
			return type === "text" && typeof text === "string" ? [text] : [];
		})
		.join("\n");
}

function codeText(input: unknown): string | undefined {
	if (!input || typeof input !== "object") return undefined;
	const code = Reflect.get(input, "code");
	return typeof code === "string" ? code : undefined;
}

function compactInput(value: unknown): string | undefined {
	if (typeof value === "string") return compact(value, 100);
	if (!value || typeof value !== "object") return value === undefined ? undefined : compact(String(value), 100);
	const command = Reflect.get(value, "cmd") ?? Reflect.get(value, "command");
	return typeof command === "string" ? compact(command, 100) : undefined;
}

function compact(text: string, maximum: number): string {
	const singleLine = text.replace(/\s+/g, " ").trim();
	return singleLine.length <= maximum ? singleLine : `${singleLine.slice(0, Math.max(0, maximum - 1))}…`;
}

function formatDuration(durationMs: number): string {
	return durationMs < 1_000 ? `${Math.max(0, Math.round(durationMs))}ms` : `${(durationMs / 1_000).toFixed(2)}s`;
}
