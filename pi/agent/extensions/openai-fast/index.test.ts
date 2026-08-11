import { expect, test } from "bun:test";
import { setOpenAIFastOverride, setOpenAIFastRoleEnabled } from "../shared/openai-fast-state";
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
		events: { emit() {} },
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
	const { default: childOpenAIFastExtension } = await import(`./index.ts?child=${Date.now()}`);
	childOpenAIFastExtension({
		on: (name: string, handler: (...args: any[]) => any) => childHandlers.set(name, handler),
		registerCommand: () => {},
		registerShortcut: () => {},
		events: { emit() {} },
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
	expect(statuses).toContainEqual(["openai-fast:request", "fast"]);
	expect(statuses).toContainEqual(["openai-fast:active", "fast"]);
	handlers.get("message_end")?.({}, second);
	expect(statuses.at(-1)).toEqual(["openai-fast:request", undefined]);

	await shortcuts.get("alt+g").handler(second);
	const third = context({});
	handlers.get("session_start")?.({}, third);
	expect(handlers.get("before_provider_request")?.({ payload: { model: "gpt-5.6-sol" } }, third)).toBeUndefined();
	expect(statuses.at(-1)).toEqual(["openai-fast:active", undefined]);
});

test("model role fast enables status and request injection", () => {
	setOpenAIFastOverride("auto");
	const handlers = new Map<string, (...args: any[]) => any>();
	const statuses: Array<[string, string | undefined]> = [];
	const sessionFile = "/tmp/model-role-fast.json";
	const pi = {
		on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
		registerCommand: () => {},
		registerShortcut: () => {},
		events: { emit() {} },
	} as any;
	openAIFastExtension(pi);
	const ctx = {
		cwd: process.cwd(),
		hasUI: true,
		model: {
			provider: "openai-codex",
			id: "gpt-5.6-sol",
			api: "openai-codex-responses",
		},
		modelRegistry: { isUsingOAuth: () => true },
		sessionManager: { getSessionFile: () => sessionFile },
		ui: { setStatus: (key: string, value: string | undefined) => statuses.push([key, value]) },
	} as any;
	handlers.get("session_start")?.({}, ctx);
	setOpenAIFastRoleEnabled({ active: true, sessionFile });
	expect(statuses).toContainEqual(["openai-fast:active", "fast"]);
	expect(handlers.get("before_provider_request")?.({ payload: { model: "gpt-5.6-sol" } }, ctx)).toMatchObject({
		service_tier: "priority",
	});
	setOpenAIFastRoleEnabled({ active: false, sessionFile });
});
