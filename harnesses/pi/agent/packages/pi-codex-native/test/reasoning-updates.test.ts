import { expect, test } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	REASONING_ENTRY,
	reasoningHistory,
	reasoningRequest,
	normalizeConfigurationUpdates,
} from "../src/provider/reasoning-updates.ts";
import { buildCachedWebSocketRequestBody } from "../src/provider/websocket-continuation.ts";
import type { ResponsesBody } from "../src/provider/types.ts";

const body: ResponsesBody = {
	model: "gpt-6-astra",
	store: false,
	stream: true,
	input: [{ role: "user", content: "Start" }],
	text: { verbosity: "low" },
	include: [],
	tool_choice: "auto",
	parallel_tool_calls: false,
	reasoning: { effort: "low", summary: "auto" },
};
const answer = { type: "message", role: "assistant", content: "Working" };
const next = {
	...body,
	input: [...body.input, answer, { role: "user", content: "Continue" }],
	reasoning: { effort: "high", summary: "auto" },
};

test("effort changes preserve the initial body and WebSocket continuation prefix", () => {
	const first = reasoningRequest(body, [], "initial");
	expect(first.body).toEqual(body);
	const second = reasoningRequest(next, first.entries, "initial");
	expect(second.body.reasoning).toEqual(body.reasoning);
	expect(second.body.input).toEqual([...next.input, { type: "configuration_update", reasoning: { effort: "high" } }]);
	const continued = buildCachedWebSocketRequestBody(
		{ lastRequestBody: first.body, lastResponseId: "resp_1", lastResponseItems: [answer] },
		second.body,
	);
	expect(continued.decision).toBe("delta");
	expect(continued.body.input).toEqual(second.body.input.slice(2));
	const third = reasoningRequest({ ...next, input: [...next.input, answer] }, second.entries, "initial");
	expect(third.added).toBeUndefined();
	expect(third.body.input).toEqual([...second.body.input, answer]);
});

test("resume and inherited history retain effort boundaries; a divergent branch resets them", () => {
	const manager = SessionManager.inMemory();
	const first = reasoningRequest(body, [], "initial");
	manager.appendCustomEntry(REASONING_ENTRY, first.added);
	const second = reasoningRequest(next, reasoningHistory(manager.getBranch()), "initial");
	manager.appendCustomEntry(REASONING_ENTRY, second.added);
	expect(reasoningRequest(next, reasoningHistory(manager.getBranch()), "initial").body).toEqual(second.body);
	const branch = reasoningRequest(
		{ ...next, input: [{ role: "user", content: "Different branch" }] },
		reasoningHistory(manager.getBranch()),
		"initial",
	);
	expect(branch.added?.reset).toBe(true);
	expect(branch.body.reasoning?.effort).toBe("high");
	expect(branch.body.input).toHaveLength(1);
});

test("successful compaction starts a new baseline, while retries preserve updates", () => {
	const first = reasoningRequest(body, [], "initial");
	const changed = reasoningRequest(next, first.entries, "initial");
	expect(reasoningRequest(next, changed.entries, "initial").body).toEqual(changed.body);
	const compacted = reasoningRequest(next, changed.entries, "compaction-1");
	expect(compacted.body.reasoning?.effort).toBe("high");
	expect(compacted.body.input).toEqual(next.input);
});

test("Persistent disabled effort uses the same native update path", () => {
	const first = reasoningRequest(body, [], "initial");
	const persistent = reasoningRequest({ ...next, reasoning: { effort: "disabled" } }, first.entries, "initial");
	expect(persistent.body.reasoning?.effort).toBe("low");
	expect(persistent.body.input.at(-1)).toEqual({ type: "configuration_update", reasoning: { effort: "disabled" } });
	const ordinary = reasoningRequest({ ...next, input: [...next.input, answer] }, persistent.entries, "initial");
	expect(ordinary.body.input.at(-1)).toEqual({ type: "configuration_update", reasoning: { effort: "high" } });
});

test("native updates coalesce, stay Astra-only, and reject server automatic truncation", () => {
	const updates = ["low", "high"].map((effort) => ({ type: "configuration_update", reasoning: { effort } }));
	expect(normalizeConfigurationUpdates({ ...body, input: [...body.input, ...updates] }).input).toEqual([
		...body.input,
		updates[1],
	]);
	expect(
		normalizeConfigurationUpdates({ ...body, model: "gpt-5.6-luna", input: [...body.input, ...updates] }).input,
	).toEqual(body.input);
	expect(() => normalizeConfigurationUpdates({ ...body, truncation: "auto", input: updates })).toThrow(
		"explicit compaction",
	);
	const manager = SessionManager.inMemory();
	manager.appendCustomEntry(REASONING_ENTRY, { version: 1, effort: "custom" });
	expect(() => reasoningHistory(manager.getBranch())).toThrow("Malformed");
});

test("changing current developer context does not reinterpret historical effort", () => {
	const first = reasoningRequest(
		{ ...body, input: [{ role: "developer", content: "Remaining context: 10000" }, ...body.input] },
		[],
		"initial",
	);
	const second = reasoningRequest(
		{ ...next, input: [{ role: "developer", content: "Remaining context: 9000" }, ...next.input] },
		first.entries,
		"initial",
	);
	expect(second.body.reasoning?.effort).toBe("low");
	expect(second.added?.reset).toBeUndefined();
	expect(second.body.input.at(-1)).toEqual({ type: "configuration_update", reasoning: { effort: "high" } });
	const third = reasoningRequest(
		{
			...next,
			input: [{ role: "developer", content: "Remaining context: 8000" }, ...next.input, answer],
			reasoning: { effort: "low" },
		},
		second.entries,
		"initial",
	);
	expect(third.body.input.slice(-3)).toEqual([
		{ type: "configuration_update", reasoning: { effort: "high" } },
		answer,
		{ type: "configuration_update", reasoning: { effort: "low" } },
	]);
});
