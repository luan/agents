import { afterEach, beforeEach, expect, test } from "bun:test";
import { hasDeveloperPromptHost, registerSubagentPromptContributions } from "../src/contributions/developer-prompt.ts";

const REGISTRY_KEY = Symbol.for("pi-developer-prompt/developer-messages/v1");
const ENVELOPE_SERVICE_KEY = Symbol.for("pi-developer-prompt/envelope-service/v1");
const REGISTRATION_STATE_KEY = Symbol.for("pi-subagents/developer-prompt-registration/v1");
const slots = globalThis as typeof globalThis & Record<symbol, object | undefined>;
let previousRegistry: object | undefined;
let previousEnvelopeService: object | undefined;
let previousRegistrationState: object | undefined;

beforeEach(() => {
	previousRegistry = slots[REGISTRY_KEY];
	previousEnvelopeService = slots[ENVELOPE_SERVICE_KEY];
	previousRegistrationState = slots[REGISTRATION_STATE_KEY];
	delete slots[REGISTRY_KEY];
	delete slots[ENVELOPE_SERVICE_KEY];
	delete slots[REGISTRATION_STATE_KEY];
});

afterEach(() => {
	if (previousRegistry) slots[REGISTRY_KEY] = previousRegistry;
	else delete slots[REGISTRY_KEY];
	if (previousEnvelopeService) slots[ENVELOPE_SERVICE_KEY] = previousEnvelopeService;
	else delete slots[ENVELOPE_SERVICE_KEY];
	if (previousRegistrationState) slots[REGISTRATION_STATE_KEY] = previousRegistrationState;
	else delete slots[REGISTRATION_STATE_KEY];
});

test("contributes separate Codex-compatible role and mode developer messages", () => {
	const register = () =>
		registerSubagentPromptContributions(
			() => ({
				maxConcurrency: 8,
				maxDepth: 2,
				multiAgentMode: "explicit-requests",
				agentWidgetIndicator: "inherit",
				agentHubPresentation: "side-panel",
			}),
			(sessionId) => (sessionId === "child" ? "/root/review" : "/root"),
		);
	const unregister = register();
	const unregisterSecondSession = register();
	const registry = slots[REGISTRY_KEY] as Map<
		string,
		{ activeTools: readonly string[]; content: (context: { sessionId: string }) => string }
	>;
	const role = registry.get("pi-subagents/role");
	const mode = registry.get("pi-subagents/mode");
	expect(role?.activeTools).toEqual(["spawn_agent"]);
	expect(mode?.activeTools).toEqual(["spawn_agent"]);
	expect(role?.content({ sessionId: "root" })).toStartWith("You are `/root`, the primary agent");
	expect(role?.content({ sessionId: "child" })).toStartWith("You are an agent in a team");
	expect(mode?.content({ sessionId: "root" })).toContain(EXPLICIT_POLICY_SENTINEL);

	unregister();
	expect(registry.has("pi-subagents/role")).toBeTrue();
	unregisterSecondSession();
	expect(registry.size).toBe(0);
});

const EXPLICIT_POLICY_SENTINEL = "Do not spawn sub-agents unless the user or applicable AGENTS.md/skill instructions";

test("detects the optional developer-message host structurally", () => {
	expect(hasDeveloperPromptHost()).toBeFalse();
	slots[ENVELOPE_SERVICE_KEY] = { capture() {} };
	expect(hasDeveloperPromptHost()).toBeTrue();
});
