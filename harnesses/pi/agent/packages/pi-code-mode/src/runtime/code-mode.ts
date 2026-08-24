import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { claimNestedToolAdapters, listNestedToolAdapters } from "../protocol/nested-tools.ts";
import { resolveCodeModeHostBinary } from "../host/binary.ts";
import { CodeModeHostClient } from "../host/client.ts";
import type { NestedToolAdapter, ToolExecutionContext } from "../protocol/types.ts";
import { setLiftedToolNames } from "../protocol/hierarchy.ts";

export class CodeModeRuntime {
	private client: CodeModeHostClient | undefined;
	private liftedToolNames: readonly string[] = [];
	private readonly hierarchyScope = Symbol("pi-code-mode-runtime");

	constructor(private readonly pi: Pick<ExtensionAPI, "getAllTools">) {}

	getClient(): CodeModeHostClient {
		this.client ??= new CodeModeHostClient({ binary: resolveCodeModeHostBinary() });
		return this.client;
	}

	setLiftedTools(names: readonly string[]): void {
		this.liftedToolNames = [...names];
		setLiftedToolNames(this.hierarchyScope, this.liftedToolNames);
	}

	liftedTools(): readonly string[] {
		return this.liftedToolNames;
	}

	claimAdapters(): void {
		claimNestedToolAdapters(this.hierarchyScope);
	}

	availableTools(): Array<{ name: string; description: string }> {
		const tools = this.pi.getAllTools();
		const adapters = new Set(listNestedToolAdapters(this.hierarchyScope).map((adapter) => adapter.name));
		return tools
			.filter((tool) => adapters.has(tool.name))
			.map((tool) => ({ name: tool.name, description: tool.description }))
			.sort((left, right) => left.name.localeCompare(right.name));
	}

	collectAdapters(): NestedToolAdapter[] {
		const tools = this.pi.getAllTools();
		const metadata = new Map(
			tools.map((tool) => [tool.name, { description: tool.description, parameters: tool.parameters }]),
		);
		const adapters = new Map(listNestedToolAdapters(this.hierarchyScope).map((adapter) => [adapter.name, adapter]));
		return this.liftedToolNames
			.flatMap((name) => {
				const adapter = adapters.get(name);
				return adapter && metadata.has(name) ? [adapter] : [];
			})
			.map((adapter) => {
				const tool = metadata.get(adapter.name);
				return {
					...adapter,
					description: adapter.description ?? tool?.description,
					parameters: adapter.parameters ?? tool?.parameters,
				};
			});
	}

	scopedAdapters(): NestedToolAdapter[] {
		return listNestedToolAdapters(this.hierarchyScope);
	}

	context(
		ctx: ExtensionContext,
		toolCallId: string,
		onUpdate?: Parameters<NestedToolAdapter["invoke"]>[1]["onUpdate"],
		presentation?: ToolExecutionContext["presentation"],
	) {
		return { cwd: ctx.cwd, toolCallId, extensionContext: ctx, onUpdate, presentation };
	}

	async shutdown(): Promise<void> {
		this.setLiftedTools([]);
		const client = this.client;
		this.client = undefined;
		await client?.shutdown();
	}
}
