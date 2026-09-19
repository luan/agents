import { expect, test } from "bun:test";
import { codexCompatibility, registerCodexCompatibleProvider } from "../src/compatibility.ts";

test("native profile remains the default", () => {
	const model = { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.6-sol" } as never;
	expect(codexCompatibility(model)?.fastMode === true).toBe(true);
});

test("registrations are model-scoped and disposable", () => {
	const unregister = registerCodexCompatibleProvider({
		provider: "litellm",
		model: "gpt-5.6-luna-compat",
		api: "openai-completions",
		fastMode: true,
	});
	const luna = { provider: "litellm", api: "openai-completions", id: "gpt-5.6-luna-compat" } as never;
	const other = { provider: "litellm", api: "openai-completions", id: "claude-opus-5" } as never;
	expect(codexCompatibility(luna)?.fastMode === true).toBe(true);
	expect(codexCompatibility(luna)).toBeDefined();
	expect(codexCompatibility(other)?.fastMode === true).toBe(false);
	unregister();
	expect(codexCompatibility(luna)?.fastMode === true).toBe(false);
});

test("newer registrations take precedence and disposal is idempotent", () => {
	const first = registerCodexCompatibleProvider({ provider: "litellm", model: "gpt-*", fastMode: false });
	const second = registerCodexCompatibleProvider({
		provider: "litellm",
		model: "gpt-5.6-luna-precedence",
		fastMode: true,
	});
	const luna = { provider: "litellm", api: "openai-completions", id: "gpt-5.6-luna-precedence" } as never;
	expect(codexCompatibility(luna)?.fastMode === true).toBe(true);
	second();
	second();
	expect(codexCompatibility(luna)?.fastMode === true).toBe(false);
	first();
});

test("matches provider and API, with exact models outranking predicates and broad routes", () => {
	const broad = registerCodexCompatibleProvider({
		provider: "test-provider",
		api: "test-api",
	});
	const predicate = registerCodexCompatibleProvider({
		provider: "test-provider",
		api: "test-api",
		model: (id) => id.startsWith("model-"),
		fastMode: false,
	});
	const exact = registerCodexCompatibleProvider({
		provider: "test-provider",
		api: "test-api",
		model: "model-one",
		fastMode: true,
	});
	const model = { provider: "test-provider", api: "test-api", id: "model-one" } as never;
	const otherApi = { provider: "test-provider", api: "other-api", id: "model-one" } as never;
	const otherProvider = { provider: "other-provider", api: "test-api", id: "model-one" } as never;
	expect(codexCompatibility(model)?.fastMode === true).toBe(true);
	expect(codexCompatibility(model)).toBeDefined();
	expect(codexCompatibility(otherApi)).toBeUndefined();
	expect(codexCompatibility(otherProvider)).toBeUndefined();
	expect(codexCompatibility({ provider: "test-provider", api: "test-api", id: "other" } as never)).toBeDefined();
	expect(codexCompatibility(undefined)).toBeUndefined();
	exact();
	predicate();
	broad();
});

test("omitted features remain disabled and duplicate IDs do not accumulate", () => {
	const first = registerCodexCompatibleProvider({
		id: "test-deduplicated",
		provider: "test-provider",
	});
	const duplicate = registerCodexCompatibleProvider({
		id: "test-deduplicated",
		provider: "test-provider",
		fastMode: true,
	});
	const model = { provider: "test-provider", api: "any", id: "model" } as never;
	expect(codexCompatibility(model)).toBeDefined();
	expect(codexCompatibility(model)?.fastMode === true).toBe(true);
	first();
	expect(codexCompatibility(model)?.fastMode).toBe(true);
	duplicate();
	expect(codexCompatibility(model)).toBeUndefined();
});
