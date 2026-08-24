import { CodeModeDelegateRuntime } from "../runtime/delegation.ts";
import { executionCellId, type HostMessage } from "./protocol.ts";
import type { NestedToolAdapter, RuntimeResponse, ToolExecutionContext } from "../protocol/types.ts";

export class CodeModeHostDelegation {
	private readonly runtime: CodeModeDelegateRuntime;

	constructor(send: (message: unknown) => void) {
		this.runtime = new CodeModeDelegateRuntime(send);
	}

	bindResponse(value: unknown, context?: ToolExecutionContext, tools?: Map<string, NestedToolAdapter>): void {
		const cellId = executionCellId(value);
		if (cellId && context) this.runtime.bindCell(cellId, context, tools);
	}

	updateCellContext(cellId: string, context: ToolExecutionContext): void {
		this.runtime.updateCellContext(cellId, context);
	}

	attach(response: RuntimeResponse): RuntimeResponse {
		return this.runtime.attach(response);
	}

	clear(): void {
		this.runtime.clear();
	}

	handleMessage(message: HostMessage): void {
		if (message.type === "delegate/request") this.runtime.handleRequest(message);
		else if (message.type === "delegate/cancel") this.runtime.cancel(message.id);
		else if (message.type === "cell/closed") this.runtime.closeCell(message.cellId);
	}
}
