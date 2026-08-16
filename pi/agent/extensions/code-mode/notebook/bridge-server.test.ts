import { expect, it } from "bun:test";
import type { NestedToolResult } from "../nested-dispatch.ts";
import type { NotebookContentItem, NotebookMemoryUsage } from "./bridge-protocol.ts";
import { type NotebookBridge, type NotebookBridgeHandlers, startNotebookBridge } from "./bridge-server.ts";

interface Recorder {
	tools: Array<{ name: string; namespace?: string; input: unknown }>;
	emitted: NotebookContentItem[];
	notified: string[];
	cancelled: string[];
	yielded: string[];
	memory: NotebookMemoryUsage[];
}

function recordingHandlers(callTool?: NotebookBridgeHandlers["callTool"]): {
	handlers: NotebookBridgeHandlers;
	recorder: Recorder;
} {
	const recorder: Recorder = { tools: [], emitted: [], notified: [], cancelled: [], yielded: [], memory: [] };
	const handlers: NotebookBridgeHandlers = {
		callTool:
			callTool ??
			((request) => {
				recorder.tools.push({ ...request.toolName, input: request.input });
				return Promise.resolve({ text: "ok" });
			}),
		cancelTools: (cellId) => recorder.cancelled.push(cellId),
		emit: (_cellId, items) => recorder.emitted.push(...items),
		notify: (_cellId, text) => recorder.notified.push(text),
		yield: (cellId) => recorder.yielded.push(cellId),
		memory: (_cellId, usage) => recorder.memory.push(usage),
	};
	return { handlers, recorder };
}

function post(bridge: NotebookBridge, body: unknown, init: RequestInit & { token?: string; path?: string } = {}) {
	const token = init.token === undefined ? bridge.token : init.token;
	return fetch(`${bridge.origin}${init.path ?? "/bridge"}`, {
		method: init.method ?? "POST",
		headers: {
			"content-type": "application/json",
			...(token === "" ? {} : { authorization: `Bearer ${token}` }),
		},
		body: init.method === "GET" ? undefined : JSON.stringify(body),
	});
}

it("rejects a request without the bearer token", async () => {
	const { handlers, recorder } = recordingHandlers();
	const bridge = await startNotebookBridge(handlers);
	try {
		const anonymous = await post(bridge, { kind: "yield", cellId: "cell-1" }, { token: "" });
		expect(anonymous.status).toBe(401);

		const wrong = await post(bridge, { kind: "yield", cellId: "cell-1" }, { token: "not-the-token" });
		expect(wrong.status).toBe(401);
		expect(recorder.yielded).toEqual([]);
	} finally {
		await bridge.close();
	}
});

it("serves only POST /bridge", async () => {
	const { handlers } = recordingHandlers();
	const bridge = await startNotebookBridge(handlers);
	try {
		expect((await post(bridge, {}, { path: "/" })).status).toBe(404);
		expect((await post(bridge, {}, { path: "/bridge/tool" })).status).toBe(404);
		expect((await post(bridge, {}, { method: "GET" })).status).toBe(404);
	} finally {
		await bridge.close();
	}
});

it("routes every request kind to its handler", async () => {
	const { handlers, recorder } = recordingHandlers();
	const bridge = await startNotebookBridge(handlers);
	const usage: NotebookMemoryUsage = {
		heapUsedBytes: 1,
		heapTotalBytes: 2,
		rssBytes: 3,
		externalBytes: 4,
		heapLimitBytes: 5,
	};
	try {
		const tool = await post(bridge, {
			kind: "tool",
			cellId: "cell-1",
			requestId: 1,
			toolName: { name: "read", namespace: "core" },
			input: { path: "a.txt" },
		});
		expect(await tool.json()).toEqual({ ok: true, result: { text: "ok" } });
		expect(recorder.tools).toEqual([{ name: "read", namespace: "core", input: { path: "a.txt" } }]);

		await post(bridge, { kind: "emit", cellId: "cell-1", items: [{ type: "input_text", text: "hi" }] });
		await post(bridge, { kind: "notify", cellId: "cell-1", text: "progress" });
		await post(bridge, { kind: "yield", cellId: "cell-1" });
		await post(bridge, { kind: "cancel_tools", cellId: "cell-1" });
		await post(bridge, { kind: "memory", cellId: "cell-1", usage });

		expect(recorder.emitted).toEqual([{ type: "input_text", text: "hi" }]);
		expect(recorder.notified).toEqual(["progress"]);
		expect(recorder.yielded).toEqual(["cell-1"]);
		expect(recorder.cancelled).toEqual(["cell-1"]);
		expect(recorder.memory).toEqual([usage]);
	} finally {
		await bridge.close();
	}
});

it("rejects malformed payloads without calling a handler", async () => {
	const { handlers, recorder } = recordingHandlers();
	const bridge = await startNotebookBridge(handlers);
	try {
		const cases: unknown[] = [
			{ kind: "tool", cellId: "cell-1", toolName: { name: "read" } },
			{ kind: "tool", cellId: "cell-1", requestId: 1, toolName: "read" },
			{ kind: "emit", cellId: "cell-1", items: { type: "input_text", text: "hi" } },
			{ kind: "emit", cellId: "cell-1", items: [{ type: "input_video", url: "x" }] },
			{ kind: "notify", cellId: "cell-1" },
			{ kind: "memory", cellId: "cell-1", usage: { heapUsedBytes: -1 } },
			{ kind: "teleport", cellId: "cell-1" },
			{ kind: "yield" },
		];
		for (const body of cases) {
			const response = await post(bridge, body);
			expect([body, response.status]).toEqual([body, 400]);
		}
		expect(recorder).toMatchObject({ tools: [], emitted: [], notified: [], memory: [], yielded: [] });
	} finally {
		await bridge.close();
	}
});

it("encodes bigint and bytes as __pi_type envelopes", async () => {
	const result: NestedToolResult = {
		text: "ok",
		details: { count: 7n, bytes: new Uint8Array([1, 2, 3]) },
	};
	const { handlers } = recordingHandlers(() => Promise.resolve(result));
	const bridge = await startNotebookBridge(handlers);
	try {
		const response = await post(bridge, {
			kind: "tool",
			cellId: "cell-1",
			requestId: 1,
			toolName: { name: "read" },
			input: undefined,
		});
		expect(await response.json()).toEqual({
			ok: true,
			result: {
				text: "ok",
				details: {
					count: { __pi_type: "bigint", value: "7" },
					bytes: { __pi_type: "bytes", value: Buffer.from([1, 2, 3]).toString("base64") },
				},
			},
		});
	} finally {
		await bridge.close();
	}
});

it("answers a failed tool call with an error result, not a rejection", async () => {
	const { handlers } = recordingHandlers(() => Promise.reject(new Error("Unknown tool: nope")));
	const bridge = await startNotebookBridge(handlers);
	try {
		const response = await post(bridge, {
			kind: "tool",
			cellId: "cell-1",
			requestId: 1,
			toolName: { name: "nope" },
			input: {},
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, result: { error: "Unknown tool: nope" } });
	} finally {
		await bridge.close();
	}
});

it("bounds the request body", async () => {
	const { handlers, recorder } = recordingHandlers();
	const bridge = await startNotebookBridge(handlers);
	try {
		const oversized = "x".repeat(35 * 1024 * 1024);
		const status = await post(bridge, {
			kind: "emit",
			cellId: "cell-1",
			items: [{ type: "input_text", text: oversized }],
		}).then(
			(response) => response.status,
			// A body past the 34 MB ceiling destroys the socket mid-upload, so fetch can reject instead.
			() => 0,
		);
		expect(status === 0 || status >= 400).toBe(true);
		expect(recorder.emitted).toEqual([]);
	} finally {
		await bridge.close();
	}
});

it("bounds the response body", async () => {
	const { handlers } = recordingHandlers(() => Promise.resolve({ text: "y".repeat(33 * 1024 * 1024) }));
	const bridge = await startNotebookBridge(handlers);
	try {
		const response = await post(bridge, {
			kind: "tool",
			cellId: "cell-1",
			requestId: 1,
			toolName: { name: "read" },
			input: {},
		});
		expect(response.status).toBe(413);
		expect(await response.json()).toMatchObject({ ok: false });
	} finally {
		await bridge.close();
	}
});

it("closes once, even when called twice", async () => {
	const { handlers } = recordingHandlers();
	const bridge = await startNotebookBridge(handlers);
	await Promise.all([bridge.close(), bridge.close()]);
	await bridge.close();
	await expect(post(bridge, { kind: "yield", cellId: "cell-1" })).rejects.toThrow();
});
