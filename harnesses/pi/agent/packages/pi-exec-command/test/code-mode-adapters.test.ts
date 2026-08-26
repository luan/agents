import { afterEach, expect, test } from "bun:test";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { getCodeModeToolAdapterRegistry } from "pi-code-mode/sdk";
import { boundTraceResult } from "../../pi-code-mode/src/runtime/trace-values.ts";
import { renderCodeModeResult } from "../../pi-code-mode/src/ui/presentation.ts";
import { type CodeModeToolAdapter, registerCodeModeExecAdapters } from "../src/code-mode-adapters.ts";
import execCommandExtension from "../src/extension.ts";
import type { ExecSessionManager } from "../src/session-manager.ts";
import { createExecCommandTool } from "../src/tools/exec-command/definition.ts";
import type { ExecToolPresentationDetails } from "../src/tools/presentation.ts";
import { createWriteStdinTool } from "../src/tools/write-stdin/definition.ts";

const REGISTRY_SYMBOL = Symbol.for("pi-code-mode/nested-tool-adapters/v2");
const theme = {
	name: "code-mode-exec",
	bold: (text: string) => text,
	getColorMode: () => "truecolor",
	getFgAnsi: () => "\x1b[39m",
	getBgAnsi: () => "\x1b[49m",
} as never as Theme;

afterEach(() => {
	delete (globalThis as Record<symbol, unknown>)[REGISTRY_SYMBOL];
});

function installRegistry() {
	const adapters = new Map<string, CodeModeToolAdapter>();
	const registry = {
		protocol: "pi-code-mode/nested-tool-adapters/v2" as const,
		version: 2 as const,
		adapters,
		claim() {},
		list() {
			return [...adapters.values()];
		},
		register(adapter: CodeModeToolAdapter) {
			adapters.set(adapter.name, adapter);
			return () => {
				if (adapters.get(adapter.name) === adapter) adapters.delete(adapter.name);
			};
		},
	};
	(globalThis as Record<symbol, unknown>)[REGISTRY_SYMBOL] = registry;
	return adapters;
}

test("root and child exec adapters keep their own session managers", async () => {
	const calls: string[] = [];
	const manager = (owner: string) =>
		({
			exec: async () => {
				calls.push(owner);
				return {
					chunk_id: owner,
					wall_time_seconds: 0,
					output: "",
					output_truncated: false,
					session_id: 2,
				};
			},
			write: async () => ({
				chunk_id: owner,
				wall_time_seconds: 0,
				output: "",
				output_truncated: false,
				session_id: 2,
			}),
			getSessionCommand: () => "vim",
			shutdown: async () => undefined,
		}) satisfies ExecSessionManager;
	const rootTool = createExecCommandTool({ getManager: () => manager("root") });
	const childTool = createExecCommandTool({ getManager: () => manager("child") });
	const rootOwner = {};
	const childOwner = {};
	const rootScope = {};
	const childScope = {};
	const disposeRoot = registerCodeModeExecAdapters([rootTool], rootOwner);
	const registry = getCodeModeToolAdapterRegistry();
	registry.claim(rootScope);
	const disposeChild = registerCodeModeExecAdapters([childTool], childOwner);
	registry.claim(childScope);

	const invoke = async (scope: object) => {
		const adapter = registry.list(scope).find(({ name }) => name === "exec_command");
		if (!adapter) throw new Error("missing scoped exec_command adapter");
		await adapter.invoke(
			{ cmd: "vim", tty: true },
			{
				cwd: "/work",
				toolCallId: "call",
				extensionContext: { cwd: "/work", isProjectTrusted: () => true } as never,
			},
			new AbortController().signal,
		);
	};

	await invoke(rootScope);
	await invoke(childScope);
	expect(calls).toEqual(["root", "child"]);
	disposeChild();
	expect(registry.list(rootScope).map(({ name }) => name)).toEqual(["exec_command"]);
	disposeRoot();
});

test("Code Mode exec invocation reuses the direct tool and manager", async () => {
	const adapters = installRegistry();
	let observed: unknown;
	const manager = {
		exec: async (input: unknown, cwd: string) => {
			observed = { input, cwd };
			return {
				chunk_id: "code-mode",
				wall_time_seconds: 0,
				output: "code-mode-ok",
				output_truncated: false,
				exit_code: 0,
			};
		},
		write: async () => ({ chunk_id: "write", wall_time_seconds: 0, output: "", output_truncated: false, exit_code: 0 }),
		getSessionCommand: () => undefined,
		shutdown: async () => undefined,
	} satisfies ExecSessionManager;
	const runtime = { getManager: () => manager };
	const directExec = createExecCommandTool(runtime);
	const directWrite = createWriteStdinTool(runtime);
	const dispose = registerCodeModeExecAdapters([directExec, directWrite]);
	const adapter = adapters.get("exec_command")!;
	const result = await adapter.invoke(
		{ cmd: "printf code-mode" },
		{
			cwd: "/code-mode",
			toolCallId: "code-mode-call",
			extensionContext: {
				cwd: "/code-mode",
				isProjectTrusted: () => true,
			} as never,
		},
		new AbortController().signal,
	);
	expect(adapter.kind).toBe("function");
	expect(adapter.parameters).toBe(directExec.parameters);
	const outputSchema = adapter.outputSchema as {
		properties: Record<string, { description?: string }>;
	};
	expect(outputSchema.properties["session_id"]?.description).toBe(
		"Session identifier to pass to write_stdin when the process is still running.",
	);
	expect(observed).toEqual({
		input: expect.objectContaining({ cmd: "printf code-mode", shell: expect.any(String) }),
		cwd: "/code-mode",
	});
	expect(result.content[0]).toEqual(expect.objectContaining({ text: expect.stringContaining("code-mode-ok") }));
	expect(adapter.resultValue?.(result)).toEqual({
		chunk_id: "code-mode",
		wall_time_seconds: 0,
		output: "code-mode-ok",
		exit_code: 0,
		original_token_count: 0,
		output_truncated: false,
	});
	const partialPresentation = adapter.renderTrace?.(
		{
			id: "partial",
			input: { cmd: "printf code-mode" },
			status: "running",
			result: { ...result, details: { ...(result.details as ExecToolPresentationDetails), phase: "partial" } },
		},
		{ theme, requestRender() {}, executionStarted: true, cwd: "/code-mode", state: {}, lastComponent: undefined },
	);
	const presentation = adapter.renderTrace?.(
		{
			id: "complete",
			input: { cmd: "printf code-mode" },
			status: "done",
			durationMs: 1,
			result,
		},
		{
			theme,
			requestRender() {},
			executionStarted: true,
			cwd: "/code-mode",
			state: {},
			lastComponent: partialPresentation,
		},
	);
	expect(presentation).toBe(partialPresentation);
	const rendered = Bun.stripANSI(presentation?.render(80).join("\n") ?? "");
	expect(rendered).toContain("$ printf code-mode");
	expect(rendered).not.toContain("Ran command");
	expect(rendered).toContain("printf code-mode");
	expect(rendered).toContain("code-mode-ok");
	expect(rendered).not.toContain("Input");
	dispose();
});

test("Code Mode write_stdin updates the original exec presentation", async () => {
	const adapters = installRegistry();
	const manager = {
		exec: async () => ({
			chunk_id: "start",
			wall_time_seconds: 0.1,
			output: "first\n",
			output_truncated: false,
			session_id: 7,
		}),
		write: async () => ({
			chunk_id: "finish",
			wall_time_seconds: 1,
			output: "last\n",
			output_truncated: false,
			exit_code: 0,
		}),
		getSessionCommand: () => "streaming-command",
		shutdown: async () => undefined,
	} satisfies ExecSessionManager;
	const runtime = { getManager: () => manager };
	const dispose = registerCodeModeExecAdapters([createExecCommandTool(runtime), createWriteStdinTool(runtime)]);
	const invokeContext = {
		cwd: "/code-mode",
		toolCallId: "call",
		extensionContext: { cwd: "/code-mode", isProjectTrusted: () => true } as never,
	};
	const execAdapter = adapters.get("exec_command")!;
	const writeAdapter = adapters.get("write_stdin")!;
	const execResult = await execAdapter.invoke(
		{ cmd: "streaming-command" },
		invokeContext,
		new AbortController().signal,
	);
	const writeResult = await writeAdapter.invoke(
		{ session_id: 7 },
		{ ...invokeContext, toolCallId: "poll" },
		new AbortController().signal,
	);
	const execTrace = {
		id: "exec",
		input: { cmd: "streaming-command" },
		status: "done" as const,
		result: boundTraceResult(execResult),
	};
	const writeTrace = {
		id: "poll",
		input: { session_id: 7 },
		status: "done" as const,
		result: boundTraceResult(writeResult),
	};

	expect(execAdapter.presentationKey?.(execTrace)).toBe("pi-exec-command/session/7");
	expect(writeAdapter.presentationKey?.(writeTrace)).toBe("pi-exec-command/session/7");
	const original = execAdapter.renderTrace?.(execTrace, {
		theme,
		requestRender() {},
		executionStarted: true,
		cwd: "/code-mode",
		state: {},
		lastComponent: undefined,
	});
	const continued = writeAdapter.renderTrace?.(writeTrace, {
		theme,
		requestRender() {},
		executionStarted: true,
		cwd: "/code-mode",
		state: {},
		lastComponent: original,
	});

	expect(continued).toBe(original);
	const rendered = Bun.stripANSI(original?.render(80).join("\n") ?? "");
	expect(rendered).toContain("$ streaming-command");
	expect(rendered).toContain("first");
	expect(rendered).toContain("last");
	const replayed = writeAdapter.renderTrace?.(writeTrace, {
		theme,
		requestRender() {},
		executionStarted: true,
		cwd: "/code-mode",
		state: {},
		lastComponent: original,
	});
	expect(Bun.stripANSI(replayed?.render(80).join("\n") ?? "").match(/last/g)).toHaveLength(1);
	const outerResult: Parameters<typeof renderCodeModeResult>[0] = {
		content: [{ type: "text", text: "done" }],
		details: {
			version: 1,
			tool: "exec",
			status: "completed",
			cellId: "cell",
			isError: false,
			input: { code: "exec then poll" },
			timing: { startedAtMs: 0, durationMs: 1_000 },
			maxOutputTokens: 2_000,
			output: {
				textChars: 4,
				imageCount: 0,
				imageChars: 0,
				audioCount: 0,
				audioChars: 0,
				textTruncated: false,
				imagesOmitted: 0,
			},
			nestedCalls: [
				{ ...execTrace, version: 1, name: "exec_command", kind: "function", startedAtMs: 0 },
				{ ...writeTrace, version: 1, name: "write_stdin", kind: "function", startedAtMs: 1 },
			],
		},
	};
	const outer = renderCodeModeResult(outerResult, { expanded: false, isPartial: false }, theme, {
		invalidate() {},
		lastComponent: undefined,
		state: {},
		cwd: "/code-mode",
		executionStarted: false,
		isError: false,
	});
	const outerRendered = Bun.stripANSI(outer.render(80).join("\n"));
	expect(outerRendered).not.toContain("Code Mode");
	expect(outerRendered).toContain("first");
	expect(outerRendered).toContain("last");
	renderCodeModeResult(outerResult, { expanded: false, isPartial: false }, theme, {
		invalidate() {},
		lastComponent: outer,
		state: {},
		cwd: "/code-mode",
		executionStarted: true,
		isError: false,
	});
	expect(Bun.stripANSI(outer.render(80).join("\n"))).toContain("last");
	outer.dispose();
	dispose();
});

test("Code Mode fallback keeps the nested command when persisted details are malformed", async () => {
	const adapters = installRegistry();
	const manager = {
		exec: async () => ({ chunk_id: "fallback", wall_time_seconds: 0, output: "rg output", output_truncated: false }),
		write: async () => ({ chunk_id: "write", wall_time_seconds: 0, output: "", output_truncated: false }),
		getSessionCommand: () => undefined,
		shutdown: async () => undefined,
	} satisfies ExecSessionManager;
	const directExec = createExecCommandTool({ getManager: () => manager });
	const dispose = registerCodeModeExecAdapters([directExec]);
	const adapter = adapters.get("exec_command")!;
	const result = await adapter.invoke(
		{ cmd: "rg -n setEditorComponent" },
		{
			cwd: "/tmp",
			toolCallId: "fallback-call",
			extensionContext: { cwd: "/tmp", isProjectTrusted: () => true } as never,
		},
		new AbortController().signal,
	);
	const originalDetails = result.details as ExecToolPresentationDetails;
	const malformed = {
		...result,
		details: {
			...originalDetails,
			progress: { ...originalDetails.progress, output: 42 },
		},
	} as never;
	const presentation = adapter.renderTrace?.(
		{ id: "malformed", input: { cmd: "rg -n setEditorComponent" }, status: "done", result: malformed },
		{ theme, requestRender() {}, executionStarted: true, cwd: "/code-mode", state: {}, lastComponent: undefined },
	);
	const rendered = Bun.stripANSI(presentation?.render(80).join("\n") ?? "");
	expect(rendered).toContain("$ rg -n setEditorComponent");
	expect(rendered).not.toContain("$ command");
	dispose();
});

test("Code Mode adapters register synchronously and identity-dispose only on reload or quit", async () => {
	const adapters = installRegistry();
	const handlers = new Map<string, (event: { reason?: string }) => unknown>();
	const tools: unknown[] = [];
	const pi = {
		registerCommand() {},
		registerTool(tool: unknown) {
			tools.push(tool);
		},
		on(name: string, handler: (event: { reason?: string }) => unknown) {
			handlers.set(name, handler);
		},
	} as unknown as ExtensionAPI;
	await execCommandExtension(pi);
	expect(tools).toHaveLength(2);
	expect([...adapters.keys()]).toEqual(["exec_command", "write_stdin"]);
	await handlers.get("session_shutdown")!({ reason: "switch" });
	expect([...adapters.keys()]).toEqual(["exec_command", "write_stdin"]);
	const replacement = { ...adapters.get("exec_command")! };
	adapters.set("exec_command", replacement);
	await handlers.get("session_shutdown")!({ reason: "reload" });
	expect(adapters.get("exec_command")).toBe(replacement);
	expect(adapters.has("write_stdin")).toBe(false);
});
