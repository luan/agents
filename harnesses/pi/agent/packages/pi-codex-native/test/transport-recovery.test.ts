import { expect, test } from "bun:test";
import { prewarmWebSocket } from "../src/provider/websocket-stream.ts";
import { NonRetryableProviderError } from "../src/provider/errors.ts";
import { getCodexModels } from "../src/provider/models.ts";
import { createCodexTransportStream } from "../src/provider/transport-recovery.ts";
import type { CodexDiagnosticsSink, OpenAICodexStreamOptions, ResponsesBody } from "../src/provider/types.ts";

test.each(["sse", "websocket"] as const)(
	"%s rejects malformed final tool arguments without retry or fallback",
	async (transport) => {
		const item = { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: "" };
		const events = [
			{ type: "response.created", response: { id: "resp_1" } },
			{ type: "response.output_item.added", output_index: 0, item },
			{ type: "response.output_item.done", output_index: 0, item: { ...item, arguments: "null" } },
			{ type: "response.completed", response: { id: "resp_1", status: "completed" } },
		];
		let requests = 0;
		let settled = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request, server) {
				if (server.upgrade(request)) return;
				requests++;
				return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
					headers: { "content-type": "text/event-stream" },
				});
			},
			websocket: {
				message(socket) {
					requests++;
					for (const event of events) socket.send(JSON.stringify(event));
				},
			},
		});
		try {
			const stream = testStream(server.url.toString(), { transport }, () => {
				settled++;
			});
			const result = await stream.result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("Invalid function call arguments");
			expect(result.content).toEqual([]);
			expect(requests).toBe(1);
			expect(settled).toBe(1);
		} finally {
			await server.stop(true);
		}
	},
);

function testStream(
	baseUrl: string,
	options: OpenAICodexStreamOptions,
	onStreamSettled?: () => void,
	diagnostics?: CodexDiagnosticsSink,
) {
	const registered = getCodexModels()[0];
	if (!registered) throw new Error("No registered models");
	const model = { ...registered, baseUrl };
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } }),
	).toString("base64url");
	const body: ResponsesBody = {
		model: model.id,
		store: false,
		stream: true,
		input: [],
		text: { verbosity: "low" },
		include: [],
		tool_choice: "auto",
		parallel_tool_calls: false,
	};
	return createCodexTransportStream(
		model,
		{ messages: [] },
		{
			apiKey: `test.${payload}.test`,
			maxRetries: 2,
			env: { NO_PROXY: "*" },
			...options,
		},
		{ prepareRequestBody: async () => body, onStreamSettled, getDiagnostics: () => diagnostics },
	);
}

function responseFetch(response: Response): typeof fetch {
	return Object.assign(async () => response, { preconnect() {} });
}

test("SSE usage limit errors preserve reset and usage response headers", async () => {
	const response = Response.json(
		{ error: { code: "usage_limit_reached", message: "limit reached" } },
		{
			status: 429,
			headers: { "X-Codex-Primary-Reset-After-Seconds": "60", "X-Codex-Primary-Used-Percent": "100" },
		},
	);
	const result = await testStream("http://unused.invalid", {
		transport: "sse",
		fetch: responseFetch(response),
	}).result();
	expect(result.stopReason).toBe("error");
	expect(result.errorMessage).toContain("Resets in ~1m.");
	expect(result.errorMessage).toContain("Current limit: 5h 100%.");
});

test("a rejected response hook releases its unread body", async () => {
	let cancelled = false;
	const response = new Response(
		new ReadableStream<Uint8Array>({
			cancel() {
				cancelled = true;
			},
		}),
	);
	const result = await testStream("http://unused.invalid", {
		transport: "sse",
		fetch: responseFetch(response),
		onResponse: () => {
			throw new NonRetryableProviderError("response rejected");
		},
	}).result();
	expect(result.errorMessage).toBe("response rejected");
	expect(cancelled).toBe(true);
});

test("cancellation after SSE headers interrupts an unfinished error body", async () => {
	const headersReceived = Promise.withResolvers<void>();
	const controller = new AbortController();
	let requests = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch() {
			requests++;
			return new Response(
				new ReadableStream<Uint8Array>({
					start(stream) {
						stream.enqueue(new TextEncoder().encode("{"));
					},
				}),
				{ status: 503 },
			);
		},
	});
	try {
		const result = testStream(server.url.toString(), {
			transport: "sse",
			signal: controller.signal,
			onResponse: () => {
				headersReceived.resolve();
			},
		}).result();
		await headersReceived.promise;
		controller.abort();
		expect((await result).stopReason).toBe("aborted");
		expect(requests).toBe(1);
	} finally {
		controller.abort();
		await server.stop(true);
	}
});

test.each(["stream", "prewarm"] as const)(
	"cancellation before %s send closes the socket without sending a request",
	async (mode) => {
		const controller = new AbortController();
		const closed = Promise.withResolvers<void>();
		let requests = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request, server) {
				if (server.upgrade(request)) return;
				return new Response(null, { status: 400 });
			},
			websocket: {
				message() {
					requests++;
				},
				close() {
					closed.resolve();
				},
			},
		});
		const diagnostics: CodexDiagnosticsSink = (event) => {
			if (event.type === "request") controller.abort();
		};
		try {
			const options = { signal: controller.signal, env: { NO_PROXY: "*" }, transport: "websocket" as const };
			if (mode === "stream") {
				const result = await testStream(server.url.toString(), options, undefined, diagnostics).result();
				expect(result.stopReason).toBe("aborted");
			} else {
				const body: ResponsesBody = {
					model: "test",
					store: false,
					stream: true,
					input: [],
					text: { verbosity: "low" },
					include: [],
					tool_choice: "auto",
					parallel_tool_calls: false,
				};
				await expect(
					prewarmWebSocket(
						server.url.toString().replace(/^http:/, "ws:"),
						body,
						new Headers(),
						"test",
						options,
						undefined,
						diagnostics,
					),
				).rejects.toThrow("aborted");
			}
			await closed.promise;
			expect(requests).toBe(0);
		} finally {
			controller.abort();
			await server.stop(true);
		}
	},
);
