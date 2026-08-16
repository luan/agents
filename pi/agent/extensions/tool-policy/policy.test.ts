import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_TOOL_NAMES } from "../subagents/tool-names.ts";
import { ToolReach } from "../token-burden/types.ts";
import {
	clearPromotedTools,
	createToolPolicy,
	defaultToolReach,
	getToolPolicy,
	loadToolPolicyConfig,
	promoteToolToDirect,
	publishToolPolicy,
	REPLACED_BUILTIN_TOOLS,
	type ToolPolicyConfig,
	unpublishToolPolicy,
} from "./policy.ts";

const TEST_SESSION_IDS = ["root", "child", "root-clear", "child-clear"];

afterEach(() => {
	for (const sessionId of TEST_SESSION_IDS) {
		clearPromotedTools(sessionId);
		unpublishToolPolicy(sessionId);
	}
});

type Handler = (...args: any[]) => unknown;

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(HERE, "config.json");
const ASSIGNABLE: readonly ToolReach[] = [ToolReach.Direct, ToolReach.Declared, ToolReach.Deferred, ToolReach.Blocked];

function createPi(
	activeTools: string[],
	config: Partial<ToolPolicyConfig> = {},
	configPath?: string,
	codeModeEnabled = true,
	sessionId?: string,
) {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		getActiveTools: () => activeTools,
		setActiveTools: (next: string[]) => {
			activeTools = next;
		},
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	};

	const policy = createToolPolicy(
		pi,
		{
			hiddenTools: Object.keys(REPLACED_BUILTIN_TOOLS),
			directTools: ["exec", "wait", "ask_user"],
			declaredTools: [],
			deferredTools: [],
			...config,
		},
		configPath,
		() => codeModeEnabled,
		sessionId,
	);
	policy.install();

	return { policy, handlers, getActiveTools: () => activeTools };
}

function tempConfigPath(): string {
	return join(mkdtempSync(join(tmpdir(), "tool-policy-")), "config.json");
}

test("isolates published policy and promotions by session", () => {
	const root = createPi(["probe_connector"], { deferredTools: ["probe_connector"] }, undefined, true, "root");
	const child = createPi(["probe_connector"], { deferredTools: ["probe_connector"] }, undefined, true, "child");
	publishToolPolicy(root.policy, "root");
	publishToolPolicy(child.policy, "child");

	expect(promoteToolToDirect("probe_connector", "root")).toBe(true);
	expect(root.policy.toolReach("probe_connector")).toBe(ToolReach.Direct);
	expect(child.policy.toolReach("probe_connector")).toBe(ToolReach.Deferred);
	expect(getToolPolicy("root")).toBe(root.policy);
	expect(getToolPolicy("child")).toBe(child.policy);

	clearPromotedTools("root");
	clearPromotedTools("child");
});

test("clearing or shutting down one session leaves sibling promotions intact", () => {
	const root = createPi(["probe_connector"], { deferredTools: ["probe_connector"] }, undefined, true, "root-clear");
	const child = createPi(["probe_connector"], { deferredTools: ["probe_connector"] }, undefined, true, "child-clear");
	publishToolPolicy(root.policy, "root-clear");
	publishToolPolicy(child.policy, "child-clear");

	expect(promoteToolToDirect("probe_connector", "root-clear")).toBe(true);
	expect(promoteToolToDirect("probe_connector", "child-clear")).toBe(true);

	clearPromotedTools("child-clear");
	expect(root.policy.toolReach("probe_connector")).toBe(ToolReach.Direct);
	expect(child.policy.toolReach("probe_connector")).toBe(ToolReach.Deferred);

	expect(promoteToolToDirect("probe_connector", "child-clear")).toBe(true);
	child.handlers.get("session_shutdown")?.[0]?.({}, {});
	expect(root.policy.toolReach("probe_connector")).toBe(ToolReach.Direct);
	expect(child.policy.toolReach("probe_connector")).toBe(ToolReach.Deferred);

	clearPromotedTools("root-clear");
});

describe("tool policy", () => {
	test("collapses the active set to the direct surface on every refresh event", () => {
		for (const event of ["session_start", "resources_discover", "session_tree", "model_select"]) {
			const pi = createPi(["exec", "wait", "ask_user", "read", "bash", "grep", "ls", "search"]);
			pi.handlers.get(event)?.[0]?.({}, {});
			expect(pi.getActiveTools()).toEqual(["exec", "wait", "ask_user"]);
		}
	});

	// A cell refuses a hidden tool and runs a deferred one, and a subagent allowlist is intersected against hidden alone.
	test("taking a tool off the direct surface does not hide it", () => {
		const pi = createPi(["exec", "read"]);
		pi.handlers.get("session_start")?.[0]?.({}, {});

		expect(pi.getActiveTools()).toEqual(["exec"]);
		expect(pi.policy.isHidden("read")).toBe(false);
		expect(pi.policy.isHidden("exec_command")).toBe(false);
		expect(pi.policy.isHidden("grep")).toBe(true);
	});

	test("uses the supplied Code Mode state instead of process-global configuration", () => {
		const pi = createPi(["exec", "read"], {}, undefined, false);
		pi.handlers.get("session_start")?.[0]?.({}, {});

		expect(pi.getActiveTools()).toEqual(["read"]);
		expect(pi.policy.toolReach("exec")).toBe(ToolReach.Blocked);
		expect(pi.policy.toolReach("read")).toBe(ToolReach.Direct);
	});

	test("blocked built-ins name their replacement", () => {
		const pi = createPi(["read"]);
		const block = (toolName: string) => pi.handlers.get("tool_call")?.[0]?.({ toolName }, {});

		expect(block("grep")).toEqual({ block: true, reason: "`grep` is not available — use `search` instead." });
		expect(block("bash")).toEqual({ block: true, reason: "`bash` is not available — use `exec_command` instead." });
		expect(block("search")).toBeUndefined();
	});

	test("moves a tool between all 4 assignable states, in both directions", () => {
		for (const from of ASSIGNABLE) {
			for (const to of ASSIGNABLE) {
				const pi = createPi(["exec", "wait", "ask_user", "read"]);
				expect(pi.policy.setToolReach("read", from).applied).toBe(true);
				expect({ from, to, reach: pi.policy.toolReach("read") }).toEqual({ from, to, reach: from });
				expect(pi.policy.setToolReach("read", to).applied).toBe(true);
				expect({ from, to, reach: pi.policy.toolReach("read") }).toEqual({ from, to, reach: to });
			}
		}
	});

	test("refuses Unreachable as a destination", () => {
		const pi = createPi(["exec", "read"]);

		expect(pi.policy.setToolReach("read", ToolReach.Unreachable).applied).toBe(false);
		expect(pi.policy.toolReach("read")).toBe(ToolReach.Declared);
	});

	test("promotes a deferred connector tool to declared", () => {
		const pi = createPi(["exec"]);

		expect(pi.policy.toolReach("mcp__fff__grep")).toBe(ToolReach.Deferred);
		expect(pi.policy.setToolReach("mcp__fff__grep", ToolReach.Declared).applied).toBe(true);
		expect(pi.policy.toolReach("mcp__fff__grep")).toBe(ToolReach.Declared);
	});

	test("promoting to direct joins the active set and demoting leaves it", () => {
		const pi = createPi(["exec", "wait", "ask_user"]);

		pi.policy.setToolReach("read", ToolReach.Direct);
		expect(pi.getActiveTools()).toContain("read");

		pi.policy.setToolReach("ask_user", ToolReach.Declared);
		expect(pi.getActiveTools()).not.toContain("ask_user");
	});

	// nested-dispatch.ts:14 refuses `exec` and `wait` inside a cell, so a session with either demoted can call nothing.
	test("refuses to move exec or wait off the direct surface", () => {
		const pi = createPi(["exec", "wait", "ask_user"]);

		for (const toolName of ["exec", "wait"]) {
			for (const reach of [ToolReach.Declared, ToolReach.Deferred, ToolReach.Blocked]) {
				const applied = pi.policy.setToolReach(toolName, reach).applied;
				expect({ toolName, reach, applied }).toEqual({ toolName, reach, applied: false });
			}
			expect(pi.policy.toolReach(toolName)).toBe(ToolReach.Direct);
		}

		expect(pi.getActiveTools()).toEqual(["exec", "wait", "ask_user"]);
		expect(pi.policy.setToolReach("ask_user", ToolReach.Blocked).applied).toBe(true);
	});

	test("declares natives and defers mcp and connector tools", () => {
		expect(defaultToolReach("exec_command", true)).toBe(ToolReach.Declared);
		expect(defaultToolReach("search", true)).toBe(ToolReach.Declared);
		expect(defaultToolReach("mcp__fff__grep", true)).toBe(ToolReach.Deferred);
		expect(defaultToolReach("codex_apps_github_create_issue", true)).toBe(ToolReach.Deferred);
		expect(defaultToolReach("exec", true)).toBe(ToolReach.Direct);
		expect(defaultToolReach("wait_agent", true)).toBe(ToolReach.Direct);
	});

	test("ships all 6 agent tools on the direct surface", () => {
		const directTools = new Set(loadToolPolicyConfig(CONFIG_PATH).directTools);

		expect(AGENT_TOOL_NAMES).toHaveLength(6);
		expect(AGENT_TOOL_NAMES.filter((name) => directTools.has(name))).toHaveLength(6);
	});

	test("persists every reach set under the keys it reads back", () => {
		const configPath = tempConfigPath();
		writeFileSync(
			configPath,
			`${JSON.stringify({ hiddenTools: ["grep"], directTools: ["exec", "wait"] })}\n`,
			"utf8",
		);
		const pi = createPi(["read", "exec_command"], loadToolPolicyConfig(configPath), configPath);

		pi.policy.setToolReach("exec_command", ToolReach.Blocked);
		pi.policy.setToolReach("read", ToolReach.Deferred);

		expect(loadToolPolicyConfig(configPath)).toEqual({
			hiddenTools: ["grep", "exec_command"],
			directTools: ["exec", "wait"],
			declaredTools: [],
			deferredTools: ["read"],
		});
	});

	test("falls back to the built-in sets when the config will not parse", () => {
		const configPath = tempConfigPath();
		writeFileSync(configPath, "{ not json", "utf8");

		const config = loadToolPolicyConfig(configPath);

		expect(config.hiddenTools).toEqual(Object.keys(REPLACED_BUILTIN_TOOLS));
		expect(config.directTools).toContain("exec");
		expect(config.directTools).toContain("spawn_agent");
	});
});
