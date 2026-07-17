import { afterEach, describe, expect, test } from "bun:test";
import { setEditorChromeProvider, setEditorSessionIdentityProvider } from "./editor";
import registerTui, { getUsageTotals } from "./index";

afterEach(() => {
	setEditorChromeProvider(undefined);
	setEditorSessionIdentityProvider(undefined);
});

test("includes persisted subagent usage in session totals", () => {
	const ctx = {
		sessionManager: {
			getBranch: () => [
				{
					type: "message",
					message: {
						role: "assistant",
						usage: { input: 100, output: 40, cost: { total: 0.25 } },
					},
				},
				{
					type: "custom",
					customType: "subagents:usage",
					data: { input: 300, output: 80, cost: 0.75 },
				},
			],
		},
	};

	expect(getUsageTotals(ctx as never)).toEqual({ input: 400, output: 120, cost: 1 });
});

describe("polished TUI session binding", () => {
	test("ignores in-memory subagent session_start events", async () => {
		const handlers: Record<string, Array<(event: unknown, ctx: any) => unknown>> = {};
		let footerInstalls = 0;
		let workingVisibleCalls = 0;
		const pi = createFakePi({
			onEvent: (event, handler) => {
				handlers[event] ??= [];
				handlers[event].push(handler);
			},
		});

		registerTui(pi as never);

		await handlers.session_start?.at(-1)?.({}, createCtx("/sessions/main.jsonl", "GPT-5"));
		await handlers.session_start?.at(-1)?.({}, createCtx(undefined, "Claude Haiku"));

		expect(footerInstalls).toBe(1);
		expect(workingVisibleCalls).toBe(1);

		function createCtx(sessionFile: string | undefined, modelName: string) {
			return {
				cwd: "/tmp/project",
				model: { name: modelName, provider: "unknown", contextWindow: 100_000 },
				modelRegistry: {},
				ui: {
					theme: {},
					setFooter() {
						footerInstalls++;
					},
					setWorkingVisible() {
						workingVisibleCalls++;
					},
				},
				sessionManager: {
					getSessionFile: () => sessionFile,
					getSessionName: () => "main",
					getEntries: () => [],
					getLeafId: () => undefined,
					getBranch: () => [],
				},
				getContextUsage: () => undefined,
				getSystemPrompt: () => "",
				isIdle: () => true,
			};
		}
	});
});

describe("polished TUI working animation", () => {
	test("self-stops if the session becomes idle before agent_end", async () => {
		const originalSetInterval = globalThis.setInterval;
		const originalClearInterval = globalThis.clearInterval;
		const intervals: Array<() => void> = [];
		let clearCalls = 0;
		let renderRequests = 0;
		let idle = false;
		const handlers: Record<string, Array<(event: unknown, ctx: any) => unknown>> = {};

		(globalThis as unknown as { setInterval: typeof setInterval }).setInterval = ((fn: () => void) => {
			intervals.push(fn);
			return { interval: intervals.length } as unknown as ReturnType<typeof setInterval>;
		}) as typeof setInterval;
		(globalThis as unknown as { clearInterval: typeof clearInterval }).clearInterval = (() => {
			clearCalls++;
		}) as typeof clearInterval;

		try {
			const pi = createFakePi({
				onEvent: (event, handler) => {
					handlers[event] ??= [];
					handlers[event].push(handler);
				},
			});
			registerTui(pi as never);

			const ctx = createCtx("/sessions/main.jsonl", {
				isIdle: () => idle,
				requestRender: () => renderRequests++,
			});
			await handlers.session_start?.at(-1)?.({}, ctx);
			await handlers.agent_start?.at(-1)?.({}, ctx);

			expect(intervals.length).toBeGreaterThan(0);
			expect(clearCalls).toBe(0);

			idle = true;
			intervals.at(-1)!();

			expect(clearCalls).toBe(1);
			expect(renderRequests).toBeGreaterThan(0);
		} finally {
			globalThis.setInterval = originalSetInterval;
			globalThis.clearInterval = originalClearInterval;
		}
	});
});

function createCtx(
	sessionFile: string | undefined,
	options: { modelName?: string; isIdle?: () => boolean; requestRender?: () => void } = {},
) {
	return {
		cwd: "/tmp/project",
		model: { name: options.modelName ?? "GPT-5", provider: "unknown", contextWindow: 100_000 },
		modelRegistry: {},
		ui: {
			theme: {},
			setFooter(factory: (tui: { requestRender: () => void }, theme: unknown, footerData: unknown) => unknown) {
				factory(
					{ requestRender: options.requestRender ?? (() => {}) },
					{},
					{ onBranchChange: () => () => {}, getExtensionStatuses: () => new Map() },
				);
			},
			setWorkingVisible() {},
		},
		sessionManager: {
			getSessionFile: () => sessionFile,
			getSessionName: () => "main",
			getEntries: () => [],
			getLeafId: () => undefined,
			getBranch: () => [],
		},
		getContextUsage: () => undefined,
		getSystemPrompt: () => "",
		isIdle: options.isIdle ?? (() => true),
	};
}

function createFakePi(options: {
	onEvent?: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void;
}) {
	return {
		registerCommand() {},
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			options.onEvent?.(event, handler);
			return () => {};
		},
		appendEntry() {},
		getThinkingLevel: () => undefined,
		events: {
			on() {
				return () => {};
			},
		},
	};
}
