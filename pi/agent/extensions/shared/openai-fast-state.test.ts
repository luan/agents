import { expect, test } from "bun:test";
import { onOpenAIFastRequest } from "./openai-fast-state";

test("fast request state crosses cache-busted extension modules", async () => {
	const events: unknown[] = [];
	const unsubscribe = onOpenAIFastRequest((event) => events.push(event));
	const { emitOpenAIFastRequest } = await import(`./openai-fast-state.ts?child=${Date.now()}`);

	emitOpenAIFastRequest({ active: true, sessionFile: "/tmp/child.jsonl" });

	expect(events).toEqual([{ active: true, sessionFile: "/tmp/child.jsonl" }]);
	unsubscribe();
});
