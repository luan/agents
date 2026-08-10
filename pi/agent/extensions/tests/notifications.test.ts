import { expect, test } from "bun:test";
import { isSubagentSessionFile } from "../notifications";

test("notification guard identifies subagent sessions", () => {
	expect(isSubagentSessionFile("/home/user/.pi/agent/sessions/subagents/root/sessions/worker/session.jsonl")).toBe(
		true,
	);
	expect(isSubagentSessionFile("C:\\Users\\user\\.pi\\agent\\sessions\\subagents\\root\\session.jsonl")).toBe(true);
	expect(isSubagentSessionFile("/home/user/.pi/agent/sessions/project/session.jsonl")).toBe(false);
	expect(isSubagentSessionFile(undefined)).toBe(false);
});
