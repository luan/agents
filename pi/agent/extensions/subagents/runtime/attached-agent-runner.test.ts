import { expect, test } from "bun:test";
import { runAttachedAgent } from "./attached-agent-runner";

test("attached agent startup honors cancellation before launching its terminal", async () => {
	const controller = new AbortController();
	controller.abort();
	await expect(
		runAttachedAgent({} as never, "task", "work", "root", "agent", {
			signal: controller.signal,
		} as never),
	).rejects.toThrow();
});
