import { beforeAll, describe, expect, test } from "bun:test";
import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { ComponentStack, icon, MarkdownText, whenSyntaxReady } from "pi-libtui";
import type { TuiMouseEvent } from "pi-libtui/mouse";
import { ToolActivity } from "pi-libtui/tool";
import {
	type NestedToolPresentationComponent,
	type NestedToolPresentationTrace,
	registerNestedToolAdapter,
} from "../../src/protocol/nested-tools.ts";
import type { CodeModeToolDetails } from "../../src/protocol/types.ts";
import { createExecTool } from "../../src/tools/exec/definition.ts";
import { CodeModeResultComponent, renderCodeModeCall, renderCodeModeResult } from "../../src/ui/presentation.ts";

const theme = {
	name: "code-mode-presentation-test",
	bold: (text: string) => text,
	getColorMode: () => "truecolor",
	getFgAnsi: (token: string) => (token === "text" ? "\x1b[38;2;240;240;240m" : "\x1b[38;2;100;140;200m"),
	getBgAnsi: () => "\x1b[48;2;20;24;30m",
} as never as Theme;

function context<T extends object>(args: T, lastComponent?: { render(width: number): string[]; invalidate(): void }) {
	return {
		args,
		toolCallId: "code-mode-call",
		invalidate() {},
		lastComponent,
		state: {},
		cwd: "/tmp",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
	};
}

let nextTraceId = 0;

function result(traceId = `nested-${++nextTraceId}`): AgentToolResult<CodeModeToolDetails> {
	const execDetails = {
		arguments: {
			command: "ls",
			kind: "exec_command",
			login: true,
			maxOutputTokens: null,
			requestedYieldTimeMs: null,
			shell: "/bin/zsh",
			tty: false,
			workingDirectory: "/tmp",
		},
		command: "ls",
		contract: "pi-exec-command/tool-presentation",
		identifiers: { chunkId: traceId, sessionId: null },
		outcome: { exitCode: 0, failure: null, status: "succeeded" },
		phase: "final",
		progress: {
			originalTokenCount: 2,
			output: "AGENTS.md\nCargo.toml\n",
			outputChars: 21,
			outputTruncated: false,
		},
		timing: { wallTimeSeconds: 0.01 },
		tool: "exec_command",
		version: 1,
	};
	const details: CodeModeToolDetails = {
		version: 1,
		tool: "exec",
		status: "completed",
		cellId: "cell-1",
		isError: false,
		input: { code: 'text(await tools.exec_command({ cmd: "ls" }))' },
		timing: { startedAtMs: 100, durationMs: 12 },
		maxOutputTokens: 10_000,
		output: {
			textChars: 80,
			imageCount: 0,
			imageChars: 0,
			audioCount: 0,
			audioChars: 0,
			textTruncated: false,
			imagesOmitted: 0,
		},
		nestedCalls: [
			{
				version: 1,
				id: traceId,
				name: "exec_command",
				kind: "function",
				input: { cmd: "ls" },
				status: "done",
				startedAtMs: 101,
				durationMs: 8,
				value: {
					chunk_id: traceId,
					wall_time_seconds: 0.01,
					output: "AGENTS.md\nCargo.toml\n",
					exit_code: 0,
					original_token_count: 2,
					output_truncated: false,
				},
				result: {
					content: [{ type: "text", text: "Command: ls\nProcess exited with code 0\nOutput:\nAGENTS.md\nCargo.toml" }],
					details: execDetails,
				},
			},
		],
	};
	return {
		content: [
			{ type: "text", text: "• Ran exec_command" },
			{ type: "text", text: "Script completed" },
			{ type: "text", text: JSON.stringify(execDetails) },
		],
		details,
	};
}

beforeAll(async () => {
	await new Promise<void>((resolve) => whenSyntaxReady(resolve));
});

describe("Code Mode presentation", () => {
	test("does not render a successful result with no transcript content", () => {
		const empty = result();
		empty.content = [];
		empty.details.input = {};
		empty.details.nestedCalls = [];
		const component = renderCodeModeResult(empty, { expanded: false, isPartial: false }, theme, context({}));
		expect(component.render(40)).toEqual([]);
	});

	test("hides only the successful Code Mode row until Ctrl+O expands the transcript", () => {
		const value = result();
		value.content = [{ type: "text", text: "useful result" }];
		value.details.nestedCalls = [];
		const component = renderCodeModeResult(value, { expanded: false, isPartial: false }, theme, context({}));
		const compact = Bun.stripANSI(component.render(80).join("\n"));
		expect(compact).toContain("useful result");
		expect(compact).not.toContain("Code Mode");
		expect(compact).not.toContain("Code    Result");

		renderCodeModeResult(value, { expanded: true, isPartial: false }, theme, context({}, component));
		const expanded = Bun.stripANSI(component.render(80).join("\n"));
		expect(expanded).toContain("Code Mode · exec");
		expect(expanded).toContain("Code");
		expect(expanded).toContain("Result");
		component.dispose();
	});

	test("keeps failed Code Mode rows visible in compact mode", () => {
		const value = result();
		value.content = [];
		value.details.nestedCalls = [];
		value.details.isError = true;
		value.details.scriptError = "boom";
		const component = renderCodeModeResult(value, { expanded: false, isPartial: false }, theme, context({}));
		expect(Bun.stripANSI(component.render(80).join("\n"))).toContain("Code Mode · exec");
		component.dispose();
	});

	test("does not render write_stdin as a nested transcript event", () => {
		const value = result();
		value.details.nestedCalls[0]!.name = "write_stdin";
		const component = renderCodeModeResult(value, { expanded: false, isPartial: false }, theme, context({}));
		expect(component.render(40)).toEqual([]);
	});

	test("keeps failed write_stdin traces visible", () => {
		const value = result();
		value.content = [];
		value.details.nestedCalls[0]!.name = "write_stdin";
		value.details.nestedCalls[0]!.status = "error";
		value.details.nestedCalls[0]!.error = "session failed";
		const component = renderCodeModeResult(value, { expanded: false, isPartial: false }, theme, context({}));
		expect(Bun.stripANSI(component.render(80).join("\n"))).toContain("Failed write_stdin");
	});

	test("keeps pending exec and wait calls transcript-silent", () => {
		const pending = { ...context({}), executionStarted: false };
		expect(renderCodeModeCall("exec", { code: 'text("done")' }, theme, pending).render(80)).toEqual([]);
		expect(renderCodeModeCall("wait", { cell_id: "cell-1" }, theme, pending).render(80)).toEqual([]);
	});

	test("does not add a speculative exec row before execution starts", () => {
		const tool = createExecTool({} as never);
		const args = { code: 'text(await tools.exec_command({ cmd: "ls" }))' };
		const pendingContext = { ...context(args), executionStarted: false };

		expect(tool.renderShell).toBe("self");
		expect(tool.renderCall!(args, theme, pendingContext).render(72)).toEqual([]);
		expect(tool.renderCall!(args, theme, context(args)).render(72)).toEqual([]);
	});

	test("renders only nested tools in compact mode and exposes Code Mode details when expanded", () => {
		const tool = createExecTool({} as never);
		const args = { code: 'text(await tools.exec_command({ cmd: "ls" }))' };
		const value = result();
		const component = tool.renderResult!(value, { expanded: false, isPartial: false }, theme, context(args));
		const collapsed = Bun.stripANSI(component.render(80).join("\n"));

		expect(collapsed).not.toContain("Code Mode");
		expect(collapsed).toContain("Used exec_command · ls");
		expect(collapsed).not.toContain('"contract": "pi-exec-command/tool-presentation"');

		expect(component).toBeInstanceOf(CodeModeResultComponent);
		if (!(component instanceof CodeModeResultComponent)) throw new Error("Expected Code Mode result component");
		tool.renderResult!(value, { expanded: true, isPartial: false }, theme, context(args, component));
		expect(component.children).toHaveLength(1);
		const disclosure = component.children[0] as unknown as {
			children: Array<{ handleViewportInput?(data: string): boolean }>;
		};
		const rendered = Bun.stripANSI(component.render(80).join("\n"));

		expect(rendered).toContain("⌘ Code Mode · exec · 12ms");
		expect(rendered).toContain("Used exec_command · ls");
		expect(rendered).toContain("AGENTS.md");
		expect(rendered).not.toContain("Code output");
		expect(rendered).not.toContain("pi-exec-command/tool-presentation");
		expect(rendered).not.toMatch(/[╭╮╰╯]/u);

		const codeView = Bun.stripANSI(component.render(80).join("\n"));
		expect(codeView).toContain("Code");
		expect(codeView).toContain("Result");
		expect(codeView).toContain("tools.exec_command");
		const region = disclosure.children[1] as unknown as { handleViewportInput(data: string): boolean };
		expect(region.handleViewportInput("\u001b[C")).toBe(true);
		const resultView = Bun.stripANSI(component.render(80).join("\n"));
		expect(resultView).toContain('"contract": "pi-exec-command/tool-presentation"');
		expect(resultView).not.toContain("Code output");
	});

	test("restored call rows remain silent before and after their result", () => {
		const args = { code: 'text("done")' };
		const resumed = { ...context(args), executionStarted: false, lastComponent: undefined };
		const call = renderCodeModeCall("exec", args, theme, resumed);
		expect(call.render(80)).toEqual([]);
		renderCodeModeResult(result(), { expanded: false, isPartial: false }, theme, resumed);
		expect(call.render(80)).toEqual([]);
	});

	test("tab switches reserve the larger pane height", () => {
		const value = result();
		value.details.input = { code: "one\ntwo\nthree\nfour" };
		value.content = [{ type: "text", text: "Script completed" }];
		const component = renderCodeModeResult(
			value,
			{ expanded: true, isPartial: false },
			theme,
			context({ code: "four lines" }),
		);
		const disclosure = component.children[0] as unknown as {
			children: Array<{ handleViewportInput(data: string): boolean }>;
		};
		const before = component.render(80).length;
		disclosure.children[0]!.handleViewportInput("\u001b[C");
		expect(component.render(80).length).toBe(before);
	});

	test("a separate write_stdin cell updates the original session presentation and stays silent", () => {
		class SessionPresentation implements NestedToolPresentationComponent {
			constructor(private output: string) {}
			update(output: string): void {
				this.output = output;
			}
			render(): string[] {
				return [this.output];
			}
			invalidate(): void {}
		}
		const presentationKey = (trace: NestedToolPresentationTrace) => {
			const details = trace.result?.details as
				| {
						arguments?: { sessionId?: number };
						identifiers?: { sessionId?: number };
				  }
				| undefined;
			const sessionId = details?.arguments?.sessionId ?? details?.identifiers?.sessionId;
			return sessionId === undefined ? undefined : `session/${sessionId}`;
		};
		const renderTrace = (
			trace: NestedToolPresentationTrace,
			context: { lastComponent: NestedToolPresentationComponent | undefined },
		) => {
			const details = trace.result?.details as { progress?: { output?: string } } | undefined;
			const output = details?.progress?.output ?? "";
			if (context.lastComponent instanceof SessionPresentation) {
				context.lastComponent.update(output);
				return context.lastComponent;
			}
			return new SessionPresentation(output);
		};
		const disposeExec = registerNestedToolAdapter({
			name: "exec_command",
			kind: "function",
			parameters: {},
			presentationKey,
			renderTrace,
			invoke: () => ({ content: [], details: undefined }),
		});
		const disposeWrite = registerNestedToolAdapter({
			name: "write_stdin",
			kind: "function",
			parameters: {},
			presentationKey,
			renderTrace,
			invoke: () => ({ content: [], details: undefined }),
		});
		const historical = result("historical-runtime:1:tool-1");
		const historicalDetails = historical.details.nestedCalls[0]!.result!.details as {
			identifiers: { sessionId: number | null };
			progress: { output: string };
		};
		historicalDetails.identifiers.sessionId = 7;
		historicalDetails.progress.output = "historical-marker";
		const restored = renderCodeModeResult(historical, { expanded: false, isPartial: false }, theme, {
			...context({ code: "old sleep" }),
			executionStarted: false,
		});
		expect(Bun.stripANSI(restored.render(80).join("\n"))).toContain("historical-marker");

		const historicalContinuation = result("historical-runtime:2:tool-1");
		historicalContinuation.details.nestedCalls[0]!.name = "write_stdin";
		const historicalWriteDetails = historicalContinuation.details.nestedCalls[0]!.result!.details as {
			arguments: { kind: string; sessionId?: number };
			identifiers: { sessionId: number | null };
			progress: { output: string };
			tool: string;
		};
		historicalWriteDetails.tool = "write_stdin";
		historicalWriteDetails.arguments = { kind: "write_stdin", sessionId: 7 };
		historicalWriteDetails.identifiers.sessionId = null;
		historicalWriteDetails.progress.output = "historical-final-marker";
		const restoredContinuation = renderCodeModeResult(
			historicalContinuation,
			{ expanded: false, isPartial: false },
			theme,
			{ ...context({ code: "await tools.write_stdin(...)" }), executionStarted: false },
		);
		expect(Bun.stripANSI(restored.render(80).join("\n"))).toContain("historical-final-marker");
		expect(restoredContinuation.render(80)).toEqual([]);

		const running = result("live-runtime:1:tool-1");
		const execDetails = running.details.nestedCalls[0]!.result!.details as {
			identifiers: { sessionId: number | null };
			progress: { output: string };
		};
		execDetails.identifiers.sessionId = 7;
		execDetails.progress.output = "screenshot-marker-1";
		const first = renderCodeModeResult(
			running,
			{ expanded: false, isPartial: false },
			theme,
			context({ code: "sleep" }),
		);
		expect(Bun.stripANSI(first.render(80).join("\n"))).toContain("screenshot-marker-1");

		const resumed = result("live-runtime:2:tool-1");
		resumed.details.nestedCalls[0]!.name = "write_stdin";
		const writeDetails = resumed.details.nestedCalls[0]!.result!.details as {
			arguments: { kind: string; sessionId?: number };
			identifiers: { sessionId: number | null };
			progress: { output: string };
			tool: string;
		};
		writeDetails.tool = "write_stdin";
		writeDetails.arguments = { kind: "write_stdin", sessionId: 7 };
		writeDetails.identifiers.sessionId = null;
		writeDetails.progress.output = "screenshot-marker-2\nscreenshot-marker-3";
		resumed.content = [
			{
				type: "text",
				text: JSON.stringify({ output: writeDetails.progress.output }),
			},
		];
		const completed = renderCodeModeResult(
			resumed,
			{ expanded: false, isPartial: false },
			theme,
			context({ code: "text(JSON.stringify(r))" }),
		);
		expect(Bun.stripANSI(first.render(80).join("\n"))).toContain("screenshot-marker-2");
		expect(Bun.stripANSI(first.render(80).join("\n"))).not.toContain("screenshot-marker-1");
		expect(Bun.stripANSI(restored.render(80).join("\n"))).toContain("historical-final-marker");
		expect(completed.render(80)).toEqual([]);
		restoredContinuation.dispose();
		restored.dispose();
		first.dispose();
		completed.dispose();
		disposeWrite();
		disposeExec();
	});

	test("deduplicates restored nested trace ids with the latest state winning", () => {
		const duplicate = result();
		const completed = duplicate.details.nestedCalls[0]!;
		duplicate.details.nestedCalls = [{ ...completed, status: "running", durationMs: undefined }, completed];
		const component = renderCodeModeResult(
			duplicate,
			{ expanded: false, isPartial: false },
			theme,
			context({ code: "ls" }),
		);
		const rendered = Bun.stripANSI(component.render(80).join("\n"));
		expect(component.children).toHaveLength(1);
		expect(rendered.match(/Used exec_command/gu)).toHaveLength(1);
		expect(rendered).not.toContain("Running exec_command");
		component.dispose();
	});

	test("syntax-colors JSON in the Result tab through the shared Shiki renderer", () => {
		const value = result();
		value.content = [{ type: "text", text: JSON.stringify({ value: true, count: 2 }) }];
		value.details.nestedCalls = [];
		const component = renderCodeModeResult(
			value,
			{ expanded: true, isPartial: false },
			theme,
			context({ code: "return value" }),
		);

		const disclosure = component.children[0] as unknown as {
			children: Array<{ handleViewportInput?(data: string): boolean }>;
		};
		component.render(80);
		expect(disclosure.children[1]!.handleViewportInput?.("\u001b[C")).toBe(true);
		const resultLine = component.render(80).find((line) => Bun.stripANSI(line).includes('"value": true'));

		expect(resultLine).toBeDefined();
		const foregrounds = resultLine?.match(/\x1b\[38;(?:2|5);[0-9;]+m/gu) ?? [];
		expect(new Set(foregrounds).size).toBeGreaterThan(1);
		component.dispose();
	});

	test("updates a nested exec partial through renderTrace without replacing its live component", () => {
		const renderTraceLastComponents: Array<NestedToolPresentationComponent | undefined> = [];
		let live: StreamingNestedExec | undefined;
		const disposeAdapter = registerNestedToolAdapter({
			name: "exec_command",
			kind: "function",
			parameters: {},
			invoke: () => ({ content: [], details: undefined }),
			renderTrace(trace, context) {
				renderTraceLastComponents.push(context.lastComponent);
				const current = live;
				if (current !== undefined && context.lastComponent === current) {
					current.update(trace);
					return current;
				}
				live = new StreamingNestedExec(trace);
				return live;
			},
		});
		try {
			const code = 'text(await tools.exec_command({ cmd: "printf output" }))';
			const partial = resultWithNestedTrace("running", "first chunk");
			expect(renderTraceLastComponents).toEqual([undefined]);
			const first = renderCodeModeResult(partial, { expanded: false, isPartial: true }, theme, context({ code }));
			expect(live).toBeDefined();
			expect(Bun.stripANSI(first.render(80).join("\n"))).toContain("first chunk");

			const completed = resultWithNestedTrace("done", "first chunk\nsecond chunk");
			const second = renderCodeModeResult(
				completed,
				{ expanded: false, isPartial: true },
				theme,
				context({ code }, first),
			);

			expect(second).toBe(first);
			expect(renderTraceLastComponents).toEqual([undefined, live]);
			const rendered = Bun.stripANSI(second.render(80).join("\n"));
			expect(rendered).toContain("first chunk");
			expect(rendered).toContain("second chunk");
		} finally {
			disposeAdapter();
		}
	});

	test("rebuilds nested traces when the host mutates one result object in place", () => {
		let output = "first chunk";
		const disposeAdapter = registerNestedToolAdapter({
			name: "exec_command",
			kind: "function",
			parameters: {},
			invoke: () => ({ content: [], details: undefined }),
			renderTrace(_trace, _context) {
				return {
					render: () => [output],
					invalidate() {},
				};
			},
		});
		try {
			const value = resultWithNestedTrace("running", output);
			value.details.nestedCalls[0]!.id = "in-place-stream";
			const component = renderCodeModeResult(
				value,
				{ expanded: false, isPartial: true },
				theme,
				context({ code: "stream" }),
			);
			expect(Bun.stripANSI(component.render(80).join("\n"))).toContain("first chunk");

			output = "final chunk";
			value.details.nestedCalls[0]!.status = "done";
			renderCodeModeResult(value, { expanded: false, isPartial: false }, theme, context({ code: "stream" }, component));
			expect(Bun.stripANSI(component.render(80).join("\n"))).toContain("final chunk");
			component.dispose();
		} finally {
			disposeAdapter();
		}
	});

	test("does not rebuild unchanged nested traces during animation repaints", () => {
		let rebuilds = 0;
		let requestNestedRender: (() => void) | undefined;
		const disposeAdapter = registerNestedToolAdapter({
			name: "exec_command",
			kind: "function",
			parameters: {},
			invoke: () => ({ content: [], details: undefined }),
			renderTrace(_trace, context) {
				rebuilds += 1;
				requestNestedRender = context.requestRender;
				return { render: () => ["running"], invalidate() {} };
			},
		});
		try {
			const value = resultWithNestedTrace("running", "");
			value.details.nestedCalls[0]!.id = "animation-repaint";
			let component: ReturnType<typeof renderCodeModeResult>;
			const rendererContext = context({ code: "sleep" });
			rendererContext.invalidate = () => {
				component.invalidate();
				component = renderCodeModeResult(
					{ ...value },
					{ expanded: false, isPartial: true },
					theme,
					context({ code: "sleep" }, component),
				);
			};
			component = renderCodeModeResult(value, { expanded: false, isPartial: true }, theme, rendererContext);

			for (let index = 0; index < 100; index += 1) requestNestedRender?.();
			expect(rebuilds).toBe(1);

			value.details.nestedCalls[0]!.status = "done";
			rendererContext.invalidate();
			expect(rebuilds).toBe(2);
			component.dispose();
		} finally {
			disposeAdapter();
		}
	});

	test("invalidates the outer disclosure when a nested renderer streams", () => {
		let line = "first chunk";
		let requestNestedRender: (() => void) | undefined;
		const disposeAdapter = registerNestedToolAdapter({
			name: "exec_command",
			kind: "function",
			parameters: {},
			invoke: () => ({ content: [], details: undefined }),
			renderTrace(_trace, context) {
				requestNestedRender = context.requestRender;
				return { render: () => [line], invalidate() {} };
			},
		});
		try {
			const value = resultWithNestedTrace("running", line);
			value.details.nestedCalls[0]!.id = "streaming-invalidation";
			const rendererContext = context({ code: "stream" });
			let component: ReturnType<typeof renderCodeModeResult>;
			rendererContext.invalidate = () => component.invalidate();
			component = renderCodeModeResult(value, { expanded: false, isPartial: true }, theme, rendererContext);
			expect(Bun.stripANSI(component.render(80).join("\n"))).toContain("first chunk");

			line = "second chunk";
			requestNestedRender?.();
			const rendered = Bun.stripANSI(component.render(80).join("\n"));
			expect(rendered).toContain("second chunk");
			expect(rendered).not.toContain("Code Mode");
			component.dispose();
		} finally {
			disposeAdapter();
		}
	});

	test("folds from the shared code-mode header and leaves expanded body clicks unclaimed", () => {
		const value = result();
		value.content = [{ type: "text", text: "visible result" }];
		value.details.nestedCalls = [];
		const component = renderCodeModeResult(value, { expanded: true, isPartial: false }, theme, context({}));
		component.render(80);
		const disclosure = component.children[0] as unknown as {
			children: Array<{
				onMouse?(event: TuiMouseEvent): boolean;
				handleViewportInput?(data: string): boolean;
			}>;
		};
		const action = disclosure.children[0]!;
		const body = disclosure.children[1]!;
		expect(action.onMouse?.(mouse("press", 0, 1, 0))).toBe(true);
		expect(action.onMouse?.(mouse("release", 0, 1, 0))).toBe(true);
		const folded = Bun.stripANSI(component.render(80).join("\n"));
		expect(folded).toContain(icon("fold-closed"));
		expect(folded).not.toContain("Code\n");
		expect(action.handleViewportInput?.("\r")).toBe(true);
		component.render(80);
		expect(body.onMouse?.(mouse("press", 1, 8, 0))).toBe(false);
		component.dispose();
	});

	test("opens a nested renderer-owned omission through the outer body", () => {
		const value = result();
		value.content = [];
		value.details.nestedCalls[0]!.name = "unknown_nested_tool";
		value.details.nestedCalls[0]!.result = {
			...value.details.nestedCalls[0]!.result,
			content: [{ type: "text", text: Array.from({ length: 12 }, (_, index) => `line-${index}`).join("\n") }],
		};
		const component = renderCodeModeResult(value, { expanded: false, isPartial: false }, theme, context({}));
		const collapsedLines = component.render(80);
		const omissionRow = collapsedLines.findIndex((line) => Bun.stripANSI(line).includes("…"));
		const disclosure = component.children[0] as unknown as {
			children: Array<{ onMouse?(event: TuiMouseEvent): boolean }>;
		};
		const body = disclosure.children[1]!;
		expect(omissionRow).toBeGreaterThan(0);
		expect(body.onMouse?.(mouse("press", omissionRow - 1, 5, 0))).toBe(true);
		expect(body.onMouse?.(mouse("release", omissionRow - 1, 5, 0))).toBe(true);

		const expanded = Bun.stripANSI(component.render(80).join("\n"));
		expect(expanded).toContain("line-11");
		expect(expanded).not.toContain("…");
		component.dispose();
	});

	test("keeps a compact nested disclosure interactive without a Code Mode row", () => {
		const disposeAdapter = registerNestedToolAdapter({
			name: "nested_disclosure",
			kind: "function",
			parameters: {},
			invoke: () => ({ content: [], details: undefined }),
			renderTrace(_trace, context) {
				return new ToolActivity({
					theme: context.theme,
					requestRender: context.requestRender,
					view: {
						action: { verb: "Nested disclosure", status: "succeeded" },
						payload: {
							kind: "component",
							preview: new ComponentStack(),
							full: new MarkdownText({ theme: context.theme, text: "Nested details" }),
						},
					},
				});
			},
		});
		try {
			const value = result();
			value.details.nestedCalls[0]!.name = "nested_disclosure";
			const rendererContext = context({});
			let component: ReturnType<typeof renderCodeModeResult>;
			rendererContext.invalidate = () => component.invalidate();
			component = renderCodeModeResult(value, { expanded: false, isPartial: false }, theme, rendererContext);
			const compact = component.render(80);
			const nested = component.children[0] as unknown as {
				onMouse?(event: TuiMouseEvent): boolean;
			};
			expect(Bun.stripANSI(compact.join("\n"))).not.toContain("Code Mode");
			expect(nested.onMouse?.(mouse("move", 0, 1))).toBe(true);
			const hovered = component.render(80);
			expect(hovered).not.toEqual(compact);
			expect(nested.onMouse?.(mouse("press", 0, 1, 0))).toBe(true);
			expect(nested.onMouse?.(mouse("release", 0, 1, 0))).toBe(true);
			expect(Bun.stripANSI(component.render(80).join("\n"))).toContain("Nested details");
			component.dispose();
		} finally {
			disposeAdapter();
		}
	});

	test("keeps nested calls in the expanded outer bounded fold", () => {
		const value = result();
		value.content = [];
		const base = value.details.nestedCalls[0]!;
		value.details.nestedCalls = Array.from({ length: 8 }, (_, index) => ({
			...base,
			id: `nested-${index}`,
			name: "unknown_nested_tool",
			input: { cmd: `printf ${index}` },
			result: {
				...base.result,
				content: [{ type: "text", text: Array.from({ length: 4 }, (_, line) => `nested-${index}-${line}`).join("\n") }],
			},
		}));
		const component = renderCodeModeResult(value, { expanded: true, isPartial: false }, theme, context({}));
		const collapsed = Bun.stripANSI(component.render(80).join("\n"));
		expect(collapsed).toContain("Used unknown_nested_tool");
		const disclosure = component.children[0] as unknown as {
			children: Array<{
				onMouse?(event: TuiMouseEvent): boolean;
				handleViewportInput?(data: string): boolean;
			}>;
		};
		const action = disclosure.children[0]!;
		const body = disclosure.children[1]!;
		const expanded = Bun.stripANSI(component.render(80).join("\n"));
		expect(expanded).toContain("Used unknown_nested_tool");
		expect(component.render(80)).toHaveLength(20);
		expect(body.handleViewportInput?.("\u001b[B")).toBe(true);
		expect(component.render(80)).toHaveLength(20);
		expect(action.onMouse?.(mouse("press", 0, 1, 0))).toBe(true);
		expect(action.onMouse?.(mouse("release", 0, 1, 0))).toBe(true);
		const folded = Bun.stripANSI(component.render(80).join("\n"));
		expect(folded).toContain("Used unknown_nested_tool");
		expect(folded).not.toContain("Code    Result");
		component.dispose();
	});

	test("keeps expanded code bounded while preserving shared viewport scrolling", () => {
		const value = result();
		value.content = [{ type: "text", text: "visible result" }];
		value.details.nestedCalls = [];
		value.details.input = {
			code: Array.from({ length: 60 }, (_, index) => `const line${index} = ${index};`).join("\n"),
		};
		const component = renderCodeModeResult(value, { expanded: true, isPartial: false }, theme, context({}));
		const lines = component.render(80);
		expect(lines.length).toBe(20);
		const disclosure = component.children[0] as unknown as {
			children: Array<{ handleViewportInput?(data: string): boolean }>;
		};
		expect(disclosure.children[1]!.handleViewportInput?.("\u001b[B")).toBe(true);
		expect(component.render(80)).toHaveLength(20);
		component.dispose();
	});
});

class StreamingNestedExec implements NestedToolPresentationComponent {
	private output: string;

	constructor(trace: NestedToolPresentationTrace) {
		this.output = traceOutput(trace);
	}

	update(trace: NestedToolPresentationTrace): void {
		this.output = traceOutput(trace);
	}

	render(_width: number): string[] {
		return [`$ exec_command`, ...this.output.split("\n")];
	}

	invalidate(): void {}
}

function resultWithNestedTrace(status: "running" | "done", output: string): AgentToolResult<CodeModeToolDetails> {
	const value = result();
	value.content = [];
	value.details.input = { code: 'text(await tools.exec_command({ cmd: "printf output" }))' };
	value.details.nestedCalls = [
		{
			version: 1,
			id: "streaming-exec-command",
			name: "exec_command",
			kind: "function",
			input: { cmd: "printf output" },
			status,
			startedAtMs: 101,
			...(status === "done" ? { durationMs: 8 } : {}),
			result: { content: [{ type: "text", text: output }] },
		},
	];
	return value;
}

function traceOutput(trace: NestedToolPresentationTrace): string {
	return (
		trace.result?.content
			.flatMap((item) => {
				if (!item || typeof item !== "object") return [];
				const text = Reflect.get(item, "text");
				return typeof text === "string" ? [text] : [];
			})
			.join("\n") ?? ""
	);
}

function mouse(type: TuiMouseEvent["type"], row: number, col: number, button?: 0 | 1 | 2): TuiMouseEvent {
	return {
		type,
		row,
		col,
		screenRow: row,
		screenCol: col,
		button,
		wheel: undefined,
		shift: false,
		alt: false,
		ctrl: false,
	};
}
