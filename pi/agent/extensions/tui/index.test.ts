import { afterEach, describe, expect, test } from "bun:test";
import { setEditorChromeProvider, setEditorSessionIdentityProvider } from "./editor";
import registerTui from "./index";

afterEach(() => {
	setEditorChromeProvider(undefined);
	setEditorSessionIdentityProvider(undefined);
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
