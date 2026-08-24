import { afterEach, expect, test } from "bun:test";
import {
	ANNOTATION_SYSTEM_GUIDANCE,
	hasDeveloperPromptHost,
	registerAnnotationDeveloperPrompt,
} from "../src/contributions/developer-prompt.ts";

const CONTRIBUTIONS = Symbol.for("pi-developer-prompt/developer-messages/v1");
const ENVELOPE_SERVICE = Symbol.for("pi-developer-prompt/envelope-service/v1");

interface Contribution {
	content(context: { prompt?: string }): string | undefined;
}

type TestGlobals = typeof globalThis & Record<symbol, object | undefined>;

afterEach(() => {
	const root = globalThis as TestGlobals;
	delete root[CONTRIBUTIONS];
	delete root[ENVELOPE_SERVICE];
});

test("contributes guidance only for annotation envelopes", () => {
	const remove = registerAnnotationDeveloperPrompt();
	const root = globalThis as TestGlobals;
	const registry = root[CONTRIBUTIONS] as Map<string, Contribution>;
	const contribution = registry.get("pi-annotations/directives");
	if (!contribution) throw new Error("annotation contribution was not registered");

	expect(contribution.content({ prompt: "Ordinary request." })).toBeUndefined();
	expect(
		contribution.content({
			prompt: [
				"# Response annotations:",
				"Each item contains text selected from an earlier response and may include a user comment.",
				"<response-annotations>",
				'[{"text":"selected","annotation":"comment"}]',
				"</response-annotations>",
				"",
				"## My request:",
				"Revise this.",
			].join("\n"),
		}),
	).toBe(ANNOTATION_SYSTEM_GUIDANCE);

	remove();
	expect(registry.has("pi-annotations/directives")).toBeFalse();
});

test("uses the developer-message path when its host is installed", () => {
	const root = globalThis as TestGlobals;
	root[ENVELOPE_SERVICE] = {};

	expect(hasDeveloperPromptHost()).toBeTrue();
	delete root[ENVELOPE_SERVICE];
	expect(hasDeveloperPromptHost()).toBeFalse();
});
