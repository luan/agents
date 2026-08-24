import { randomUUID } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { DelegateRequestMessage } from "../host/protocol.ts";
import { runNestedToolPreflights } from "../protocol/preflights.ts";
import type {
	CodeModeToolDetails,
	NestedToolAdapter,
	NestedToolTrace,
	RuntimeResponse,
	ToolExecutionContext,
} from "../protocol/types.ts";
import {
	boundTraceResult,
	boundTraceValue,
	cloneTrace,
	sanitizeTraceInput,
	truncateTraceError,
} from "./trace-values.ts";

type SendMessage = (message: unknown) => void;
const MAX_NESTED_TRACE_COUNT = 50;

export class CodeModeDelegateRuntime {
	private readonly runtimeId = randomUUID();
	private generation = 0;
	private readonly contexts = new Map<string, ToolExecutionContext>();
	private readonly tools = new Map<string, Map<string, NestedToolAdapter>>();
	private readonly controllers = new Map<number, AbortController>();
	private readonly traces = new Map<string, NestedToolTrace[]>();
	private readonly traceSnapshots = new WeakMap<
		NestedToolTrace,
		{
			status: NestedToolTrace["status"];
			durationMs: number | undefined;
			result: NestedToolTrace["result"];
			value: NestedToolTrace["value"];
			error: string | undefined;
			snapshot: NestedToolTrace;
		}
	>();

	constructor(private readonly send: SendMessage) {}

	bindCell(cellId: string, context: ToolExecutionContext, tools?: Map<string, NestedToolAdapter>): void {
		this.contexts.set(cellId, context);
		if (tools) this.tools.set(cellId, tools);
	}

	updateCellContext(cellId: string, context: ToolExecutionContext): void {
		this.contexts.set(cellId, context);
	}

	closeCell(cellId: string): void {
		this.contexts.delete(cellId);
		this.tools.delete(cellId);
		// The terminal response and cell/closed notification can cross on the transport.
		// attach() owns trace cleanup so the final response can still include nested calls.
	}

	clear(): void {
		this.generation += 1;
		for (const controller of this.controllers.values()) controller.abort();
		this.controllers.clear();
		this.contexts.clear();
		this.tools.clear();
		this.traces.clear();
	}

	cancel(id: number): void {
		this.controllers.get(id)?.abort();
		this.controllers.delete(id);
	}

	handleRequest(message: DelegateRequestMessage): void {
		if (this.controllers.has(message.id)) throw new Error(`Duplicate nested tool request: ${message.id}`);
		const controller = new AbortController();
		this.controllers.set(message.id, controller);
		void this.invoke(message, controller, this.generation);
	}

	attach(response: RuntimeResponse): RuntimeResponse {
		const nestedCalls = this.traces.get(response.cellId)?.map((trace) => this.traceSnapshot(trace));
		if (response.kind !== "yielded") this.traces.delete(response.cellId);
		return nestedCalls?.length ? { ...response, nestedCalls } : response;
	}

	private async invoke(
		message: DelegateRequestMessage,
		controller: AbortController,
		generation: number,
	): Promise<void> {
		let trace: NestedToolTrace | undefined;
		let traceContext: ToolExecutionContext | undefined;
		let traceCellId: string | undefined;
		try {
			if (message.request.type === "notification/send") {
				const context = this.contexts.get(message.request.cellId);
				if (!context) throw new Error("Code Mode notification cell is unavailable");
				const text = message.request.text.slice(0, 16_384);
				const presentation = context.presentation;
				context.onUpdate?.({
					content: [{ type: "text", text }],
					details: {
						version: 1,
						tool: presentation?.tool ?? "exec",
						status: "running",
						cellId: message.request.cellId,
						isError: false,
						input: sanitizeTraceInput(presentation?.input),
						timing: {
							startedAtMs: presentation?.startedAtMs ?? Date.now(),
							durationMs: presentation ? Date.now() - presentation.startedAtMs : 0,
						},
						maxOutputTokens: presentation?.maxOutputTokens ?? 0,
						output: {
							textChars: text.length,
							imageCount: 0,
							imageChars: 0,
							audioCount: 0,
							audioChars: 0,
							textTruncated: text.length < message.request.text.length,
							imagesOmitted: 0,
						},
						nestedCalls: this.traces.get(message.request.cellId)?.map(cloneTrace) ?? [],
						notification: { text, truncated: text.length < message.request.text.length },
					} satisfies CodeModeToolDetails,
				});
				this.respond(message.id, { status: "ok", value: { type: "notification/delivered" } });
				return;
			}

			const invocation = message.request.invocation;
			const toolName = invocation.tool_name.name;
			const adapter = this.tools.get(invocation.cell_id)?.get(toolName);
			const context = this.contexts.get(invocation.cell_id);
			if (!adapter) throw new Error(`No nested adapter registered for ${toolName}`);
			if (!context) throw new Error("Code Mode cell context is unavailable");
			const input = adapter.prepareInput ? adapter.prepareInput(invocation.input) : invocation.input;
			const toolCallId = `${this.runtimeId}:${invocation.cell_id}:${invocation.runtime_tool_call_id || message.id}`;
			traceCellId = invocation.cell_id;
			traceContext = context;
			trace = this.startTrace(traceCellId, toolCallId, adapter, input);
			this.emitTraceUpdate(traceCellId, traceContext);
			await runNestedToolPreflights({
				toolName,
				input,
				cwd: context.cwd,
				toolCallId,
				extensionContext: context.extensionContext,
				signal: controller.signal,
			});
			controller.signal.throwIfAborted();
			const result = await adapter.invoke(
				input,
				{
					...context,
					toolCallId,
					onUpdate: (update) => {
						if (generation !== this.generation) return;
						trace!.result = boundTraceResult(update);
						this.emitTraceUpdate(traceCellId!, traceContext!);
					},
				},
				controller.signal,
			);
			if (generation !== this.generation) return;
			trace.status = "done";
			trace.durationMs = Date.now() - trace.startedAtMs;
			trace.result = boundTraceResult(result);
			const nestedValue = normalizeToolResult(result, adapter.resultValue);
			trace.value = boundTraceValue(nestedValue);
			this.emitTraceUpdate(traceCellId, traceContext);
			this.respond(message.id, {
				status: "ok",
				value: { type: "tool/result", result: nestedValue },
			});
		} catch (error) {
			if (generation !== this.generation) return;
			if (trace && traceCellId && traceContext) {
				trace.status = "error";
				trace.durationMs = Date.now() - trace.startedAtMs;
				trace.error = truncateTraceError(error);
				this.emitTraceUpdate(traceCellId, traceContext);
			}
			this.respond(message.id, {
				status: "error",
				message: error instanceof Error ? error.message : String(error),
			});
		} finally {
			if (this.controllers.get(message.id) === controller) this.controllers.delete(message.id);
		}
	}

	private startTrace(cellId: string, id: string, adapter: NestedToolAdapter, input: unknown): NestedToolTrace {
		const traces = this.traces.get(cellId) ?? [];
		if (traces.length >= MAX_NESTED_TRACE_COUNT) traces.shift();
		const trace: NestedToolTrace = {
			version: 1,
			id,
			name: adapter.name,
			kind: adapter.kind,
			input: sanitizeTraceInput(input),
			status: "running",
			startedAtMs: Date.now(),
		};
		traces.push(trace);
		this.traces.set(cellId, traces);
		return trace;
	}

	private emitTraceUpdate(cellId: string, context: ToolExecutionContext): void {
		const nestedCalls = this.traces.get(cellId)?.map((trace) => this.traceSnapshot(trace)) ?? [];
		const details: CodeModeToolDetails = {
			version: 1,
			tool: "exec",
			status: "running",
			cellId,
			isError: false,
			input: sanitizeTraceInput(context.presentation?.input),
			timing: {
				startedAtMs: context.presentation?.startedAtMs ?? Date.now(),
				durationMs: context.presentation ? Date.now() - context.presentation.startedAtMs : 0,
			},
			maxOutputTokens: context.presentation?.maxOutputTokens ?? 0,
			output: {
				textChars: 0,
				imageCount: 0,
				imageChars: 0,
				audioCount: 0,
				audioChars: 0,
				textTruncated: false,
				imagesOmitted: 0,
			},
			nestedCalls,
		};
		try {
			context.onUpdate?.({
				content: [{ type: "text", text: renderNestedCalls(nestedCalls) }],
				details,
			});
		} catch {
			// A display update must not change nested execution.
		}
	}

	private traceSnapshot(trace: NestedToolTrace): NestedToolTrace {
		const cached = this.traceSnapshots.get(trace);
		if (
			cached?.status === trace.status &&
			cached.durationMs === trace.durationMs &&
			cached.result === trace.result &&
			cached.value === trace.value &&
			cached.error === trace.error
		)
			return cached.snapshot;
		const snapshot = cloneTrace(trace);
		this.traceSnapshots.set(trace, {
			status: trace.status,
			durationMs: trace.durationMs,
			result: trace.result,
			value: trace.value,
			error: trace.error,
			snapshot,
		});
		return snapshot;
	}

	private respond(id: number, result: Record<string, unknown>): void {
		try {
			this.send({ type: "delegate/response", id, result });
		} catch {
			// A detached delegate may finish after its host transport has closed.
		}
	}
}

function renderNestedCalls(traces: readonly NestedToolTrace[]): string {
	return traces
		.map((trace) => {
			const verb = trace.status === "running" ? "Running" : trace.status === "error" ? "Failed" : "Ran";
			return `• ${verb} ${trace.name}`;
		})
		.join("\n");
}

export function normalizeToolResult(
	result: AgentToolResult<unknown>,
	resultValue?: (result: AgentToolResult<unknown>) => unknown,
): unknown {
	if (resultValue) return resultValue(result);
	if (result.content.some((item) => item.type === "image")) {
		return { content: result.content, ...(result.details === undefined ? {} : { details: result.details }) };
	}
	if (result.details !== undefined) return result.details;
	return (
		result.content
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map((item) => item.text)
			.join("\n") || "(no output)"
	);
}
