import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { ComponentStack } from "@luan.sh/pi-libtui";
import type { TuiMouseEvent } from "@luan.sh/pi-libtui/mouse";
import { ToolActivity, type ToolTranscriptStatus } from "@luan.sh/pi-libtui/tool";
import { getNestedToolAdapterRegistry, type NestedToolPresentationComponent } from "../protocol/nested-tools.ts";
import type { CodeModeToolDetails, NestedToolTrace } from "../protocol/types.ts";
import { nestedSummary, resultStatusText } from "../tools/result.ts";

import { CodeModeDisclosure, LazyCodeModeResult, type CodeDisclosureView } from "./code-disclosure.ts";

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
		const traces = restoredNestedCalls(this.result.details);
		const nested = this.rebuildNested(traces);
		if (!hasTranscriptResult(this.result, this.hostError)) {
			this.stack.setChildren([]);
			return;
		}
		if (!this.expanded && !hasCodeModeFailure(this.result, this.hostError)) {
			const output = traces.length === 0 ? scriptOutput(this.result) : "";
			this.updateCompactResult(output);
			this.stack.setChildren(this.compactResult ? [...nested, this.compactResult] : nested);
			return;
		}

		// Keep the nested rows inside the disclosure payload. The outer activity
		// owns the single fold state and bounded viewport for the complete result;
		// nested activities still retain their own row-level interaction contracts.
		this.disclosure.update(disclosureView(this.result, this.expanded), nested);
		this.stack.setChildren([this.disclosure]);
	}

	private rebuildNested(traces: readonly NestedToolTrace[]): PresentationComponent[] {
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
					{
						theme: this.theme,
						requestRender: this.requestRender,
						cwd: this.cwd,
						executionStarted: this.executionStarted,
						continuation: this.result.details?.tool === "wait",
						invalidateOwner: () => this.disclosure.invalidate(),
					},
					trace,
					this.expanded,
					localOwner,
				);
				this.nested.set(trace.id, view);
			}
			if (!localOwner && view.isVisible) localOwners.set(view.ownerKey, view);
			if (view.isVisible && isTranscriptTrace(trace)) nested.push(view.component);
		}
		return nested;
	}

	private updateCompactResult(output: string): void {
		if (output) {
			if (this.compactResult) this.compactResult.update(output);
			else this.compactResult = new LazyCodeModeResult(this.theme, output, this.requestRender);
		} else if (this.compactResult) {
			this.compactResult.dispose();
			this.compactResult = undefined;
		}
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
	const { content: leftContent, traces: leftTraces, ...leftFields } = left;
	const { content: rightContent, traces: rightTraces, ...rightFields } = right;
	return (
		sameFields(leftFields, rightFields) &&
		sameContentSnapshot(leftContent, rightContent) &&
		leftTraces.length === rightTraces.length &&
		leftTraces.every((trace, index) => sameNestedTraceSnapshot(trace, rightTraces[index]!))
	);
}

function sameNestedTraceSnapshot(left: NestedTraceSnapshot, right: NestedTraceSnapshot): boolean {
	const { resultContent: leftContent, ...leftFields } = left;
	const { resultContent: rightContent, ...rightFields } = right;
	return sameFields(leftFields, rightFields) && sameContentSnapshot(leftContent, rightContent);
}

function sameContentSnapshot(left: readonly ContentItemSnapshot[], right: readonly ContentItemSnapshot[]): boolean {
	return left.length === right.length && left.every((item, index) => sameFields(item, right[index]!));
}

/** Snapshot records have fixed keys; compare references without traversing tool-owned values. */
function sameFields<T extends object>(left: T, right: T): boolean {
	return (Object.keys(left) as (keyof T)[]).every((key) => left[key] === right[key]);
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

interface NestedCallHost {
	readonly theme: Theme;
	readonly requestRender: () => void;
	readonly cwd: string;
	readonly executionStarted: boolean;
	readonly continuation: boolean;
	readonly invalidateOwner: () => void;
}

class NestedCallView {
	readonly originId: string;
	private renderer:
		| { kind: "custom"; component: NestedToolPresentationComponent }
		| { kind: "fallback"; component: ToolActivity }
		| undefined;
	private hidden = false;
	private presentationKey: string;
	private readonly state = {};

	constructor(
		private readonly host: NestedCallHost,
		private trace: NestedToolTrace,
		private expanded: boolean,
		localOwner?: NestedCallView,
	) {
		this.originId = trace.id;
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
		this.renderer?.component.dispose?.();
	}

	render(width: number): string[] {
		return this.hidden ? [] : (this.renderer?.component.render(width) ?? []);
	}

	invalidate(): void {
		this.renderer?.component.invalidate();
	}

	get children(): readonly PresentationComponent[] {
		if (this.hidden) return [];
		const component = this.renderer?.component;
		if (!component) return [];
		return "children" in component
			? ((component as PresentationComponent & { children: readonly PresentationComponent[] }).children ?? [])
			: [];
	}

	getSpans() {
		if (this.hidden) return [];
		const component = this.renderer?.component;
		return component && "getSpans" in component
			? (component as PresentationComponent & { getSpans(): readonly unknown[] }).getSpans()
			: [];
	}

	onMouse(event: TuiMouseEvent): boolean {
		if (this.hidden) return false;
		const component = this.renderer?.component;
		return component?.onMouse?.(event) ?? false;
	}

	handleViewportInput(data: string): boolean {
		if (this.hidden) return false;
		const component = this.renderer?.component;
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
		this.host.invalidateOwner();
	}

	private route(localOwner?: NestedCallView): void {
		if (localOwner && localOwner !== this) {
			releaseTracePresentation(this.presentationKey, this);
			this.hidden = true;
			localOwner.acceptContinuation(this.trace);
			return;
		}
		this.hidden = !claimTracePresentation(this, isTranscriptTrace(this.trace), !this.host.continuation);
		if (!this.hidden) this.rebuild();
	}

	private rebuild(): void {
		const custom = this.renderCustom();
		if (custom) {
			if (this.renderer?.component !== custom) this.renderer?.component.dispose?.();
			this.renderer = { kind: "custom", component: custom };
			return;
		}
		const view = fallbackView(this.trace, this.expanded);
		if (this.renderer?.kind === "fallback") {
			this.renderer.component.update(view);
			return;
		}
		this.renderer?.component.dispose?.();
		this.renderer = {
			kind: "fallback",
			component: new ToolActivity({ theme: this.host.theme, requestRender: this.host.requestRender, view }),
		};
	}

	private renderCustom(): NestedToolPresentationComponent | undefined {
		const adapter = getNestedToolAdapterRegistry().adapters.get(this.trace.name);
		try {
			const candidate = adapter?.renderTrace?.(this.trace, {
				theme: this.host.theme,
				requestRender: () => {
					this.host.invalidateOwner();
					this.host.requestRender();
				},
				executionStarted: this.host.executionStarted,
				cwd: this.host.cwd,
				state: this.state,
				lastComponent: this.renderer?.kind === "custom" ? this.renderer.component : undefined,
			});
			if (candidate && typeof candidate.render === "function" && typeof candidate.invalidate === "function")
				return candidate;
		} catch {
			// Optional adapters may fail; the trace still has a built-in presentation.
		}
		return undefined;
	}
}

const MAX_TRACKED_TRACE_PRESENTATIONS = 1_000;
const tracePresentationOwner = new Map<string, NestedCallView>();

function claimTracePresentation(view: NestedCallView, present: boolean, replaceOwner: boolean): boolean {
	const owner = tracePresentationOwner.get(view.ownerKey);
	// Pi can rebuild the same transcript without disposing its old components.
	// A new instance of the owning call replaces that stale owner; only distinct
	// calls are continuations. originId stays stable when a wait updates the trace.
	if (owner && owner !== view && (!replaceOwner || owner.originId !== view.originId)) {
		owner.acceptContinuation(view.currentTrace);
		return false;
	}
	if (!present) return false;
	if (owner && owner !== view) owner.dispose();
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
	const texts = textContent(result.content);
	const traces = restoredNestedCalls(result.details);
	if (result.details?.notification) return texts.join("\n");
	if (traces.length > 0 && texts[0] === nestedSummary(traces)) texts.shift();
	if (texts[0] === resultStatusText(result.details)) texts.shift();
	return texts.join("\n");
}

function hasTranscriptResult(result: AgentToolResult<CodeModeToolDetails>, hostError: boolean): boolean {
	if (hasCodeModeFailure(result, hostError)) return true;
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
	return trace.error ? "" : textContent(trace.result?.content).join("\n");
}

// type-boundary: restored Pi content may use older schemas; textContent validates text items before rendering.
type RestoredContent = unknown;

function textContent(content: RestoredContent): string[] {
	if (!Array.isArray(content)) return [];
	return content.flatMap((item) => {
		if (!item || typeof item !== "object") return [];
		const type = Reflect.get(item, "type");
		const text = Reflect.get(item, "text");
		return type === "text" && typeof text === "string" ? [text] : [];
	});
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
