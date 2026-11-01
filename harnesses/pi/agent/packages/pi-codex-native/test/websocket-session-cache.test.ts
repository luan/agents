import { expect, test } from "bun:test";
import { getCodexModels } from "../src/provider/models.ts";
import { buildRequestBody } from "../src/provider/request-body.ts";
import type { AcquiredWebSocket } from "../src/provider/types.ts";
import { acquireWebSocket, closeOpenAICodexWebSocketSessions } from "../src/provider/websocket-session-cache.ts";
import { prewarmWebSocket } from "../src/provider/websocket-stream.ts";

async function withSession(
	sessionId: string,
	run: (acquire: (signal?: AbortSignal) => Promise<AcquiredWebSocket>, url: string) => Promise<void>,
) {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, server) {
			if (server.upgrade(request)) return;
			return new Response(null, { status: 400 });
		},
		websocket: { message() {} },
	});
	try {
		const url = server.url.toString().replace(/^http:/, "ws:");
		await run(
			(signal) => acquireWebSocket(url, new Headers(), sessionId, "test-account", signal, undefined, { NO_PROXY: "*" }),
			url,
		);
	} finally {
		closeOpenAICodexWebSocketSessions(sessionId);
		await server.stop(true);
	}
}

test("concurrent first requests have one retained connection owner", async () => {
	await withSession("concurrent-cache", async (acquire) => {
		const leases = await Promise.all([acquire(), acquire()]);
		expect(leases[0].socket).not.toBe(leases[1].socket);
		expect(leases.filter((lease) => lease.entry)).toHaveLength(1);
		for (const lease of leases) lease.release({ keep: true });
		const reused = await acquire();
		expect(reused.reused).toBe(true);
		expect(reused.socket).toBe(leases.find((lease) => lease.entry)!.socket);
		reused.release();
	});
});

test.each([true, false])("a repeated release (keep: %j) cannot change a later lease", async (keep) => {
	await withSession(`repeat-release-${keep}`, async (acquire) => {
		const first = await acquire();
		first.release({ keep: true });
		const second = await acquire();
		expect(second.reused).toBe(true);
		first.release({ keep });
		expect(second.socket.readyState).toBe(WebSocket.OPEN);
		const concurrent = await acquire();
		expect(concurrent.reused).toBe(false);
		expect(concurrent.entry).toBeUndefined();
		expect(concurrent.socket).not.toBe(second.socket);
		concurrent.release({ keep: true });
		second.release();
	});
});

test("an already cancelled request cannot acquire a cached connection", async () => {
	await withSession("aborted-acquire", async (acquire) => {
		const first = await acquire();
		first.release({ keep: true });
		const controller = new AbortController();
		controller.abort();
		await expect(acquire(controller.signal)).rejects.toThrow("aborted");
		const next = await acquire();
		expect(next.reused).toBe(true);
		expect(next.socket).toBe(first.socket);
		next.release();
	});
});

test.each([-1, NaN, Infinity])(
	"invalid prewarm timeout %s leaves the cached connection available",
	async (timeoutMs) => {
		const sessionId = `invalid-prewarm-${timeoutMs}`;
		await withSession(sessionId, async (acquire, url) => {
			const first = await acquire();
			first.release({ keep: true });
			const body = buildRequestBody(getCodexModels()[0]!, { messages: [] });
			await expect(
				prewarmWebSocket(url, body, new Headers(), "test-account", { sessionId, timeoutMs, env: { NO_PROXY: "*" } }),
			).rejects.toThrow("Invalid timeoutMs");
			const next = await acquire();
			try {
				expect(next.reused).toBe(true);
				expect(next.socket).toBe(first.socket);
			} finally {
				next.release();
			}
		});
	},
);
