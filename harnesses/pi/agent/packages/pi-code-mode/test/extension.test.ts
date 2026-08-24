import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createCodeModeSettings } from "../src/contributions/xsettings.ts";
import codeModeExtension from "../src/extension.ts";
import { CODE_MODE_HOST_ENV } from "../src/host/binary.ts";
import type { NestedToolAdapter, NestedToolScope } from "../src/protocol/nested-tools.ts";
import { CodeModeRuntime } from "../src/runtime/code-mode.ts";
import { listCodeModeToolNames } from "../src/sdk.ts";
import { buildExecDescription } from "../src/tools/exec/definition.ts";
import { createWaitTool } from "../src/tools/wait/definition.ts";

type TestEvent = { reason?: string; toolName?: string; details?: { codeMode?: boolean; isError?: boolean } };
type TestContext = { ui?: { notify(message: string): void } };
type TestHandler = (event?: TestEvent, context?: TestContext) => unknown;

describe("Code Mode extension", () => {
	test("declares available tools as an unordered exec-only multi-select", () => {
		const key = Symbol.for("pi-xsettings/registry/v1");
		const previous = Reflect.get(globalThis, key);
		let registration: { definitions: Array<Record<string, unknown>> } | undefined;
		Reflect.set(globalThis, key, {
			protocol: "pi-xsettings/registry/v1",
			version: 1,
			registrations: {},
			values: {},
			listeners: [],
			register(value: typeof registration) {
				registration = value;
				return () => undefined;
			},
			async publish() {},
			onRegister() {
				return () => undefined;
			},
		});
		try {
			createCodeModeSettings([
				{ name: "skill", description: "Load a skill." },
				{ name: "third_party", description: "Run a third-party tool." },
			]).register();
			const tools = registration?.definitions.find((definition) => definition["key"] === "tools");
			expect(tools).toMatchObject({
				type: "multi-enum",
				ordered: false,
				default: ["skill"],
				options: [
					{ value: "skill", label: "skill", description: "Load a skill." },
					{ value: "third_party", label: "third_party", description: "Run a third-party tool." },
				],
			});
		} finally {
			restoreGlobal(key, previous);
		}
	});

	test("registers normal exec and wait tools without starting the host", async () => {
		const tools: ToolDefinition[] = [];
		const handlers = new Map<string, (...args: never[]) => unknown>();
		const pi = {
			getAllTools: () => [],
			registerTool: (tool: ToolDefinition) => tools.push(tool),
			on: (event: string, handler: (...args: never[]) => unknown) => handlers.set(event, handler),
		} as unknown as ExtensionAPI;

		await codeModeExtension(pi);

		expect(tools.map((tool) => tool.name)).toEqual(["exec", "wait"]);
		expect(tools[0]?.description).toStartWith("Run JavaScript code to orchestrate/compose tool calls");
		expect(tools[1]?.description).toStartWith(
			"Waits on a yielded `exec` cell and returns new output or completion.\n- Use `wait` only after `exec` returns",
		);
		expect(tools.map((tool) => tool.renderShell)).toEqual(["self", "self"]);
		expect(tools.every((tool) => tool.renderCall && tool.renderResult)).toBe(true);
		expect(tools[0]?.constrainedSampling).toMatchObject({
			type: "grammar",
			variants: { openai_lark: expect.stringContaining("plain_source: SOURCE") },
		});
		expect([...handlers.keys()]).toEqual([
			"session_start",
			"model_select",
			"tool_result",
			"session_tree",
			"session_shutdown",
		]);
	});

	test("uses the Codex exec contract and typed nested-tool declarations", () => {
		const description = buildExecDescription([
			{
				name: "exec_command",
				kind: "function",
				description: "Run a command.",
				parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
				outputSchema: {
					type: "object",
					properties: { output: { type: "string" } },
					required: ["output"],
				},
				invoke: async () => ({ content: [], details: undefined }),
			},
		]);
		expect(description).toContain("All nested tools are available on the global `tools` object");
		expect(description).toContain("Tool names are exposed as normalized JavaScript identifiers");
		expect(description).toContain("### `exec_command`\nRun a command.");
		expect(description).toContain(
			"declare const tools: { exec_command(args: { cmd: string; }): Promise<{ output: string; }>; };",
		);
		expect(description.slice(description.indexOf("### `exec_command`"))).toBe(`### \`exec_command\`
Run a command.

exec tool declaration:
\`\`\`ts
declare const tools: { exec_command(args: { cmd: string; }): Promise<{ output: string; }>; };
\`\`\``);
		expect(description).not.toContain("Usage:");
		expect(description).not.toContain("Never call");
		expect(description).not.toContain("Available nested tools:");
	});

	test("advertises audio only when the provider can serialize it", () => {
		expect(buildExecDescription([], { supportsAudio: false })).not.toContain("`audio(");
		expect(buildExecDescription([], { supportsAudio: true })).toContain(
			"`audio(audioUrlOrItem: string | { audio_url: string } | AudioContent)`",
		);
	});

	test("configured wait defaults control execution and output bounds", async () => {
		let yieldTimeMs: number | undefined;
		const runtime = {
			context: () => ({}),
			getClient: () => ({
				async wait(_cellId: string, value: number) {
					yieldTimeMs = value;
					return {
						kind: "result",
						cellId: "cell-1",
						contentItems: [{ type: "input_text", text: "x".repeat(12_000) }],
					};
				},
			}),
		} as never;
		const tool = createWaitTool(runtime, {
			defaultWaitYieldMs: 5_000,
			defaultOutputTokens: 2_500,
		});

		const result = await tool.execute("call", { cell_id: "cell-1" }, undefined, undefined, {} as never);

		expect(yieldTimeMs).toBe(5_000);
		expect(result.details).toMatchObject({ maxOutputTokens: 2_500 });
		expect(result.content.at(-1)).toMatchObject({ type: "text", text: expect.stringContaining("[Output truncated]") });
	});

	test("lifts only configured active tools under exec", async () => {
		const active = ["exec", "wait", "skill", "tool_search", "resident"];
		let execDescription = "";
		const handlers = new Map<string, TestHandler[]>();
		const key = Symbol.for("pi-code-mode/nested-tool-adapters/v2");
		const previous = Reflect.get(globalThis, key);
		const registry = adapterRegistry([]);
		Reflect.set(globalThis, key, registry);
		registry.adapters.set("skill", {
			name: "skill",
			kind: "function",
			description: "skill description",
			parameters: {},
			invoke: () => ({ content: [], details: undefined }),
		});
		registry.adapters.set("resident", {
			name: "resident",
			kind: "function",
			description: "resident description",
			parameters: {},
			invoke: () => ({ content: [], details: undefined }),
		});
		const pi = {
			getAllTools: () => [
				{ name: "skill", description: "skill description", parameters: {} },
				{ name: "resident", description: "resident description", parameters: {} },
			],
			getActiveTools: () => [...active],
			setActiveTools: (names: string[]) => active.splice(0, active.length, ...names),
			registerTool: (tool: ToolDefinition) => {
				if (tool.name === "exec") execDescription = tool.description;
			},
			on: (event: string, handler: TestHandler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		} as unknown as ExtensionAPI;
		try {
			await codeModeExtension(pi);
			for (const handler of handlers.get("session_start") ?? []) await handler({}, {});
			expect(active).toEqual(["exec", "wait", "tool_search", "resident"]);
			expect(execDescription).toContain("### `skill`");
			expect(execDescription).not.toContain("### `resident`");

			for (const handler of handlers.get("session_start") ?? []) await handler({}, {});
			expect(active).toEqual(["exec", "wait", "tool_search", "resident"]);
			expect(execDescription).toContain("### `skill`");
		} finally {
			if (previous === undefined) Reflect.deleteProperty(globalThis, key);
			else Reflect.set(globalThis, key, previous);
		}
	});

	test("uses the configured tool list as the hierarchy policy", async () => {
		const active = ["exec", "wait", "skill", "resident"];
		const handlers = new Map<string, TestHandler[]>();
		const settingsKey = Symbol.for("pi-xsettings/registry/v1");
		const adaptersKey = Symbol.for("pi-code-mode/nested-tool-adapters/v2");
		const previousSettings = Reflect.get(globalThis, settingsKey);
		const previousAdapters = Reflect.get(globalThis, adaptersKey);
		Reflect.set(globalThis, settingsKey, settingsRegistry({ tools: ["resident"] }));
		Reflect.set(globalThis, adaptersKey, adapterRegistry(["skill", "resident"]));
		const pi = {
			getAllTools: () => [
				{ name: "skill", description: "skill description", parameters: {} },
				{ name: "resident", description: "resident description", parameters: {} },
			],
			getActiveTools: () => [...active],
			setActiveTools: (names: string[]) => active.splice(0, active.length, ...names),
			registerTool: () => undefined,
			on: (event: string, handler: TestHandler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		} as unknown as ExtensionAPI;
		try {
			await codeModeExtension(pi);
			for (const handler of handlers.get("session_start") ?? []) await handler({}, {});
			expect(active).toEqual(["exec", "wait", "skill"]);
		} finally {
			restoreGlobal(settingsKey, previousSettings);
			restoreGlobal(adaptersKey, previousAdapters);
		}
	});

	test("supplies scope-aware adapters with their sibling tools under exec", async () => {
		const active = ["exec", "wait", "tool_search", "exec_command"];
		const tools = [
			{ name: "tool_search", description: "Search tools.", parameters: {} },
			{ name: "exec_command", description: "Run a command.", parameters: {} },
		] as ToolDefinition[];
		const handlers = new Map<string, TestHandler[]>();
		const settingsKey = Symbol.for("pi-xsettings/registry/v1");
		const adaptersKey = Symbol.for("pi-code-mode/nested-tool-adapters/v2");
		const previousSettings = Reflect.get(globalThis, settingsKey);
		const previousAdapters = Reflect.get(globalThis, adaptersKey);
		const registry = adapterRegistry(["tool_search", "exec_command"]);
		let scope: NestedToolScope | undefined;
		const toolSearchAdapter = registry.adapters.get("tool_search") as NestedToolAdapter;
		toolSearchAdapter.onScopeChange = (next) => {
			scope = next;
		};
		Reflect.set(globalThis, settingsKey, settingsRegistry({ tools: ["tool_search", "exec_command"] }));
		Reflect.set(globalThis, adaptersKey, registry);
		let execTool: ToolDefinition | undefined;
		const pi = {
			getAllTools: () => tools,
			getActiveTools: () => [...active],
			setActiveTools: (names: string[]) => active.splice(0, active.length, ...names),
			registerTool: (tool: ToolDefinition) => {
				if (tool.name === "exec") execTool = tool;
				const index = tools.findIndex((candidate) => candidate.name === tool.name);
				if (index >= 0) tools[index] = tool;
				else tools.push(tool);
			},
			on: (event: string, handler: TestHandler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		} as unknown as ExtensionAPI;
		try {
			await codeModeExtension(pi);
			for (const handler of handlers.get("session_start") ?? []) await handler({}, {});
			expect(active).toEqual(["exec", "wait"]);
			expect(scope?.tools()).toEqual([{ name: "exec_command", description: "Run a command.", parameters: {} }]);
			expect(scope?.active()).toEqual(["exec_command"]);
			scope?.setActive([]);
			expect(execTool?.description).toContain("### `tool_search`");
			expect(execTool?.description).not.toContain("### `exec_command`");
		} finally {
			restoreGlobal(settingsKey, previousSettings);
			restoreGlobal(adaptersKey, previousAdapters);
		}
	});

	test("does not activate configured tools when Code Mode is disabled", async () => {
		const active = ["exec", "wait", "resident"];
		const tools: ToolDefinition[] = [];
		const handlers = new Map<string, TestHandler>();
		const settingsKey = Symbol.for("pi-xsettings/registry/v1");
		const adaptersKey = Symbol.for("pi-code-mode/nested-tool-adapters/v2");
		const previousSettings = Reflect.get(globalThis, settingsKey);
		const previousAdapters = Reflect.get(globalThis, adaptersKey);
		Reflect.set(globalThis, settingsKey, settingsRegistry({ enabled: false }));
		Reflect.set(globalThis, adaptersKey, adapterRegistry(["skill", "tool_search", "apply_patch"]));
		const pi = {
			getAllTools: () => tools,
			getActiveTools: () => [...active],
			setActiveTools: (names: string[]) => active.splice(0, active.length, ...names),
			registerTool: (tool: ToolDefinition) => {
				const index = tools.findIndex((candidate) => candidate.name === tool.name);
				if (index >= 0) tools[index] = tool;
				else tools.push(tool);
			},
			on: (event: string, handler: TestHandler) => handlers.set(event, handler),
		} as unknown as ExtensionAPI;
		try {
			for (const name of ["resident", "skill", "tool_search", "apply_patch"]) {
				tools.push({ name } as ToolDefinition);
			}
			await codeModeExtension(pi);
			await handlers.get("session_start")?.({}, { ui: { notify() {} } });
			expect(active).toEqual(["resident"]);
		} finally {
			restoreGlobal(settingsKey, previousSettings);
			restoreGlobal(adaptersKey, previousAdapters);
		}
	});

	test("does not invent direct tools when strict tool selection omits exec", async () => {
		const active = ["resident"];
		const tools = [{ name: "resident" }, { name: "skill" }, { name: "tool_search" }] as ToolDefinition[];
		const handlers = new Map<string, TestHandler>();
		const settingsKey = Symbol.for("pi-xsettings/registry/v1");
		const adaptersKey = Symbol.for("pi-code-mode/nested-tool-adapters/v2");
		const previousSettings = Reflect.get(globalThis, settingsKey);
		const previousAdapters = Reflect.get(globalThis, adaptersKey);
		Reflect.set(globalThis, settingsKey, settingsRegistry({ enabled: false }));
		Reflect.set(globalThis, adaptersKey, adapterRegistry(["skill", "tool_search"]));
		const pi = {
			getAllTools: () => tools,
			getActiveTools: () => [...active],
			setActiveTools: (names: string[]) => active.splice(0, active.length, ...names),
			registerTool: () => undefined,
			on: (event: string, handler: TestHandler) => handlers.set(event, handler),
		} as unknown as ExtensionAPI;
		try {
			await codeModeExtension(pi);
			await handlers.get("session_start")?.({}, { ui: { notify() {} } });
			expect(active).toEqual(["resident"]);
		} finally {
			restoreGlobal(settingsKey, previousSettings);
			restoreGlobal(adaptersKey, previousAdapters);
		}
	});

	test("marks script errors and missing cells as failed tool results", async () => {
		const handlers = new Map<string, TestHandler>();
		const pi = {
			getAllTools: () => [],
			registerTool: () => undefined,
			on: (event: string, handler: TestHandler) => handlers.set(event, handler),
		} as unknown as ExtensionAPI;
		await codeModeExtension(pi);

		const onToolResult = handlers.get("tool_result");
		expect(onToolResult?.({ toolName: "exec", details: { codeMode: true, isError: true } })).toEqual({ isError: true });
		expect(onToolResult?.({ toolName: "wait", details: { codeMode: true, isError: true } })).toEqual({ isError: true });
		expect(onToolResult?.({ toolName: "exec", details: { codeMode: true, isError: false } })).toBeUndefined();
	});

	test("shuts down on tree changes and shutdown", async () => {
		let shutdowns = 0;
		const original = CodeModeRuntime.prototype.shutdown;
		CodeModeRuntime.prototype.shutdown = async () => {
			shutdowns++;
		};
		try {
			const handlers = new Map<string, TestHandler>();
			const pi = {
				getAllTools: () => [],
				registerTool: () => undefined,
				on: (event: string, handler: TestHandler) => handlers.set(event, handler),
			} as unknown as ExtensionAPI;
			await codeModeExtension(pi);

			await handlers.get("session_tree")?.();
			await handlers.get("session_shutdown")?.({ reason: "switch" } as never);
			expect(shutdowns).toBe(2);
		} finally {
			CodeModeRuntime.prototype.shutdown = original;
		}
	});

	test("creates a fresh lazy client after shutdown", async () => {
		const previous = process.env[CODE_MODE_HOST_ENV];
		process.env[CODE_MODE_HOST_ENV] = "/usr/bin/true";
		const before = new Set(listCodeModeToolNames());
		try {
			const runtime = new CodeModeRuntime({ getAllTools: () => [] });
			runtime.setLiftedTools(["exec_command", "apply_patch"]);
			expect(listCodeModeToolNames()).toEqual(expect.arrayContaining(["exec_command", "apply_patch"]));
			const first = runtime.getClient();
			await runtime.shutdown();
			expect(listCodeModeToolNames().filter((name) => !before.has(name))).toEqual([]);
			expect(runtime.getClient()).not.toBe(first);
		} finally {
			if (previous === undefined) delete process.env[CODE_MODE_HOST_ENV];
			else process.env[CODE_MODE_HOST_ENV] = previous;
		}
	});

	test("retains lifted tools until every session scope releases them", async () => {
		const root = new CodeModeRuntime({ getAllTools: () => [] });
		const child = new CodeModeRuntime({ getAllTools: () => [] });
		const before = new Set(listCodeModeToolNames());
		try {
			root.setLiftedTools(["exec_command", "write_stdin"]);
			child.setLiftedTools(["exec_command"]);
			expect(listCodeModeToolNames()).toEqual(expect.arrayContaining(["exec_command", "write_stdin"]));

			await child.shutdown();
			expect(listCodeModeToolNames()).toEqual(expect.arrayContaining(["exec_command", "write_stdin"]));
		} finally {
			await child.shutdown();
			await root.shutdown();
			expect(listCodeModeToolNames().filter((name) => !before.has(name))).toEqual([]);
		}
	});
});

function settingsRegistry(values: Record<string, boolean | number | string[]>) {
	return {
		protocol: "pi-xsettings/registry/v1",
		version: 1,
		registrations: {},
		values: {},
		listeners: [],
		register(registration: { onValues?: (settings: Record<string, boolean | number | string[]>) => void }) {
			registration.onValues?.(values);
			return () => undefined;
		},
		async publish() {},
		onRegister() {
			return () => undefined;
		},
	};
}

function adapterRegistry(names: string[]) {
	const adapters = new Map(
		names.map((name) => [
			name,
			{
				name,
				kind: "function" as const,
				description: `${name} description`,
				parameters: {},
				invoke: () => ({ content: [], details: undefined }),
			},
		]),
	);
	return {
		protocol: "pi-code-mode/nested-tool-adapters/v2",
		version: 2,
		adapters,
		claim() {},
		list: () => [...adapters.values()],
		register() {},
	};
}

function restoreGlobal(key: symbol, value: unknown): void {
	if (value === undefined) Reflect.deleteProperty(globalThis, key);
	else Reflect.set(globalThis, key, value);
}
