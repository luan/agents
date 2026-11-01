import { expect, test } from "bun:test";
import { parseSSE, sleep } from "../src/provider/sse.ts";

test.each([true, false])("retry delay is cancellable (already aborted: %j)", async (alreadyAborted) => {
	const controller = new AbortController();
	if (alreadyAborted) controller.abort();
	const waiting = sleep(60_000, controller.signal);
	controller.abort();
	await expect(waiting).rejects.toThrow("Request was aborted");
});

test.each([true, false])("SSE cancellation releases the body (already aborted: %j)", async (alreadyAborted) => {
	let cancelled = false;
	const response = new Response(
		new ReadableStream<Uint8Array>({
			cancel() {
				cancelled = true;
			},
		}),
	);
	const controller = new AbortController();
	if (alreadyAborted) controller.abort();
	const iterator = parseSSE(response, controller.signal)[Symbol.asyncIterator]();
	const next = iterator.next();
	controller.abort();
	await expect(next).rejects.toThrow("Request was aborted");
	expect(cancelled).toBe(true);
	expect(response.body?.locked).toBe(false);
});

test("SSE cancellation stops events already buffered in the same chunk", async () => {
	const controller = new AbortController();
	const response = new Response('data: {"type":"first"}\n\ndata: {"type":"stale"}\n\n');
	const iterator = parseSSE(response, controller.signal)[Symbol.asyncIterator]();
	expect((await iterator.next()).value).toEqual({ type: "first" });
	controller.abort();
	await expect(iterator.next()).rejects.toThrow("Request was aborted");
	expect(response.body?.locked).toBe(false);
});

test.each(["\n", "\r", "\r\n"])("SSE handles %j line endings across arbitrary byte chunks", async (newline) => {
	const bytes = Buffer.from(
		[`data: {"type":"first","delta":"界😀"}`, "", 'data: {"type":"last"}', "", 'data: {"type":"incomplete"}'].join(
			newline,
		),
	);
	for (const chunkBytes of [1, 7, bytes.length]) {
		const response = new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					for (let offset = 0; offset < bytes.length; offset += chunkBytes)
						controller.enqueue(bytes.subarray(offset, offset + chunkBytes));
					controller.close();
				},
			}),
		);
		const events = [];
		for await (const event of parseSSE(response)) events.push(event);
		expect(events).toEqual([{ type: "first", delta: "界😀" }, { type: "last" }]);
	}
	const events = [];
	for await (const event of parseSSE(new Response(`data: {"type":"final"}${newline}${newline}`))) events.push(event);
	expect(events).toEqual([{ type: "final" }]);
});
