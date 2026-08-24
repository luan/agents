import { CodeModeHostCellOperations } from "./cell-operations.ts";
import { CodeModeHostDelegation } from "./delegation.ts";
import { abortError, cancelOperation, throwIfAborted, toError } from "./operation.ts";
import {
	DEFAULT_CODE_MODE_EXEC_YIELD_MS,
	executionCellId,
	parseExecSource,
	parseRuntimeResponse,
	toWireToolDefinition,
} from "./protocol.ts";
import { CodeModeHostSession } from "./session.ts";
import type { NestedToolAdapter, RuntimeResponse, ToolExecutionContext } from "../protocol/types.ts";

interface HostClientOptions {
	binary: string;
	shutdownGraceMs?: number;
}

export class CodeModeHostClient {
	private readonly session: CodeModeHostSession;
	private readonly delegation: CodeModeHostDelegation;
	private readonly cells: CodeModeHostCellOperations;

	constructor(options: HostClientOptions) {
		let session: CodeModeHostSession;
		this.delegation = new CodeModeHostDelegation((message) => session.send(message));
		session = new CodeModeHostSession({
			binary: options.binary,
			shutdownGraceMs: options.shutdownGraceMs,
			onMessage: (message) => this.delegation.handleMessage(message),
			onFailure: () => this.delegation.clear(),
		});
		this.session = session;
		this.cells = new CodeModeHostCellOperations(session, this.delegation);
	}

	async start(): Promise<void> {
		await this.session.start();
	}

	async execute(
		source: string,
		context: ToolExecutionContext,
		tools: NestedToolAdapter[],
		signal?: AbortSignal,
		defaults: { yieldTimeMs?: number; maxOutputTokens?: number } = {},
	): Promise<RuntimeResponse & { maxOutputTokens: number }> {
		throwIfAborted(signal);
		await this.start();
		throwIfAborted(signal);
		const { code, yieldTimeMs, maxOutputTokens } = parseExecSource(source);
		const effectiveYield =
			referencedYieldTime(code, tools) ?? yieldTimeMs ?? defaults.yieldTimeMs ?? DEFAULT_CODE_MODE_EXEC_YIELD_MS;
		const effectiveMaxOutputTokens = maxOutputTokens ?? defaults.maxOutputTokens ?? 10_000;
		const id = this.session.nextRequestId();
		const initial = this.session.expectInitial(id);
		void initial.catch(() => undefined);
		const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
		const started = this.session.requestWithId(
			id,
			{
				method: "session/execute",
				sessionId: this.session.id,
				request: {
					tool_call_id: `exec-${id}`,
					enabled_tools: tools.map(toWireToolDefinition),
					source: code,
					yield_time_ms: effectiveYield,
					max_output_tokens: effectiveMaxOutputTokens,
				},
			},
			(value) => this.delegation.bindResponse(value, context, toolMap),
		);
		let cellId: string | undefined;
		const abort = () => {
			cancelOperation(this.session, id);
			if (cellId) void this.terminate(cellId, context).catch(() => undefined);
		};
		signal?.addEventListener("abort", abort, { once: true });
		try {
			const startedValue = await started;
			cellId = executionCellId(startedValue);
			if (signal?.aborted) throw abortError();
			return {
				...this.delegation.attach(parseRuntimeResponse(await initial)),
				maxOutputTokens: effectiveMaxOutputTokens,
			};
		} catch (error) {
			this.session.rejectOperation(id, toError(error));
			throw error;
		} finally {
			signal?.removeEventListener("abort", abort);
		}
	}

	wait(cellId: string, yieldTimeMs: number, context: ToolExecutionContext, signal?: AbortSignal) {
		return this.cells.wait(cellId, yieldTimeMs, context, signal);
	}

	terminate(cellId: string, context: ToolExecutionContext, signal?: AbortSignal) {
		return this.cells.terminate(cellId, context, signal);
	}

	async shutdown(): Promise<void> {
		await this.session.shutdown();
	}
}

function referencedYieldTime(source: string, tools: NestedToolAdapter[]): number | undefined {
	let maximum: number | undefined;
	for (const tool of tools) {
		if (!tool.yieldTimeMs || !source.includes(`tools.${tool.name}`)) continue;
		maximum = Math.max(maximum ?? 0, tool.yieldTimeMs);
	}
	return maximum;
}
