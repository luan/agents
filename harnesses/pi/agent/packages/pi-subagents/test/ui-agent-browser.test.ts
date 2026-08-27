import { expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { initTheme, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { AgentHub, type AgentHubSnapshot } from "../src/ui/agent-browser.ts";

const theme = {
	name: "agent-hub-test",
	bold: (text: string) => text,
	getColorMode: () => "truecolor",
	getFgAnsi: () => "\x1b[38;2;120;160;220m",
	getBgAnsi: () => "\x1b[48;2;20;24;30m",
} as never as Theme;

initTheme("dark", false);

test("agent transcripts use the child session's tool renderer and retain it across host invalidation", () => {
	let resolutions = 0;
	const definition = {
		name: "custom_tool",
		label: "Custom Tool",
		description: "test",
		parameters: Type.Object({}),
		execute: async () => ({ content: [], details: undefined }),
		renderShell: "self",
		renderCall: () => new Text("actual call renderer"),
		renderResult: () => new Text("actual result renderer"),
	} satisfies ToolDefinition;
	const messages = toolMessages();
	const transcript = {
		getMessages: () => messages,
		generation: () => 0,
		preview: () => undefined,
		subscribe: () => () => {},
	};
	const snapshot = agentSnapshot(transcript);
	const source = { getSnapshot: () => snapshot, subscribe: () => () => {} };
	const tui = { terminal: { rows: 14 }, requestRender() {} } as never;
	const hub = new AgentHub(
		source,
		tui,
		theme,
		() => {},
		() => ({
			resolveTool(name) {
				resolutions++;
				return name === "custom_tool" ? definition : undefined;
			},
			resolveCustomMessage: () => undefined,
		}),
	);

	const first = stripTerminalSequences(hub.render(90).join("\n"));
	hub.invalidate();
	const second = stripTerminalSequences(hub.render(90).join("\n"));
	expect(first).toContain("actual call renderer");
	expect(first).toContain("actual result renderer");
	expect(second).toContain("actual result renderer");
	expect(resolutions).toBe(1);
	hub.dispose();
});

test("agent transcript detail supports mouse-wheel scrolling and displays a scrollbar", () => {
	const messages: AgentMessage[] = Array.from({ length: 20 }, (_, index) => toolMessages(index)).flat();
	const transcript = {
		getMessages: () => messages,
		generation: () => 0,
		preview: () => undefined,
		subscribe: () => () => {},
	};
	const snapshot = agentSnapshot(transcript);
	const source = { getSnapshot: () => snapshot, subscribe: () => () => {} };
	const tui = { terminal: { rows: 12 }, requestRender() {} } as never;
	const hub = new AgentHub(
		source,
		tui,
		theme,
		() => {},
		() => ({
			resolveTool: () => ({
				name: "custom_tool",
				label: "Custom Tool",
				description: "test",
				parameters: Type.Object({}),
				execute: async () => ({ content: [], details: undefined }),
				renderShell: "self",
				renderCall: (_args, _theme, context) => new Text(`transcript line ${context.toolCallId}`),
				renderResult: () => new Text("completed"),
			}),
			resolveCustomMessage: () => undefined,
		}),
	);
	const bottom = stripTerminalSequences(hub.render(60).join("\n"));
	expect(bottom).toContain("█");
	expect(hub.onMouse({ type: "wheel", row: 4, col: 20, wheel: -1 } as never)).toBe(true);
	const scrolled = stripTerminalSequences(hub.render(60).join("\n"));
	expect(scrolled).not.toBe(bottom);
	hub.dispose();
});

test("agent transcript embeds the real user renderer without terminal-wide zones", () => {
	const messages: AgentMessage[] = [
		{ role: "user", content: [{ type: "text", text: "nested user message" }], timestamp: 1 },
	];
	const transcript = {
		getMessages: () => messages,
		generation: () => 0,
		preview: () => undefined,
		subscribe: () => () => {},
	};
	const source = { getSnapshot: () => agentSnapshot(transcript), subscribe: () => () => {} };
	const tui = { terminal: { rows: 12 }, requestRender() {} } as never;
	const hub = new AgentHub(source, tui, theme, () => {});

	const rendered = hub.render(90).join("\n");
	expect(stripTerminalSequences(rendered)).toContain("nested user message");
	expect(rendered).not.toContain("\x1b]133;");
	hub.dispose();
});

test("opens with the clicked widget agent selected", () => {
	const firstTranscript = transcriptWithText("first transcript");
	const secondTranscript = transcriptWithText("second transcript");
	const first = agentSnapshot(firstTranscript).agents[0]!;
	const snapshot: AgentHubSnapshot = {
		generation: 0,
		agents: [first, { ...first, id: "/root/second", description: "second", transcript: secondTranscript }],
	};
	const source = { getSnapshot: () => snapshot, subscribe: () => () => {} };
	const tui = { terminal: { rows: 12 }, requestRender() {} } as never;
	const hub = new AgentHub(source, tui, theme, () => {}, undefined, "/root/second");

	const rendered = stripTerminalSequences(hub.render(90).join("\n"));
	expect(rendered).toContain("second transcript");
	expect(rendered).not.toContain("first transcript");
	hub.dispose();
});

function transcriptWithText(text: string): AgentHubSnapshot["agents"][number]["transcript"] {
	return {
		getMessages: () => [{ role: "user", content: [{ type: "text", text }], timestamp: 1 }],
		generation: () => 0,
		preview: () => ({ kind: "user", text }),
		subscribe: () => () => {},
	};
}

function agentSnapshot(transcript: AgentHubSnapshot["agents"][number]["transcript"]): AgentHubSnapshot {
	return {
		generation: 0,
		agents: [
			{
				id: "/root/worker",
				rootSessionId: "root",
				parentId: "/root",
				cwd: "/tmp",
				description: "worker",
				status: "idle",
				message: "work",
				startedAt: 1,
				toolUses: 1,
				cost: 0,
				tokenCount: 0,
				compactions: 0,
				transcriptAvailable: true,
				transcript,
			},
		],
	};
}

function toolMessages(index = 0): AgentMessage[] {
	const id = `call-${index}`;
	return [
		{
			role: "assistant",
			content: [{ type: "toolCall", id, name: "custom_tool", arguments: {} }],
			api: "test",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: index * 2 + 1,
		},
		{
			role: "toolResult",
			toolCallId: id,
			toolName: "custom_tool",
			content: [{ type: "text", text: "raw fallback output" }],
			isError: false,
			timestamp: index * 2 + 2,
		},
	];
}
