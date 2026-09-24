import { expect, test } from "bun:test";
import { Type } from "typebox";
import { DEFAULT_CODEX_NATIVE_SETTINGS as defaults } from "../src/contributions/xsettings.ts";
import { conversationToolAllowed } from "../src/provider/conversation-policy.ts";
import { getCodexModels } from "../src/provider/models.ts";
import { buildRequestBody } from "../src/provider/request-body.ts";
import { localFunctionName, wireFunctionName } from "../src/responses/tool-names.ts";

test("Codex catalog and explicit flags control async tools independently of persistence", () => {
	for (const persistent of ["pi", "persistent"] as const) {
		const settings = { ...defaults, reasoningMode: persistent };
		expect(conversationToolAllowed("request_user_input_async", "gpt-6-astra", false, settings)).toBe(true);
		expect(conversationToolAllowed("request_user_input_async", "gpt-5.6-sol", false, settings)).toBe(false);
		expect(conversationToolAllowed("send_message_to_user_async", "gpt-6-astra", false, settings)).toBe(false);
		expect(
			conversationToolAllowed("send_message_to_user_async", "gpt-5.6-sol", false, {
				...settings,
				sendMessageToUserAsync: true,
			}),
		).toBe(true);
		for (const name of ["request_user_input_async", "send_message_to_user_async"])
			expect(conversationToolAllowed(name, "gpt-6-astra", true, { ...settings, sendMessageToUserAsync: true })).toBe(
				false,
			);
	}
});

test("clock selection follows reminder, feature, and model-driven sleep policy", () => {
	expect(conversationToolAllowed("clock__sleep", "gpt-6-astra", false, defaults)).toBe(true);
	expect(conversationToolAllowed("clock__sleep", "gpt-5.6-sol", false, defaults)).toBe(false);
	expect(
		conversationToolAllowed("clock__sleep", "gpt-5.6-sol", false, { ...defaults, reasoningMode: "persistent" }),
	).toBe(true);
	expect(
		conversationToolAllowed("clock__sleep", "gpt-6-astra", false, { ...defaults, currentTimeReminder: "on" }),
	).toBe(false);
	expect(
		conversationToolAllowed("clock__sleep", "gpt-6-astra", false, {
			...defaults,
			currentTimeReminder: "on",
			currentTimeReminderSleep: "on",
		}),
	).toBe(true);
	expect(
		conversationToolAllowed("clock__sleep", "gpt-5.6-sol", false, { ...defaults, sleepToolMode: "always_on" }),
	).toBe(true);
	expect(
		conversationToolAllowed("clock__sleep", "gpt-6-astra", false, {
			...defaults,
			sleepTool: false,
			sleepToolMode: "always_on",
		}),
	).toBe(false);
	expect(
		conversationToolAllowed("clock__curr_time", "gpt-5.6-sol", false, { ...defaults, currentTimeReminder: "on" }),
	).toBe(true);
});

test("native clock namespace maps calls to Pi and replays with its original wire names", () => {
	const model = getCodexModels().find((model) => model.id === "gpt-6-astra")!;
	const body = buildRequestBody(model, {
		messages: [],
		tools: [
			{ name: "clock__sleep", description: "Wait", parameters: Type.Object({ duration_ms: Type.Number() }) },
			{ name: "clock__curr_time", description: "Time", parameters: Type.Object({}) },
		],
	});
	expect(body.tools).toMatchObject([
		{
			type: "namespace",
			name: "clock",
			tools: [
				{ type: "function", name: "sleep" },
				{ type: "function", name: "curr_time" },
			],
		},
	]);
	expect(localFunctionName("sleep", "clock")).toBe("clock__sleep");
	expect(wireFunctionName("clock__sleep", "clock")).toEqual({ name: "sleep", namespace: "clock" });
	expect(localFunctionName("sleep", "other")).toBe("sleep");
});
