import { afterEach, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { createWebRunTool, resolveWebRunBinary } from "../src/tools/web-run/definition.ts";
import { cleanWebOutput, renderWebRunResult } from "../src/tools/web-run/presentation.ts";

const originalBinary = process.env["PI_CODEX_WEB_RUN_BIN"];
const originalSearchUrl = process.env["PI_CODEX_SEARCH_URL"];
const originalAccessToken = process.env["PI_CODEX_ACCESS_TOKEN"];
const originalAccountId = process.env["PI_CODEX_ACCOUNT_ID"];
const presentationTheme = {
	name: "web-test",
	bold: (text: string) => text,
	getColorMode: () => "truecolor",
	getFgAnsi: () => "\x1b[39m",
	getBgAnsi: () => "\x1b[49m",
} as never as Theme;

afterEach(() => {
	if (originalBinary === undefined) delete process.env["PI_CODEX_WEB_RUN_BIN"];
	else process.env["PI_CODEX_WEB_RUN_BIN"] = originalBinary;
	if (originalSearchUrl === undefined) delete process.env["PI_CODEX_SEARCH_URL"];
	else process.env["PI_CODEX_SEARCH_URL"] = originalSearchUrl;
	if (originalAccessToken === undefined) delete process.env["PI_CODEX_ACCESS_TOKEN"];
	else process.env["PI_CODEX_ACCESS_TOKEN"] = originalAccessToken;
	if (originalAccountId === undefined) delete process.env["PI_CODEX_ACCOUNT_ID"];
	else process.env["PI_CODEX_ACCOUNT_ID"] = originalAccountId;
});

test("removes provider citation sentinels from visible web output", () => {
	expect(cleanWebOutput("\uE200cite\uE202turn0search0\uE201Current result")).toBe("Current result");
});

test("missing web details render a compact failure without terminal controls", () => {
	const component = renderWebRunResult(
		{ content: [{ type: "text", text: "request failed\x1b]52;c;secret\x07" }], details: undefined as never },
		presentationTheme,
		{
			args: { search_query: [{ q: "test" }] },
			executionStarted: true,
			invalidate() {},
			isError: true,
			lastComponent: undefined,
		},
		false,
	);
	const rendered = Bun.stripANSI(component.render(80).join("\n"));
	expect(rendered).toBe("⌕ Web request failed · test ›");
	expect(rendered).not.toContain("secret");
});

test("rejects non-Codex models before binary execution", async () => {
	const tool = createWebRunTool();
	await expect(
		tool.execute("call", { search_query: [{ q: "test" }] }, undefined, undefined, {
			model: { provider: "anthropic", id: "claude" },
		} as never),
	).rejects.toThrow("requires an openai-codex model");
});

test("rejects a Codex provider with the wrong API", async () => {
	const tool = createWebRunTool();
	await expect(
		tool.execute("call", { search_query: [{ q: "test" }] }, undefined, undefined, {
			model: { provider: "openai-codex", api: "openai-responses", id: "gpt-5.6-luna" },
		} as never),
	).rejects.toThrow("openai-codex-responses API");
});

test("does not expose provider request controls", () => {
	const properties = createWebRunTool().parameters.properties;
	expect(properties).not.toHaveProperty("reasoning");
	expect(properties).not.toHaveProperty("input");
	expect(properties).not.toHaveProperty("max_output_tokens");
	expect(properties.finance.items.required).toEqual(["ticker", "type"]);
	expect(properties.sports.items.properties.league.enum).toContain("nba");
});

test("rejects an explicit non-executable binary", () => {
	process.env["PI_CODEX_WEB_RUN_BIN"] = "/private/tmp/web-run-does-not-exist";
	expect(() => resolveWebRunBinary()).toThrow("is not executable");
});

test("executes the local Rust web runner against the configured endpoint", async () => {
	let request: Request | undefined;
	let requestBody: unknown;
	const server = Bun.serve({
		port: 0,
		async fetch(next) {
			request = next;
			requestBody = await next.json();
			if (new URL(next.url).pathname === "/oversized") {
				return Response.json({ output: "x".repeat(5 * 1024 * 1024), results: [] });
			}
			return Response.json({ output: "Local search result.", results: [{ ref_id: "turn0search0" }] });
		},
	});
	try {
		process.env["PI_CODEX_WEB_RUN_BIN"] = resolveWebRunBinary();
		process.env["PI_CODEX_SEARCH_URL"] = `http://127.0.0.1:${server.port}/alpha/search`;
		process.env["PI_CODEX_ACCESS_TOKEN"] = "test-token";
		process.env["PI_CODEX_ACCOUNT_ID"] = "test-account";

		const result = await createWebRunTool().execute(
			"call",
			{ search_query: [{ q: "local test" }] },
			undefined,
			undefined,
			{
				model: { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.6-luna" },
				sessionManager: { getSessionId: () => "session-1" },
			} as never,
		);

		expect(result.content).toEqual([{ type: "text", text: "Local search result." }]);
		expect(result.details).toMatchObject({
			version: 1,
			tool: "web__run",
			status: "completed",
			request: { search_query: [{ q: "local test" }] },
			model: "gpt-5.6-luna",
			sessionId: "session-1",
			output: {
				textChars: 20,
				originalTextChars: 20,
				textTruncated: false,
				searchResultsTruncated: false,
			},
			result: { output_text: "Local search result." },
		});
		expect(JSON.parse(JSON.stringify(result.details))).toEqual(result.details);
		expect(request?.headers.get("authorization")).toBe("Bearer test-token");
		expect(requestBody).toMatchObject({
			model: "gpt-5.6-luna",
			commands: { search_query: [{ q: "local test" }] },
		});

		process.env["PI_CODEX_SEARCH_URL"] = `http://127.0.0.1:${server.port}/oversized`;
		await expect(
			createWebRunTool().execute("call-2", { search_query: [{ q: "oversized" }] }, undefined, undefined, {
				model: { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.6-luna" },
			} as never),
		).rejects.toThrow("response exceeded");
	} finally {
		server.stop(true);
	}
});
