import { afterEach, expect, test } from "bun:test";
import { PROMPT_AUDIT_GROUP_ENTRY_TYPE } from "../src/audit-entries.ts";
import { renderAgentsContext } from "../src/context-messages.ts";
import {
	getDeveloperMessageContributionRegistry,
	registerDeveloperMessageContribution,
} from "../src/developer-messages.ts";
import { registerDeveloperPromptExtension } from "../src/extension.ts";
import { getPromptEnvelopeService, promptEnvelopeRequests } from "../src/prompt-envelope.ts";
import { getSystemPromptPayloadAdapterRegistry, registerSystemPromptPayloadAdapter } from "../src/provider-payload.ts";

// type-boundary: These records model the small subset of the external Pi extension API used by this harness.
type TestRecord = Record<string, unknown>;
type TestMessage = { role?: string; customType?: string; content?: unknown; [key: string]: unknown };
type Handler = (event: TestRecord, context: TestRecord) => TestRecord | undefined;
type EntryRenderer = (...args: TestRecord[]) => TestRecord | undefined;

function recordFrom(result: TestRecord | undefined): TestRecord {
	if (!result) throw new Error("The hook did not return a result");
	return result;
}

function stringFrom(result: TestRecord | undefined, key: string): string {
	const value = recordFrom(result)[key];
	if (typeof value !== "string") throw new Error(`The hook result did not contain ${key}`);
	return value;
}

function messagesFrom(result: TestRecord | undefined): TestMessage[] {
	if (!result || !Array.isArray(result.messages)) throw new Error("The context hook did not return messages");
	return result.messages as TestMessage[];
}

afterEach(() => {
	getSystemPromptPayloadAdapterRegistry().clear();
	getDeveloperMessageContributionRegistry().clear();
	promptEnvelopeRequests().clear();
});

function extensionHarness() {
	const handlers = new Map<string, Handler>();
	const notifications: string[] = [];
	const auditEntries: Array<{ customType: string; data: TestRecord }> = [];
	const entryRenderers = new Map<string, EntryRenderer>();
	const sessionEntries: TestRecord[] = [];
	registerDeveloperPromptExtension({
		appendEntry: (customType: string, data: TestRecord) => {
			auditEntries.push({ customType, data });
			sessionEntries.push({ type: "custom", customType, data });
		},
		getActiveTools: () => {
			return ["read"];
		},
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerEntryRenderer: (customType: string, renderer: EntryRenderer) => {
			entryRenderers.set(customType, renderer);
		},
	} as never);
	const context = (sessionId: string) => ({
		cwd: "/repo",
		model: { provider: "test" },
		sessionManager: { getSessionId: () => sessionId, getBranch: () => sessionEntries },
		ui: {
			notify: (message: string) => {
				notifications.push(message);
			},
		},
	});
	return {
		handlers,
		notifications,
		auditEntries,
		entryRenderers,
		context,
	};
}

function startEvent(
	base: string,
	cwd = "/repo",
	contextFiles: Array<{ path: string; content: string }> = [],
	customPrompt = "Owned prompt.",
) {
	return { systemPrompt: base, systemPromptOptions: { cwd, selectedTools: ["read"], contextFiles, customPrompt } };
}

test("does not reuse stale resource inputs after extension reload", () => {
	const first = extensionHarness();
	const beforeStart = first.handlers.get("before_agent_start");
	const shutdown = first.handlers.get("session_shutdown");
	if (!beforeStart || !shutdown) throw new Error("session handlers were not registered");
	const context = first.context("reload-session");
	beforeStart(startEvent("Pi base", "/repo", [{ path: "/repo/AGENTS.md", content: "Rules." }]), context);
	shutdown({ reason: "new" }, context);
	shutdown({ reason: "reload" }, context);

	extensionHarness();
	const envelope = getPromptEnvelopeService()?.current("reload-session", {
		provider: "test",
		activeTools: ["read"],
		cwd: "/repo",
	});
	expect(envelope).toBeUndefined();
});

test("restores the session prompt when compaction sends the exact Pi base prompt", () => {
	const harness = extensionHarness();
	const beforeStart = harness.handlers.get("before_agent_start");
	const beforeRequest = harness.handlers.get("before_provider_request");
	if (!beforeStart || !beforeRequest) throw new Error("prompt handlers were not registered");

	const context = harness.context("one");
	registerTestPayloadAdapter("test");
	const built = stringFrom(beforeStart(startEvent("Pi base"), context), "systemPrompt");
	const restored = beforeRequest({ payload: { prompt: "Pi base", input: [] } }, context);
	const untouched = beforeRequest({ payload: { prompt: "changed later", input: [] } }, context);

	expect(restored).toEqual({ prompt: built, input: [] });
	expect(untouched).toBeUndefined();
});

test("does not change a provider request when no payload adapter exists", () => {
	const harness = extensionHarness();
	const beforeStart = harness.handlers.get("before_agent_start");
	const beforeRequest = harness.handlers.get("before_provider_request");
	if (!beforeStart || !beforeRequest) throw new Error("prompt handlers were not registered");
	const context = harness.context("one");
	beforeStart(startEvent("Pi base"), context);
	expect(beforeRequest({ payload: { prompt: "Pi base" } }, context)).toBeUndefined();
});

test("does not use an adapter registered for another provider", () => {
	const harness = extensionHarness();
	const beforeStart = harness.handlers.get("before_agent_start");
	const beforeRequest = harness.handlers.get("before_provider_request");
	if (!beforeStart || !beforeRequest) throw new Error("prompt handlers were not registered");
	registerTestPayloadAdapter("other");
	const context = harness.context("one");
	beforeStart(startEvent("Pi base"), context);
	expect(beforeRequest({ payload: { prompt: "Pi base" } }, context)).toBeUndefined();
});

test("injects prompt-aware developer messages when both system prompts are empty", () => {
	const harness = extensionHarness();
	const beforeStart = harness.handlers.get("before_agent_start");
	const beforeRequest = harness.handlers.get("before_provider_request");
	if (!beforeStart || !beforeRequest) throw new Error("prompt handlers were not registered");
	registerDeveloperMessageContribution({
		id: "mode",
		content: ({ prompt }) => (prompt === "Annotated request." ? "Developer mode." : undefined),
	});
	let receivedMessages: unknown;
	registerSystemPromptPayloadAdapter({
		provider: "test",
		readSystemPrompt(payload) {
			return (payload as { prompt: string }).prompt;
		},
		replaceSystemPrompt(payload, systemPrompt) {
			return { ...(payload as object), prompt: systemPrompt };
		},
		replaceDeveloperMessages(payload, messages) {
			receivedMessages = messages;
			return { ...(payload as object), developer: messages.map((message) => message.content) };
		},
	});
	const context = harness.context("one");
	beforeStart({ ...startEvent("", "/repo", [], ""), prompt: "Annotated request." }, context);

	expect(beforeRequest({ payload: { prompt: "" } }, context)).toEqual({
		prompt: "",
		developer: ["Developer mode.", expect.stringContaining("<environment_context>")],
	});
	expect(receivedMessages).toEqual([
		{ id: "mode", content: "Developer mode." },
		{ id: "environment", content: expect.stringContaining("<environment_context>") },
	]);
});

test("primes developer messages for a custom-triggered turn without before_agent_start", () => {
	const harness = extensionHarness();
	const sessionStart = harness.handlers.get("session_start");
	const beforeRequest = harness.handlers.get("before_provider_request");
	if (!sessionStart || !beforeRequest) throw new Error("prompt handlers were not registered");
	registerDeveloperMessageContribution({ id: "subagent-mode", content: "Explicit delegation only." });
	registerSystemPromptPayloadAdapter({
		provider: "test",
		readSystemPrompt: (payload) => (payload as { prompt: string }).prompt,
		replaceSystemPrompt: (payload, systemPrompt) => ({ ...(payload as object), prompt: systemPrompt }),
		replaceDeveloperMessages: (payload, messages) => ({ ...(payload as object), developer: messages }),
	});
	const context = harness.context("custom-turn");
	sessionStart({}, context);
	getPromptEnvelopeService()?.capture({
		provider: "test",
		activeTools: ["read"],
		sessionId: "custom-turn",
		prompt: "Hidden task.",
		cwd: "/repo",
		piSystemPrompt: "Pi base",
		systemPromptOptions: { cwd: "/repo", customPrompt: "Owned prompt." },
	});

	expect(beforeRequest({ payload: { prompt: "Pi base", input: [] } }, context)).toEqual({
		prompt: "Owned prompt.",
		input: [],
		developer: [
			{ id: "subagent-mode", content: "Explicit delegation only." },
			{ id: "environment", content: expect.stringContaining("<environment_context>") },
		],
	});
	expect(harness.auditEntries).toHaveLength(1);
	expect(harness.auditEntries[0]?.data).toEqual({
		entries: expect.arrayContaining([{ role: "developer", id: "subagent-mode", content: "Explicit delegation only." }]),
	});
});

test("sends AGENTS.md as one contextual user message before conversation history", () => {
	const harness = extensionHarness();
	const beforeStart = harness.handlers.get("before_agent_start");
	const contextHook = harness.handlers.get("context");
	if (!beforeStart || !contextHook) throw new Error("context handlers were not registered");
	const context = harness.context("one");
	beforeStart(
		startEvent("Pi base", "/repo", [
			{ path: "/repo/AGENTS.md", content: "Root rules." },
			{ path: "/repo/feature/AGENTS.md", content: "Feature rules." },
		]),
		context,
	);

	const result = messagesFrom(contextHook({ messages: [{ role: "user", content: "Work." }] }, context));
	expect(result).toEqual([
		{
			role: "custom",
			customType: "pi-developer-prompt/agents-md",
			content: [
				"# AGENTS.md instructions for /repo",
				"",
				"<INSTRUCTIONS>",
				"Root rules.",
				"",
				"Feature rules.",
				"</INSTRUCTIONS>",
			].join("\n"),
			display: false,
			timestamp: 0,
		},
		{ role: "user", content: "Work." },
	]);
});

test("uses Codex's AGENTS.md markers without per-file XML wrappers", () => {
	expect(
		renderAgentsContext(
			[
				{ path: "/agent/AGENTS.md", content: "Global rules." },
				{ path: "/repo/AGENTS.md", content: "Root rules." },
				{ path: "/repo/feature/AGENTS.md", content: "Feature rules." },
			],
			"/repo",
			"/agent",
		),
	).toBe(
		[
			"# AGENTS.md instructions for /repo",
			"",
			"<INSTRUCTIONS>",
			"Global rules.",
			"",
			"--- project-doc ---",
			"",
			"Root rules.",
			"",
			"Feature rules.",
			"</INSTRUCTIONS>",
		].join("\n"),
	);
});

test("persists role audit entries once, excludes them from model context, and expands compact renderers", async () => {
	registerDeveloperMessageContribution({ id: "skills", content: "Skill catalogue." });
	const harness = extensionHarness();
	const beforeStart = harness.handlers.get("before_agent_start");
	const contextHook = harness.handlers.get("context");
	if (!beforeStart || !contextHook) throw new Error("prompt handlers were not registered");
	const context = harness.context("audit");
	const event = startEvent("Pi base", "/repo", [{ path: "/repo/AGENTS.md", content: "Rules." }]);
	beforeStart(event, context);
	beforeStart(event, context);

	expect(harness.auditEntries).toHaveLength(1);
	expect(harness.auditEntries[0]).toMatchObject({ customType: PROMPT_AUDIT_GROUP_ENTRY_TYPE });
	expect(harness.auditEntries[0]?.data).toMatchObject({
		entries: [
			{ role: "developer", id: "skills", content: "Skill catalogue." },
			{ role: "developer", id: "environment", content: expect.stringContaining("<environment_context>") },
			{ role: "user", id: "agents-md", content: expect.stringContaining("Rules.") },
		],
	});
	const result = messagesFrom(contextHook({ messages: [{ role: "user", content: "Work." }] }, context));
	expect(result).toHaveLength(2);
	expect(result[0]).toMatchObject({
		role: "custom",
		customType: "pi-developer-prompt/agents-md",
		display: false,
	});
	expect(result[1]).toEqual({ role: "user", content: "Work." });

	const renderer = harness.entryRenderers.get("pi-developer-prompt/developer");
	if (!renderer) throw new Error("developer audit entry renderer was not registered");
	const agentIndexUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
	const { initTheme } = await import(new URL("./modes/interactive/theme/theme.js", agentIndexUrl).href);
	initTheme("dark");
	const { CustomEntryComponent } = await import(
		new URL("./modes/interactive/components/custom-entry.js", agentIndexUrl).href
	);
	const skillBody = ["## Skills", "", "A skill uses a `SKILL.md` file.", "", "- First skill", "- Second skill"].join(
		"\n",
	);
	const component = new CustomEntryComponent(
		{
			type: "custom",
			id: "audit-entry",
			parentId: null,
			timestamp: new Date().toISOString(),
			customType: "pi-developer-prompt/developer",
			data: {
				role: "developer",
				id: "skills",
				content: `<skills_instructions>\n${skillBody}\n</skills_instructions>`,
			},
		},
		renderer,
	);
	const collapsed = component.render(80).map((line: string) => stripAnsi(line).trimEnd());
	expect(collapsed).toHaveLength(2);
	expect(collapsed[0]).toBe("");
	expect(collapsed[1]).toContain("developer · skills");
	expect(collapsed.join("\n")).not.toContain("SKILL.md");
	component.setExpanded(true);
	const expandedRaw = component.render(80);
	const expandedLines = expandedRaw.map((line: string) => stripAnsi(line).trimEnd());
	expect(expandedLines.length).toBeGreaterThan(collapsed.length);
	expect(expandedLines[0]).toBe("");
	const expanded = expandedLines.join("\n");
	expect(expanded).toContain("developer · skills");
	expect(expanded).toContain("## Skills");
	expect(expanded).toContain("A skill uses a SKILL.md file.");
	expect(expanded).toContain("First skill");
	expect(expanded).toContain("Second skill");
	expect(expandedRaw.some((line: string) => /\x1b\[(?:4\d|48;)/.test(line))).toBe(true);
});

test("audit settings change persistence without changing the composed prompt", async () => {
	registerDeveloperMessageContribution({ id: "skills", content: "Skill catalogue." });
	const harness = extensionHarness();
	const registry = Reflect.get(globalThis, Symbol.for("pi-xsettings/registry/v1")) as {
		publish(namespace: string, values: Record<string, string[]>): Promise<void>;
	};
	await registry.publish("pi-developer-prompt", { auditEntries: ["context-user"] });
	const beforeStart = harness.handlers.get("before_agent_start");
	const beforeRequest = harness.handlers.get("before_provider_request");
	if (!beforeStart || !beforeRequest) throw new Error("prompt handlers were not registered");
	registerTestPayloadAdapter("test");
	const context = harness.context("audit-setting");
	beforeStart(startEvent("Pi base", "/repo", [{ path: "/repo/AGENTS.md", content: "Rules." }]), context);

	expect(harness.auditEntries).toHaveLength(1);
	expect(harness.auditEntries[0]).toMatchObject({
		customType: PROMPT_AUDIT_GROUP_ENTRY_TYPE,
		data: { entries: [{ role: "user", id: "agents-md", content: expect.stringContaining("Rules.") }] },
	});
	expect(beforeRequest({ payload: { prompt: "Pi base", input: [] } }, context)).toEqual({
		prompt: "Owned prompt.",
		input: [],
	});
	await registry.publish("pi-developer-prompt", {
		auditEntries: ["developer", "context-user"],
	});
});

function stripAnsi(value: string): string {
	return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

test("records a prompt value again after it changes away and back", () => {
	const harness = extensionHarness();
	const beforeStart = harness.handlers.get("before_agent_start");
	if (!beforeStart) throw new Error("before_agent_start was not registered");
	const context = harness.context("audit-transitions");

	for (const content of ["Catalogue A.", "Catalogue B.", "Catalogue A."]) {
		registerDeveloperMessageContribution({ id: "skills", content });
		beforeStart(startEvent("Pi base"), context);
	}

	expect(
		harness.auditEntries.map(
			({ data }) =>
				(data.entries as Array<{ id: string; content: string }>).find((entry) => entry.id === "skills")?.content,
		),
	).toEqual(["Catalogue A.", "Catalogue B.", "Catalogue A."]);
});

test("removes visible audit copies from Pi compaction and tree summaries", () => {
	const harness = extensionHarness();
	const beforeCompact = harness.handlers.get("session_before_compact");
	const beforeTree = harness.handlers.get("session_before_tree");
	if (!beforeCompact || !beforeTree) throw new Error("summary handlers were not registered");
	const developerAudit = {
		role: "custom",
		customType: "pi-developer-prompt/developer",
		content: "Developer audit.",
	};
	const contextAudit = {
		role: "custom",
		customType: "pi-developer-prompt/context-user",
		content: "Context audit.",
	};
	const groupedAudit = {
		role: "custom",
		customType: PROMPT_AUDIT_GROUP_ENTRY_TYPE,
		content: "Grouped audit.",
	};
	const user = { role: "user", content: "Actual request." };
	const preparation = {
		messagesToSummarize: [developerAudit, user],
		turnPrefixMessages: [contextAudit, groupedAudit, user],
	};

	beforeCompact({ preparation }, harness.context("summary"));
	expect(preparation.messagesToSummarize).toEqual([user]);
	expect(preparation.turnPrefixMessages).toEqual([user]);

	const userEntry = { type: "message", id: "user", message: user };
	const entriesToSummarize = [
		{ type: "custom_message", id: "developer", customType: developerAudit.customType, content: developerAudit.content },
		userEntry,
		{ type: "custom_message", id: "context", customType: contextAudit.customType, content: contextAudit.content },
		{ type: "custom_message", id: "group", customType: groupedAudit.customType, content: groupedAudit.content },
	];
	beforeTree({ preparation: { entriesToSummarize } }, harness.context("summary"));
	expect(entriesToSummarize).toEqual([userEntry]);
});

test("replaces AGENTS.md context on every provider call without persisting duplicates", () => {
	const harness = extensionHarness();
	const beforeStart = harness.handlers.get("before_agent_start");
	const contextHook = harness.handlers.get("context");
	if (!beforeStart || !contextHook) throw new Error("context handlers were not registered");
	const context = harness.context("one");
	const stale = {
		role: "custom",
		customType: "pi-developer-prompt/agents-md",
		content: "Stale rules.",
		display: false,
		timestamp: 0,
	};
	beforeStart(startEvent("Pi base", "/repo", [{ path: "AGENTS.md", content: "Current rules." }]), context);
	const first = messagesFrom(contextHook({ messages: [stale, { role: "user", content: "Work." }] }, context));
	const second = messagesFrom(contextHook({ messages: first }, context));

	expect(first.filter((message) => message.customType === stale.customType)).toHaveLength(1);
	expect(first[0]?.content).toContain("Current rules.");
	expect(second.filter((message) => message.customType === stale.customType)).toHaveLength(1);

	beforeStart(startEvent("Pi base", "/repo", []), context);
	const removed = messagesFrom(contextHook({ messages: first }, context));
	expect(removed).toEqual([{ role: "user", content: "Work." }]);
});

function registerTestPayloadAdapter(provider: string): void {
	registerSystemPromptPayloadAdapter({
		provider,
		readSystemPrompt(payload) {
			return payload && typeof payload === "object" && typeof (payload as { prompt?: unknown }).prompt === "string"
				? (payload as { prompt: string }).prompt
				: undefined;
		},
		replaceSystemPrompt(payload, systemPrompt) {
			return { ...(payload as Record<string, unknown>), prompt: systemPrompt };
		},
	});
}
