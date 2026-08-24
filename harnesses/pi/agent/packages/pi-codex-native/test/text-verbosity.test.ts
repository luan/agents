import { expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerTextVerbosity } from "../src/provider/text-verbosity.ts";
import { DEFAULT_CODEX_NATIVE_SETTINGS } from "../src/contributions/xsettings.ts";

type Handler = (event: { payload?: unknown }, ctx: ExtensionContext) => unknown;

test("text verbosity uses the standalone setting and applies xsettings on the next Codex request", async () => {
	const handlers = new Map<string, Handler>();
	let textVerbosity: "high" | "medium" = "high";
	registerTextVerbosity(
		{
			on(name: string, handler: Handler) {
				handlers.set(name, handler);
			},
		} as never,
		() => ({
			...DEFAULT_CODEX_NATIVE_SETTINGS,
			textVerbosity,
		}),
	);
	const ctx = {
		model: { provider: "openai-codex", api: "openai-codex-responses" },
	} as ExtensionContext;

	await handlers.get("session_start")?.({}, ctx);
	expect(handlers.get("before_provider_request")?.({ payload: { text: { format: "plain" } } }, ctx)).toEqual({
		text: { format: "plain", verbosity: "high" },
	});

	textVerbosity = "medium";
	expect(handlers.get("before_provider_request")?.({ payload: { text: { format: "plain" } } }, ctx)).toEqual({
		text: { format: "plain", verbosity: "medium" },
	});

	const other = { model: { provider: "anthropic", api: "anthropic-messages" } } as ExtensionContext;
	expect(handlers.get("before_provider_request")?.({ payload: { text: { verbosity: "low" } } }, other)).toBeUndefined();
});
