import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CODEX_NATIVE_SETTINGS } from "../src/contributions/xsettings.ts";
import {
	PERSISTENT_ENTRY,
	persistentHistory,
	persistentInstructions,
	persistentRequest,
} from "../src/provider/persistent-mode.ts";
import type { ResponsesBody } from "../src/provider/types.ts";

const tools = ["request_user_input_async", "send_message_to_user_async", "clock__sleep", "clock__curr_time"];
const body: ResponsesBody = {
	model: "gpt-6-astra",
	store: false,
	stream: true,
	input: [{ role: "user", content: "Inspect the repo" }],
	instructions: "User-owned provider instructions",
	tools: tools.map((name) => ({ type: "function", name })),
	text: { verbosity: "low" },
	include: [],
	tool_choice: "auto",
	parallel_tool_calls: false,
	reasoning: { effort: "high", summary: "auto" },
};
const now = Date.parse("2026-09-13T12:00:00Z");
const settings = { reasoningMode: "persistent", currentTimeReminder: "auto" } as const;
const nextBody = {
	...body,
	input: [...body.input, { role: "assistant", content: "Checking." }, { role: "user", content: "Continue" }],
};

test("vendored prompts match the pinned Codex revision byte for byte", () => {
	for (const [file, hash] of [
		["persistent-mode.md", "03ff9da48abb85425514c42dad1b742312bc7e2d978d2941e9d2fd90560c2a27"],
		["persistent-mode-astra.md", "30747e79e50efb64f91cfff3d5ef1882e347081e81448918d5f7d5358e98c523"],
	])
		expect(
			createHash("sha256")
				.update(readFileSync(new URL(`../assets/${file}`, import.meta.url)))
				.digest("hex"),
		).toBe(hash!);
});

test("ordinary mode preserves reasoning and async tools", () => {
	const result = persistentRequest(body, DEFAULT_CODEX_NATIVE_SETTINGS, tools, now);
	expect(result.body).toBe(body);
	expect(result.added).toBeUndefined();
});

test("Astra catalog wins, with exact upstream text, and other models use fallback", () => {
	const result = persistentRequest(body, settings, tools, now);
	expect(result.body.reasoning).toEqual({ effort: "disabled", summary: "auto" });
	expect(result.body.tools).toBe(body.tools);
	expect(result.body.instructions).toBe(body.instructions);
	expect(result.body.input[1]).toEqual({
		role: "developer",
		content: `<persistent_mode>\n${persistentInstructions("gpt-6-astra", true)}\n</persistent_mode>`,
	});
	expect(result.added?.instructions).toContain("Because a `final` answer immediately ends the turn");
	expect(result.added?.instructions).not.toContain("replace all previously");
	const other = persistentRequest({ ...body, model: "gpt-5.5" }, settings, tools, now);
	expect(other.added?.instructions).toContain("After you've completed the user task");
	expect(other.added?.instructions).toContain("via functions.send_user_message_async");
});

test("unchanged state preserves the request prefix; due clocks append after new messages", () => {
	const first = persistentRequest(body, settings, tools, now);
	const soon = persistentRequest(nextBody, settings, tools, now + 900, first.state);
	expect(soon.added?.instructions).toBeUndefined();
	expect(soon.added?.reminderTime).toBeUndefined();
	expect(soon.body.input).toEqual([...first.body.input, ...nextBody.input.slice(1)]);
	const later = persistentRequest(nextBody, settings, tools, now + 1000, soon.state);
	expect(later.body.input.slice(0, -1)).toEqual(soon.body.input);
	expect(later.body.input.at(-1)).toEqual({
		role: "developer",
		content: "<current_time_reminder>It is 2026-09-13 12:00:01 UTC.</current_time_reminder>",
	});
	expect(later.added?.instructions).toBeUndefined();
});

test("model and mode changes record replacements, a single removal, and fresh reactivation", () => {
	const first = persistentRequest(body, settings, tools, now);
	const changed = persistentRequest({ ...nextBody, model: "gpt-5.5" }, settings, tools, now, first.state);
	expect(JSON.stringify(changed.body.input.at(-1))).toContain("replace all previously provided");
	const off = persistentRequest(nextBody, DEFAULT_CODEX_NATIVE_SETTINGS, tools, now, changed.state);
	expect(off.body.reasoning).toEqual(body.reasoning);
	expect(off.body.input.at(-1)).toEqual({
		role: "developer",
		content:
			"<persistent_mode>\nThe previously provided persistent-mode instructions no longer apply.\n</persistent_mode>",
	});
	const again = persistentRequest(nextBody, DEFAULT_CODEX_NATIVE_SETTINGS, tools, now + 1000, off.state);
	expect(again.added).toBeUndefined();
	expect(again.body).toEqual(off.body);
	const on = persistentRequest(nextBody, settings, tools, now, again.state);
	expect(JSON.stringify(on.body.input.at(-1))).not.toContain("replace all previously");
});

test("explicit clock settings override persistent defaults without removing recorded history", () => {
	const off = persistentRequest(body, { ...settings, currentTimeReminder: "off" }, [], now);
	expect(JSON.stringify(off.body.input)).not.toContain("current_time_reminder");
	const ordinary = persistentRequest(body, { reasoningMode: "pi", currentTimeReminder: "on" }, tools, now);
	expect(ordinary.body.input).toHaveLength(2);
	expect(ordinary.body.reasoning).toEqual(body.reasoning);
});

test("journal resumes, follows branches, validates saved entries, and resets stale context", () => {
	const session = SessionManager.inMemory();
	const first = persistentRequest(body, settings, tools, now);
	const fork = session.appendCustomEntry(PERSISTENT_ENTRY, first.added!);
	const restored = persistentRequest(nextBody, settings, tools, now, persistentHistory(session.getBranch()));
	expect(restored.added?.instructions).toBeUndefined();
	expect(restored.added?.reminderTime).toBeUndefined();
	expect(restored.body.input).toEqual([...first.body.input, ...nextBody.input.slice(1)]);
	const off = persistentRequest(nextBody, DEFAULT_CODEX_NATIVE_SETTINGS, tools, now, restored.state);
	session.appendCustomEntry(PERSISTENT_ENTRY, off.added!);
	session.branch(fork);
	expect(persistentHistory(session.getBranch())).toEqual(first.state);
	session.appendCustomEntry(PERSISTENT_ENTRY, { version: 1, at: -1, prefix: "bad", instructions: 2 });
	expect(persistentHistory(session.getBranch())).toEqual(first.state);
	const reset = persistentRequest(
		{ ...body, input: [{ role: "user", content: "Fresh context" }] },
		settings,
		tools,
		now,
		restored.state,
		"new-window",
	);
	expect(reset.added?.reset).toBe(true);
	expect(reset.body.input).toHaveLength(3);
	session.appendCustomEntry(PERSISTENT_ENTRY, reset.added!);
	expect(persistentHistory(session.getBranch())).toEqual(reset.state);
	const fresh = persistentRequest(body, DEFAULT_CODEX_NATIVE_SETTINGS, tools, now, restored.state, "new-window");
	expect(JSON.stringify(fresh.body.input)).not.toContain("persistent_mode");
});

test("developer context survives an actual Pi session file close and reopen", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-persistent-resume-"));
	try {
		const manager = SessionManager.create(directory, directory);
		manager.appendMessage({ role: "user", content: "Inspect the repo", timestamp: now });
		const first = persistentRequest(body, settings, tools, now);
		manager.appendCustomEntry(PERSISTENT_ENTRY, first.added!);
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "Done." }],
			api: "openai-codex-responses",
			provider: "openai-codex",
			model: "gpt-6-astra",
			timestamp: now,
			stopReason: "stop",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		const restored = SessionManager.open(manager.getSessionFile()!);
		const replay = persistentRequest(nextBody, settings, tools, now, persistentHistory(restored.getBranch()));
		expect(replay.added?.instructions).toBeUndefined();
		expect(replay.added?.reminderTime).toBeUndefined();
		expect(replay.body.input).toEqual([...first.body.input, ...nextBody.input.slice(1)]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("native transport serializes configured Persistent and restores ordinary requests", async () => {
	const { zstdDecompressSync } = await import("node:zlib");
	const { CodexProviderRuntime } = await import("../src/provider/runtime.ts");
	const { getCodexModels } = await import("../src/provider/models.ts");
	const requests: string[] = [];
	let mode: "pi" | "persistent" = "persistent";
	const runtime = new CodexProviderRuntime({
		getSettings: () => ({ ...DEFAULT_CODEX_NATIVE_SETTINGS, reasoningMode: mode }),
		now: () => now,
	});
	const model = getCodexModels().find((model) => model.id === "gpt-6-astra")!;
	const capture: typeof fetch = Object.assign(
		async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const request = new Request(input, init);
			const bytes = Buffer.from(await request.arrayBuffer());
			requests.push(
				(request.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(bytes) : bytes).toString(),
			);
			const events = [
				{
					type: "response.output_item.done",
					output_index: 0,
					item: {
						type: "message",
						id: "message-1",
						role: "assistant",
						content: [{ type: "output_text", text: "Done." }],
					},
				},
				{
					type: "response.completed",
					response: {
						id: `response-${requests.length}`,
						status: "completed",
						usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
					},
				},
			];
			return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
				headers: { "content-type": "text/event-stream" },
			});
		},
		{ preconnect: fetch.preconnect },
	);
	const account = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "local-test" } }),
	).toString("base64url");
	try {
		for (const nextMode of ["persistent", "pi"] as const) {
			mode = nextMode;
			const stream = runtime.streamSimple(
				model,
				{ messages: [{ role: "user", content: "Hello", timestamp: now }] },
				{
					apiKey: `test.${account}.signature`,
					sessionId: "persistent-test",
					transport: "sse",
					reasoning: "high",
					fetch: capture,
				},
			);
			const result = await stream.result();
			expect(result.stopReason).toBe("stop");
		}
		expect(requests).toHaveLength(2);
		expect(JSON.parse(requests[0]!)).toMatchObject({ reasoning: { effort: "disabled" } });
		expect(requests[0]).toContain("current_time_reminder");
		expect(JSON.parse(requests[1]!)).toMatchObject({ reasoning: { effort: "disabled" } });
		expect(JSON.parse(requests[1]!).input.at(-1)).toEqual({
			type: "configuration_update",
			reasoning: { effort: "high" },
		});
		expect(requests[1]).toContain("no longer apply");
		expect(requests[1].match(/current_time_reminder>/g)).toHaveLength(2);
	} finally {
		runtime.shutdown();
	}
});

test("reminder delivery consumes a user boundary even when its interval suppresses the reminder", () => {
	const clock = {
		...settings,
		currentTimeReminderIntervalSeconds: "2",
		currentTimeReminderDelivery: "after_user_or_tool_output" as const,
	};
	const first = persistentRequest(body, clock, tools, now);
	const early = persistentRequest(nextBody, clock, tools, now + 1000, first.state);
	expect(early.added?.reminderTime).toBeUndefined();
	const noBoundary = persistentRequest(nextBody, clock, tools, now + 3000, early.state);
	expect(noBoundary.added).toBeUndefined();
	const output = {
		...nextBody,
		input: [...nextBody.input, { type: "function_call_output", call_id: "call", output: "done" }],
	};
	const due = persistentRequest(output, clock, tools, now + 3000, noBoundary.state);
	expect(due.added?.reminderTime).toBe(now + 3000);
	const reset = persistentRequest(body, clock, tools, now + 3001, due.state, "fresh");
	expect(reset.added?.reminderTime).toBe(now + 3001);
	const zero = persistentRequest(
		body,
		{ ...settings, currentTimeReminderIntervalSeconds: "0" },
		tools,
		now,
		first.state,
	);
	expect(zero.added?.reminderTime).toBe(now);
	expect(() => persistentRequest(body, { ...settings, currentTimeReminderIntervalSeconds: "-1" }, tools, now)).toThrow(
		"Time reminder interval",
	);
	const huge = persistentRequest(
		body,
		{ ...settings, currentTimeReminderIntervalSeconds: "18446744073709551615" },
		tools,
		now + 100000,
		first.state,
	);
	expect(huge.added?.reminderTime).toBeUndefined();
});
