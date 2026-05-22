import "./setup-home";
import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import piExtension from "./index.js";
import { resetExecCommandContextGuardEnabled } from "./pi/index.js";

const originalCoreBin = process.env.CONTEXT_GUARD_BIN;
const originalPiConfigDir = process.env.PI_CONFIG_DIR;
const originalProjectDir = process.env.CONTEXT_GUARD_PROJECT_DIR;

afterEach(() => {
	if (originalCoreBin === undefined) {
		delete process.env.CONTEXT_GUARD_BIN;
	} else {
		process.env.CONTEXT_GUARD_BIN = originalCoreBin;
	}
	if (originalPiConfigDir === undefined) {
		delete process.env.PI_CONFIG_DIR;
	} else {
		process.env.PI_CONFIG_DIR = originalPiConfigDir;
	}
	if (originalProjectDir === undefined) {
		delete process.env.CONTEXT_GUARD_PROJECT_DIR;
	} else {
		process.env.CONTEXT_GUARD_PROJECT_DIR = originalProjectDir;
	}
	resetExecCommandContextGuardEnabled();
});

function createMockPiWithHooks() {
	const hooks = new Map<string, (...args: any[]) => any>();
	const commands = new Map<string, { handler: (...args: any[]) => any }>();
	return {
		hooks,
		commands,
		on(name: string, handler: (...args: any[]) => any) {
			hooks.set(name, handler);
		},
		registerCommand(name: string, def: { handler: (...args: any[]) => any }) {
			commands.set(name, def);
		},
		registerTool() {},
	};
}

describe("piExtension — session hook delegation", () => {
	it("delegates session init, event writes, and resume reads to the Rust core", async () => {
		const dir = mkdtempSync(join(tmpdir(), "context-guard-session-hooks-test-"));
		const coreBin = join(dir, "context-guard-core.js");
		const logPath = join(dir, "requests.log");
		const projectDir = join(dir, "project");
		const configDir = join(dir, "config");
		process.env.CONTEXT_GUARD_BIN = coreBin;
		process.env.CONTEXT_GUARD_PROJECT_DIR = projectDir;
		process.env.PI_CONFIG_DIR = configDir;

		writeFileSync(
			coreBin,
			[
				`#!${process.execPath}`,
				"const fs = require('node:fs');",
				`const logPath = ${JSON.stringify(logPath)};`,
				"let input = '';",
				"process.stdin.setEncoding('utf8');",
				"process.stdin.on('data', chunk => input += chunk);",
				"process.stdin.on('end', () => {",
				"  const request = JSON.parse(input);",
				"  const entries = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, 'utf8')) : [];",
				"  entries.push(request);",
				"  fs.writeFileSync(logPath, JSON.stringify(entries), 'utf8');",
				"  let payload = {};",
				"  if (request.command === 'session' && request.params?.action === 'query') {",
				"    payload = {",
				"      events: [",
				"        {",
				"          id: 1,",
				"          session_id: request.params.sessionId,",
				"          type: 'summary',",
				"          category: 'decision',",
				"          priority: 4,",
				"          data: 'remember the Rust session path',",
				"          project_dir: '',",
				"          attribution_source: 'unknown',",
				"          attribution_confidence: 0,",
				"          bytes_avoided: 0,",
				"          bytes_returned: 0,",
				"          source_hook: 'PostToolUse',",
				"          created_at: '2024-01-01 00:00:00',",
				"          data_hash: 'ABCD1234'",
				"        }",
				"      ],",
				"      resume: { snapshot: '<resume>carry this forward</resume>', eventCount: 1, consumed: false },",
				"      stats: { compact_count: 0 }",
				"    };",
				"  } else if (request.command === 'session' && request.params?.action === 'extract_hook_events') {",
				"    payload = [{ type: 'tool_call', category: 'pi', data: JSON.stringify({ tool: request.params?.fallbackToolName ?? 'unknown-tool' }), priority: 1 }];",
				"  } else if (request.command === 'session' && request.params?.action === 'check_tool_call') {",
				"    const command = request.params?.hookInput?.tool_input?.command ?? '';",
				"    payload = typeof command === 'string' && command.includes('curl ')",
				"      ? { block: true, reason: 'blocked from rust' }",
				"      : { block: false };",
				"  } else if (request.command === 'session' && request.params?.action === 'prepare_before_agent_start') {",
				"    payload = {",
				"      activeMemory: '<session_state source=\"compaction\"><rules>remember the Rust session path</rules><session_mode>investigate</session_mode></session_state>',",
				"      resumeSnapshot: '<resume>carry this forward</resume>',",
				"      systemPrompt: 'base prompt\\n\\n<context_window_protection>rust owned</context_window_protection>\\n\\n<session_state source=\"compaction\"><rules>remember the Rust session path</rules><session_mode>investigate</session_mode></session_state>\\n\\n<resume>carry this forward</resume>'",
				"    };",
				"  } else if (request.command === 'session' && request.params?.action === 'prepare_before_compact') {",
				"    payload = { eventCount: 1, snapshot: '<resume>carry this forward</resume>' };",
				"  } else if (request.command === 'session' && request.params?.action === 'build_pi_check') {",
				"    payload = 'rust cg-check summary';",
				"  }",
				"  process.stdout.write(JSON.stringify({ ok: true, content: [{ type: 'text', text: JSON.stringify(payload) }] }));",
				"});",
				"",
			].join("\n"),
			"utf8",
		);
		chmodSync(coreBin, 0o755);

		const pi = createMockPiWithHooks();
		piExtension(pi);

		const sessionStart = pi.hooks.get("session_start");
		const toolResult = pi.hooks.get("tool_result");
		const beforeAgentStart = pi.hooks.get("before_agent_start");
		const beforeCompact = pi.hooks.get("session_before_compact");
		expect(sessionStart).toBeDefined();
		const toolCall = pi.hooks.get("tool_call");
		expect(toolResult).toBeDefined();
		expect(beforeAgentStart).toBeDefined();
		expect(beforeCompact).toBeDefined();
		expect(toolCall).toBeDefined();

		sessionStart?.({}, { sessionManager: { getSessionFile: () => join(dir, "pi-session.json") } });
		const blockResult = toolCall?.({ toolName: "bash", input: { command: "curl https://example.com" } });
		toolResult?.({ toolName: "unknown-tool", input: { hello: "world" } });
		pi.hooks.get("before_provider_response")?.({ model: "gpt-test", provider: "openai", latencyMs: 12 });

		const result = await beforeAgentStart?.({ prompt: "user prompt", systemPrompt: "base prompt" });
		beforeCompact?.();
		const cgCheck = pi.commands.get("cg-check");
		const cgCheckResult = await cgCheck?.handler({});
		expect(blockResult).toEqual({ block: true, reason: "blocked from rust" });
		expect(cgCheckResult).toEqual({ text: "rust cg-check summary" });
		expect(result?.systemPrompt).toContain("rust owned");
		expect(result?.systemPrompt).toContain("remember the Rust session path");
		expect(result?.systemPrompt).toContain("<resume>carry this forward</resume>");

		const requests = JSON.parse(readFileSync(logPath, "utf8")) as Array<{
			command: string;
			params?: { action?: string; events?: Array<{ type: string }> };
		}>;
		expect(requests.some((request) => request.command === "session" && request.params?.action === "init")).toBe(true);
		expect(
			requests.some((request) => request.command === "session" && request.params?.action === "extract_hook_events"),
		).toBe(true);
		expect(
			requests.some((request) => request.command === "session" && request.params?.action === "check_tool_call"),
		).toBe(true);
		expect(
			requests.some(
				(request) =>
					request.command === "session" && request.params?.action === "events" && request.params?.events?.length,
			),
		).toBe(true);
		expect(
			requests.some(
				(request) => request.command === "session" && request.params?.action === "prepare_before_agent_start",
			),
		).toBe(true);
		expect(
			requests.some(
				(request) => request.command === "session" && request.params?.action === "record_provider_response",
			),
		).toBe(true);
		expect(
			requests.some(
				(request) => request.command === "session" && request.params?.action === "prepare_before_compact",
			),
		).toBe(true);
		expect(
			requests.some((request) => request.command === "session" && request.params?.action === "build_pi_check"),
		).toBe(true);
	});
});
