import { type Theme, ToolExecutionComponent, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { type Component, Container, type TUI } from "@earendil-works/pi-tui";
import { ComponentStack } from "../component-stack.ts";
import { SyntaxText } from "../syntax.ts";
import { ToolAction } from "../tool/action.ts";
import { ToolActivity } from "../tool/activity.ts";
import {
	jsonObject,
	type NestedPresentationSnapshot,
	type NestedToolResults,
	type PresentationJson,
	readNestedPresentation,
} from "./nested-tool-results.ts";

export type NativeToolRenderers = NonNullable<ConstructorParameters<typeof ToolExecutionComponent>[4]>;
export interface PresentationHost {
	tui: TUI;
	nested: NestedToolResults;
	definition(name: string): NativeToolRenderers | undefined;
	history(parent: string): NestedPresentationSnapshot | undefined;
	track(component: CodeModePresentation): void;
}
interface RenderContext {
	args: { code?: string; query?: string };
	toolCallId: string;
	cwd: string;
	isError: boolean;
	expanded: boolean;
	executionStarted: boolean;
	lastComponent?: Component;
	invalidate(): void;
}
// type-boundary: Pi's renderer supplies untyped arguments; orchestrationArgs narrows code/query once.
type UntrustedOrchestrationArgs = unknown;

function orchestrationArgs(value: UntrustedOrchestrationArgs): RenderContext["args"] {
	if (!value || typeof value !== "object") return {};
	const code: UntrustedOrchestrationArgs = Reflect.get(value, "code");
	const query: UntrustedOrchestrationArgs = Reflect.get(value, "query");
	return {
		...(typeof code === "string" ? { code } : {}),
		...(typeof query === "string" ? { query } : {}),
	};
}
interface ScriptResult {
	content: { type: string; text?: string }[];
	details?: PresentationJson;
}

export function nativeOrchestrationRenderers(
	name: "codemode" | "tool_search",
	host: PresentationHost,
): NativeToolRenderers {
	return {
		renderShell: "self",
		renderCall: () => new Container(),
		renderResult(result: ScriptResult, options: ToolRenderResultOptions, theme: Theme, nativeContext) {
			const context: RenderContext = { ...nativeContext, args: orchestrationArgs(nativeContext.args) };
			if (name === "tool_search")
				return ToolActivity.reuse(context.lastComponent, {
					theme,
					requestRender: context.invalidate,
					view: {
						action: {
							verb: "Search tools",
							detail: context.args.query,
							status: context.isError ? "failed" : "succeeded",
						},
						payload: { kind: "text", text: scriptOutput(result), revision: 0 },
						mode: options.expanded ? "full" : "preview",
					},
				});
			const view =
				context.lastComponent instanceof CodeModePresentation
					? context.lastComponent
					: new CodeModePresentation(host, theme, context);
			view.update(result, options.isPartial, options.expanded, context.isError);
			return view;
		},
	};
}

function scriptOutput(result: ScriptResult): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("")
		.replace(/^Script (?:completed|failed)\nWall time [\d.]+ seconds\nOutput:\n/, "")
		.trim();
}

/** Same nested ToolDefinitions as direct calls; source and wrapper results stay behind disclosure. */
export class CodeModePresentation implements Component {
	private readonly stack = new ComponentStack();
	private readonly childrenById = new Map<string, ToolExecutionComponent>();
	private summary: ToolActivity | undefined;
	private result: ScriptResult = { content: [] };
	private partial = true;
	private expanded = false;
	private failed = false;
	private revision = 0;
	private readonly removeListener: () => void;

	constructor(
		private readonly host: PresentationHost,
		private readonly theme: Theme,
		private readonly context: RenderContext,
	) {
		host.track(this);
		this.removeListener = host.nested.watch(context.toolCallId, context.invalidate);
	}
	update(result: ScriptResult, partial: boolean, expanded: boolean, failed: boolean): void {
		this.result = result;
		this.partial = partial;
		this.expanded = expanded;
		this.failed = failed;
		this.revision++;
		this.rebuild();
	}
	private rebuild(): void {
		const saved = jsonObject(this.result.details)
			? readNestedPresentation(this.result.details.libtuiNestedCalls)
			: undefined;
		const snapshot =
			this.host.nested.get(this.context.toolCallId) ??
			saved ??
			this.host.history(this.context.toolCallId) ??
			this.historicalCalls();
		const children: Component[] = [];
		for (const call of snapshot.calls) {
			if (!call.result && call.status !== "running") {
				children.push(
					new ToolAction({
						theme: this.theme,
						view: {
							verb: call.name,
							detail: typeof call.args.cmd === "string" ? call.args.cmd : undefined,
							status: call.status,
						},
					}),
				);
				continue;
			}
			let view = this.childrenById.get(call.id);
			if (!view) {
				view = new ToolExecutionComponent(
					call.name,
					call.id,
					call.args,
					{ showImages: false },
					this.host.definition(call.name),
					this.host.tui,
					this.context.cwd,
				);
				view.setArgsComplete();
				if (this.context.executionStarted) view.markExecutionStarted();
				this.childrenById.set(call.id, view);
			}
			if (call.result) view.updateResult(call.result, call.status === "running");
			view.setExpanded(this.expanded);
			children.push(view);
		}
		const output = scriptOutput(this.result);
		if (this.expanded && this.context.args.code)
			children.unshift(
				new SyntaxText({
					theme: this.theme,
					text: this.context.args.code,
					path: "script.js",
					requestRender: this.context.invalidate,
				}),
			);
		if (snapshot.omitted > 0)
			children.push(
				new ToolAction({
					theme: this.theme,
					view: { verb: `${snapshot.omitted} nested presentations omitted by the size limit`, status: "warning" },
				}),
			);
		if (snapshot.calls.length === 0 || snapshot.omitted > 0 || this.expanded || this.failed) {
			this.summary = ToolActivity.reuse(this.summary, {
				theme: this.theme,
				requestRender: this.context.invalidate,
				view: {
					action: { verb: "Code Mode", status: this.failed ? "failed" : this.partial ? "running" : "succeeded" },
					running: this.partial,
					...(output ? { payload: { kind: "text" as const, text: output, revision: this.revision } } : {}),
					mode: this.expanded ? "full" : "preview",
				},
			});
			children.push(this.summary);
		} else {
			this.summary?.dispose();
			this.summary = undefined;
		}
		this.stack.setChildren(children);
	}
	private historicalCalls(): NestedPresentationSnapshot {
		const calls: NestedPresentationSnapshot["calls"] = [];
		if (jsonObject(this.result.details) && Array.isArray(this.result.details.calls)) {
			for (const call of this.result.details.calls) {
				if (
					!jsonObject(call) ||
					typeof call.id !== "string" ||
					typeof call.name !== "string" ||
					typeof call.args !== "string"
				)
					continue;
				let args: PresentationJson = {};
				try {
					args = JSON.parse(call.args);
				} catch {
					/* Pi may have truncated historical arguments. */
				}
				if (!jsonObject(args)) args = {};
				const error = typeof call.error === "string" ? call.error : "Nested call failed";
				calls.push({
					id: call.id,
					name: call.name,
					args,
					status: call.status === "running" ? "running" : call.status === "ok" ? "succeeded" : "failed",
					...(call.status === "error" ? { result: { content: [{ type: "text", text: error }], isError: true } } : {}),
				});
			}
		}
		return { version: 1, calls, omitted: 0 };
	}
	get children(): readonly Component[] {
		return this.stack.getChildren();
	}
	getSpans() {
		return this.stack.getSpans();
	}
	render(width: number): string[] {
		return this.stack.render(width);
	}
	invalidate(): void {
		this.rebuild();
		this.stack.invalidate();
	}
	dispose(): void {
		this.removeListener();
		this.summary?.dispose();
		for (const child of this.childrenById.values()) {
			disposeTree(child);
		}
	}
}

function disposeTree(component: Component, visited = new Set<Component>()): void {
	if (visited.has(component)) return;
	visited.add(component);
	const node = component as Component & { dispose?(): void; children?: readonly Component[] };
	if (node.dispose) node.dispose();
	else for (const child of node.children ?? []) disposeTree(child, visited);
}
