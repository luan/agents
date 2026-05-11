import { expect, test } from "bun:test";
import {
	DEFAULT_DYNAMIC_TOOLS_CONFIG,
	evaluateDynamicToolRules,
	shouldTerminateForDynamicTools,
	validateDynamicToolDag,
} from "./core.ts";
import dynamicToolsExtension from "./index.ts";

test("dynamic tool rules activate children after matching parent input and result", () => {
	const active = new Set<string>();
	const evaluation = evaluateDynamicToolRules(
		DEFAULT_DYNAMIC_TOOLS_CONFIG,
		{
			toolName: "exec_command",
			input: { tty: true },
			result: { session_id: 7 },
		},
		active,
	);

	expect(evaluation.matches).toHaveLength(1);
	expect(evaluation.matches[0]?.newlyActivated).toEqual(["write_stdin"]);
	expect(evaluation.matches[0]?.continuation).toContain("session_id 7");
	expect([...active]).toEqual(["write_stdin"]);
});

test("dynamic tool rules ignore non-matching parent parameters", () => {
	const active = new Set<string>();
	const evaluation = evaluateDynamicToolRules(
		DEFAULT_DYNAMIC_TOOLS_CONFIG,
		{
			toolName: "exec_command",
			input: { tty: false },
			result: { session_id: 7 },
		},
		active,
	);

	expect(evaluation.matches).toEqual([]);
	expect([...active]).toEqual([]);
});

test("dynamic tool rules keep tools active after child tool results", () => {
	const active = new Set(["write_stdin"]);
	const evaluation = evaluateDynamicToolRules(
		DEFAULT_DYNAMIC_TOOLS_CONFIG,
		{
			toolName: "write_stdin",
			input: { session_id: 7 },
			result: { exit_code: 0 },
		},
		active,
	);

	expect(evaluation.matches).toEqual([]);
	expect([...active]).toEqual(["write_stdin"]);
});

test("dynamic tool rules request fresh runs only when a child is not already active", () => {
	const event = {
		toolName: "exec_command",
		input: { tty: true },
		result: { session_id: 7 },
	};

	expect(shouldTerminateForDynamicTools(DEFAULT_DYNAMIC_TOOLS_CONFIG, event, ["exec_command"])).toBe(true);
	expect(shouldTerminateForDynamicTools(DEFAULT_DYNAMIC_TOOLS_CONFIG, event, ["exec_command", "write_stdin"])).toBe(
		false,
	);
});

test("dynamic tool DAG validator reports cycles", () => {
	const diagnostics = validateDynamicToolDag({
		roots: [],
		rules: [
			{ id: "a-b", from: "a", to: ["b"], enabled: true },
			{ id: "b-a", from: "b", to: ["a"], enabled: true },
		],
	});

	expect(diagnostics[0]).toContain("Cycle detected");
});

test("dynamic-tools extension applies activation and handoff", async () => {
	type Handler = (event?: any, ctx?: any) => any;
	const handlers = new Map<string, Handler[]>();
	const sentUserMessages: string[] = [];
	let activeTools = ["read", "exec_command"];
	const pi = {
		registerCommand() {},
		getActiveTools: () => activeTools,
		setActiveTools: (next: string[]) => {
			activeTools = next;
		},
		sendUserMessage: (message: string) => {
			sentUserMessages.push(message);
		},
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	} as any;
	dynamicToolsExtension(pi);

	for (const handler of handlers.get("session_start") ?? []) handler();
	expect(activeTools).toEqual(["read", "exec_command"]);

	for (const handler of handlers.get("tool_result") ?? []) {
		handler({
			toolName: "exec_command",
			input: { tty: true },
			details: { session_id: 7 },
		});
	}
	expect(activeTools).toEqual(["read", "exec_command", "write_stdin"]);

	for (const handler of handlers.get("agent_end") ?? []) handler();
	await Bun.sleep(20);
	expect(sentUserMessages).toEqual([
		"Continue the previous interactive terminal task. Use write_stdin with session_id 7; do not start a replacement exec_command for that session.",
	]);

	for (const handler of handlers.get("tool_result") ?? []) {
		handler({
			toolName: "write_stdin",
			input: { session_id: 7 },
			details: { exit_code: 0 },
		});
	}
	expect(activeTools).toEqual(["read", "exec_command", "write_stdin"]);
});
