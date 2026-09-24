import type { AgentToolResult, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
	getNestedToolAdapterRegistry,
	type NestedToolAdapter,
	type NestedToolDetails,
	type NestedToolInput,
	type NestedToolInvocationContext,
	type NestedToolPresentationContext,
	type NestedToolPresentationTrace,
} from "./nested-tools.ts";

export interface CodeModeFunctionToolOptions<TDetails> {
	isActive?(): boolean;
	outputSchema?: NestedToolInput;
	resultValue?(result: AgentToolResult<TDetails>): NestedToolDetails;
}

// type-boundary: ToolDefinition schemas own validation before this bridge forwards prepared arguments.
type ToolInputBoundary = unknown;

interface FunctionToolRenderContext<TState, TInput> {
	args: TInput;
	toolCallId: string;
	invalidate(): void;
	lastComponent: Component | undefined;
	state: TState;
	cwd: string;
	executionStarted: boolean;
	argsComplete: boolean;
	isPartial: boolean;
	expanded: boolean;
	showImages: boolean;
	isError: boolean;
}

interface FunctionTool<TInput, TDetails, TState, TParameters, TContext, TTheme> {
	name: string;
	description: string;
	parameters: TParameters;
	prepareArguments?(input: ToolInputBoundary): TInput;
	execute(
		toolCallId: string,
		input: TInput,
		signal: AbortSignal | undefined,
		onUpdate: ((result: AgentToolResult<TDetails>) => void) | undefined,
		context: TContext,
	): Promise<AgentToolResult<TDetails>>;
	renderCall?(args: TInput, theme: TTheme, context: FunctionToolRenderContext<TState, TInput>): Component;
	renderResult?(
		result: AgentToolResult<TDetails>,
		options: ToolRenderResultOptions,
		theme: TTheme,
		context: FunctionToolRenderContext<TState, TInput>,
	): Component;
}

/**
 * Register a normal Pi function tool for nested Code Mode execution.
 *
 * Execution, argument preparation, and both presentation phases are derived
 * from the ToolDefinition so direct and nested calls cannot drift.
 */
export function registerCodeModeFunctionTool<TInput, TDetails, TState, TParameters, TContext, TTheme>(
	tool: FunctionTool<TInput, TDetails, TState, TParameters, TContext, TTheme>,
	options: CodeModeFunctionToolOptions<TDetails> = {},
): () => void {
	const adapter = codeModeFunctionToolAdapter(tool, options);
	return getNestedToolAdapterRegistry().register(adapter);
}

export function codeModeFunctionToolAdapter<TInput, TDetails, TState, TParameters, TContext, TTheme>(
	tool: FunctionTool<TInput, TDetails, TState, TParameters, TContext, TTheme>,
	options: CodeModeFunctionToolOptions<TDetails> = {},
): NestedToolAdapter {
	return {
		name: tool.name,
		kind: "function",
		owner: tool,
		...(options.isActive ? { isActive: options.isActive } : {}),
		description: tool.description,
		parameters: tool.parameters,
		...(options.outputSchema ? { outputSchema: options.outputSchema } : {}),
		...(tool.prepareArguments ? { prepareInput: (input: NestedToolInput) => tool.prepareArguments!(input) } : {}),
		...(tool.renderCall || tool.renderResult
			? { renderTrace: (trace, context) => renderToolDefinitionTrace(tool, trace, context) }
			: {}),
		...(options.resultValue
			? {
					resultValue: (result: AgentToolResult<NestedToolDetails>) =>
						options.resultValue!(result as AgentToolResult<TDetails>),
				}
			: {}),
		invoke(input: NestedToolInput, context: NestedToolInvocationContext, signal: AbortSignal) {
			if (options.isActive?.() === false) throw new Error(`${tool.name} is unavailable in the current session mode`);
			return tool.execute(
				context.toolCallId,
				input as TInput,
				signal,
				context.onUpdate,
				// Pi core is a peer dependency. A packaged tool can carry the same
				// public context type from a different installed Pi version.
				context.extensionContext as TContext,
			) as Promise<AgentToolResult<NestedToolDetails>>;
		},
	};
}

function renderToolDefinitionTrace<TInput, TDetails, TState, TParameters, TContext, TTheme>(
	tool: FunctionTool<TInput, TDetails, TState, TParameters, TContext, TTheme>,
	trace: NestedToolPresentationTrace,
	context: NestedToolPresentationContext,
): Component | undefined {
	const args = trace.input as TInput;
	const renderContext = toolRenderContext<TInput, TState>(args, trace, context);
	if (trace.result && tool.renderResult) {
		const options: ToolRenderResultOptions = { expanded: false, isPartial: trace.status === "running" };
		return tool.renderResult(
			toolResult<TDetails>(trace.result.content, trace.result.details),
			options,
			context.theme as TTheme,
			{
				...renderContext,
				executionStarted: context.executionStarted !== false,
			},
		);
	}
	// An error without a typed result belongs to Code Mode's generic failure
	// presentation. Returning a call component here would hide that failure.
	if (trace.status === "error") return undefined;
	if (trace.status === "running" && tool.renderCall) {
		return tool.renderCall(args, context.theme as TTheme, {
			...renderContext,
			executionStarted: context.executionStarted !== false,
		});
	}
	return undefined;
}

function toolRenderContext<TInput, TState>(
	args: TInput,
	trace: NestedToolPresentationTrace,
	context: NestedToolPresentationContext,
): FunctionToolRenderContext<TState, TInput> {
	return {
		args,
		toolCallId: trace.id,
		invalidate: context.requestRender,
		lastComponent: context.lastComponent as Component | undefined,
		state: context.state,
		cwd: context.cwd,
		executionStarted: context.executionStarted !== false,
		argsComplete: true,
		isPartial: trace.status === "running",
		expanded: false,
		showImages: false,
		isError: trace.status === "error",
	} as FunctionToolRenderContext<TState, TInput>;
}

function toolResult<TDetails>(
	content: readonly NestedToolDetails[],
	details: NestedToolDetails | undefined,
): AgentToolResult<TDetails> {
	return {
		content: content.flatMap(traceContentItem),
		// type-boundary: bounded trace details came from this ToolDefinition; its renderResult is the immediate validator.
		details: details as TDetails,
	};
}

function traceContentItem(value: NestedToolDetails): AgentToolResult<never>["content"] {
	if (!value || typeof value !== "object" || Array.isArray(value)) return [];
	const type = Reflect.get(value, "type");
	const text = Reflect.get(value, "text");
	if (type === "text" && typeof text === "string") return [{ type, text }];
	return [];
}
