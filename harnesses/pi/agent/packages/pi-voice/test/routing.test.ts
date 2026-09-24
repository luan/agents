import { expect, test } from "bun:test";
import { RealtimeVoiceTurnTracker } from "../src/turns.ts";
import { RealtimeDelegationHandoff } from "../src/conversation/handoff.ts";
import { validPhoneToken } from "../src/lan/server.ts";

test("a delegated voice request is emitted once and later transcript completion is not duplicated", () => {
	const tracker = new RealtimeVoiceTurnTracker();
	tracker.inputAdded("Check the build");
	const turn = tracker.delegated("Check the build", "first");
	expect(turn?.turn.input).toBe("Check the build");
	expect(tracker.delegated("Check the build", "first")).toBeUndefined();
	expect(tracker.delegated("Check the build", "duplicate")).toBeUndefined();
	expect(tracker.userFinished("Check the build")).toBe(false);
});

test("voice progress streams without waiting for the final backend turn", () => {
	const sent: { channel: string; content: string }[] = [];
	const settled: string[] = [];
	const handoff = new RealtimeDelegationHandoff({
		isActive: () => true,
		onContext: (_target, channel, content) => sent.push({ channel, content }),
		onSettled: (id) => settled.push(id),
	});
	handoff.activate("work");
	handoff.stream("The build finished. The tests are running. All tests passed.");
	expect(sent.length).toBeGreaterThan(0);
	handoff.result("The build finished. The tests are running. All tests passed.");
	handoff.settle();
	expect(sent.map((item) => item.content).join("\n")).toContain("All tests passed.");
	expect(settled).toEqual(["work"]);
});

test("phone access compares the full token without accepting a prefix or missing token", () => {
	expect(validPhoneToken("private-token", "private-token")).toBe(true);
	expect(validPhoneToken("private", "private-token")).toBe(false);
	expect(validPhoneToken("", "private-token")).toBe(false);
	expect(validPhoneToken("private-tokem", "private-token")).toBe(false);
});
