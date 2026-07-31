import { expect, test } from "bun:test";
import openAIFastExtension from "./index";

test("fast toggle survives new sessions for the current runtime and alt+g uses the same state", async () => {
	const handlers = new Map<string, (...args: any[]) => any>();
	const commands = new Map<string, any>();
	const shortcuts = new Map<string, any>();
	const statuses: Array<[string, string | undefined]> = [];
	const notifications: string[] = [];
	const pi = {
		on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerShortcut: (key: string, shortcut: any) => shortcuts.set(key, shortcut),
	} as any;
	openAIFastExtension(pi);

	const context = (sessionManager: object) =>
		({
			cwd: process.cwd(),
			hasUI: true,
			model: {
				provider: "openai-codex",
				id: "gpt-5.6-sol",
				api: "openai-codex-responses",
			},
			modelRegistry: { isUsingOAuth: () => true },
			sessionManager,
			ui: {
				setStatus: (key: string, value: string | undefined) => statuses.push([key, value]),
				notify: (message: string) => notifications.push(message),
			},
		}) as any;

	const first = context({});
	handlers.get("session_start")?.({}, first);
	await commands.get("fast").handler("", first);
	expect(notifications.at(-1)).toContain("on (runtime override)");
	const childHandlers = new Map<string, (...args: any[]) => any>();
	openAIFastExtension({
		on: (name: string, handler: (...args: any[]) => any) => childHandlers.set(name, handler),
		registerCommand: () => {},
		registerShortcut: () => {},
	} as any);
	const child = context({});
	childHandlers.get("session_start")?.({}, child);
	expect(childHandlers.get("before_provider_request")?.({ payload: { model: "gpt-5.6-sol" } }, child)).toMatchObject({
		service_tier: "priority",
	});

	const second = context({});
	handlers.get("session_start")?.({}, second);
	expect(handlers.get("before_provider_request")?.({ payload: { model: "gpt-5.6-sol" } }, second)).toMatchObject({
		service_tier: "priority",
	});
	expect(statuses.at(-1)).toEqual(["openai-fast:active", "fast"]);

	await shortcuts.get("alt+g").handler(second);
	const third = context({});
	handlers.get("session_start")?.({}, third);
	expect(handlers.get("before_provider_request")?.({ payload: { model: "gpt-5.6-sol" } }, third)).toBeUndefined();
	expect(statuses.at(-1)).toEqual(["openai-fast:active", undefined]);
});
