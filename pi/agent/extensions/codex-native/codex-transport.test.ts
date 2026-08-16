import { afterEach, expect, test } from "bun:test";
import {
	buildSSEHeaders,
	extractAccountId,
	fetchCodexSSEWithRetries,
	parseSSE,
	resolveCodexUrl,
} from "./codex-transport.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

test("normalizes Codex Responses URLs and preserves session headers", () => {
	expect(resolveCodexUrl(undefined)).toBe("https://chatgpt.com/backend-api/codex/responses");
	expect(resolveCodexUrl("https://example.test/codex")).toBe("https://example.test/codex/responses");
	const headers = buildSSEHeaders(undefined, undefined, "acct", "token", "session");
	expect(headers.get("authorization")).toBe("Bearer token");
	expect(headers.get("chatgpt-account-id")).toBe("acct");
	expect(headers.get("x-client-request-id")).toBe("session");
});

test("parses SSE data events and ignores DONE", async () => {
	const events: unknown[] = [];
	for await (const event of parseSSE(new Response('data: {"type":"response.created"}\n\ndata: [DONE]\n\n'))) {
		events.push(event);
	}
	expect(events).toEqual([{ type: "response.created" }]);
});

test("retries transient SSE responses", async () => {
	let attempts = 0;
	globalThis.fetch = async () => {
		attempts++;
		return attempts === 1
			? new Response("busy", { status: 503, headers: { "retry-after-ms": "0" } })
			: new Response("ok", { status: 200 });
	};
	const response = await fetchCodexSSEWithRetries(
		"https://example.test/codex/responses",
		new Headers(),
		{ model: "gpt-5.5" },
		{ maxRetries: 1, maxRetryDelayMs: 1 },
	);
	expect(response.status).toBe(200);
	expect(attempts).toBe(2);
});

test("extracts Codex account ID from JWT", () => {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct" } }),
	).toString("base64url");
	expect(extractAccountId(`header.${payload}.signature`)).toBe("acct");
});
