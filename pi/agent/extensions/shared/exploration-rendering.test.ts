import { expect, test } from "bun:test";

import {
	isExplorationHidden,
	readAction,
	registerExplorationEventHandlers,
	registerExplorationTool,
	renderExplorationCall,
	renderExplorationSummaryTitle,
} from "./exploration-rendering";

const theme = {
	fg(_role: string, text: string) {
		return text;
	},
	bold(text: string) {
		return `**${text}**`;
	},
};

test("exploration grouping keeps incompatible render targets separate", () => {
	const handlers = new Map<string, ((event: any) => void)[]>();
	const pi = {
		on(event: string, handler: (event: any) => void) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	};
	const emit = (event: string, payload: any) => {
		for (const handler of handlers.get(event) ?? []) handler(payload);
	};

	registerExplorationTool("read", (args) =>
		readAction(typeof args === "object" && args && "path" in args ? String(args.path) : ""),
	);
	registerExplorationTool("grep", (args) => ({
		kind: "search",
		title: "Search",
		body: typeof args === "object" && args && "pattern" in args ? String(args.pattern) : "",
	}));
	registerExplorationEventHandlers(pi);

	emit("session_start", {});
	emit("tool_execution_start", {
		toolName: "read",
		toolCallId: "read-1",
		args: { path: "/tmp/a.ts" },
	});
	emit("tool_execution_start", {
		toolName: "grep",
		toolCallId: "grep-1",
		args: { pattern: "needle" },
	});
	emit("tool_execution_end", { toolName: "read", toolCallId: "read-1" });
	emit("tool_execution_end", { toolName: "grep", toolCallId: "grep-1" });

	expect(isExplorationHidden("read-1")).toBe(false);
});

test("exploration grouping invalidates calls rendered before their start events", () => {
	const handlers = new Map<string, ((event: any) => void)[]>();
	const pi = {
		on(event: string, handler: (event: any) => void) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	};
	const emit = (event: string, payload: any) => {
		for (const handler of handlers.get(event) ?? []) handler(payload);
	};

	registerExplorationTool("read", (args) =>
		readAction(typeof args === "object" && args && "path" in args ? String(args.path) : ""),
	);
	registerExplorationEventHandlers(pi);
	emit("session_start", {});

	let firstInvalidations = 0;
	let secondInvalidations = 0;
	renderExplorationCall(readAction("/tmp/a.ts"), theme, {
		toolCallId: "read-before-start-1",
		invalidate: () => firstInvalidations++,
	});
	emit("tool_execution_start", {
		toolName: "read",
		toolCallId: "read-before-start-1",
		args: { path: "/tmp/a.ts" },
	});
	renderExplorationCall(readAction("/tmp/b.ts"), theme, {
		toolCallId: "read-before-start-2",
		invalidate: () => secondInvalidations++,
	});
	emit("tool_execution_start", {
		toolName: "read",
		toolCallId: "read-before-start-2",
		args: { path: "/tmp/b.ts" },
	});

	expect(firstInvalidations).toBe(1);
	expect(secondInvalidations).toBe(1);
});

test("exploration grouping rebuilds contiguous reads when a session resumes", () => {
	const handlers = new Map<string, ((event: any, context?: any) => void)[]>();
	const pi = {
		on(event: string, handler: (event: any, context?: any) => void) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	};
	const branch = [
		{
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "read-resume-1", name: "read", arguments: { path: "/tmp/a.ts" } }],
			},
		},
		{
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "read-resume-1",
				toolName: "read",
				content: [{ type: "text", text: "a" }],
			},
		},
		{
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "read-resume-2", name: "read", arguments: { path: "/tmp/b.ts" } }],
			},
		},
		{
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "read-resume-2",
				toolName: "read",
				content: [{ type: "text", text: "b" }],
			},
		},
	];
	const compaction = { type: "compaction" };
	const fullBranch = [
		{
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "read-omitted", name: "read", arguments: { path: "/tmp/old.ts" } }],
			},
		},
		{
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "read-omitted",
				toolName: "read",
				content: [{ type: "text", text: "old" }],
			},
		},
		...branch,
		compaction,
	];

	registerExplorationTool("read", (args) =>
		readAction(typeof args === "object" && args && "path" in args ? String(args.path) : ""),
	);
	registerExplorationEventHandlers(pi);
	for (const handler of handlers.get("session_start") ?? []) {
		handler(
			{},
			{
				sessionManager: {
					getBranch: () => fullBranch,
					buildContextEntries: () => [compaction, ...branch],
				},
			},
		);
	}

	expect(isExplorationHidden("read-resume-1")).toBe(true);
	expect(isExplorationHidden("read-resume-2")).toBe(false);
	expect(
		renderExplorationCall(readAction("/tmp/b.ts"), theme, {
			toolCallId: "read-resume-2",
			isPartial: false,
		}),
	).not.toContain("/tmp/old.ts");
});
test("resource reads with different paths do not share exploration targets", () => {
	expect(readAction("pr://owner/repo/1").renderTarget).not.toBe(readAction("pr://owner/repo/2").renderTarget);
});

test("typed exploration summary title renders without throwing", () => {
	expect(() =>
		renderExplorationSummaryTitle(
			{
				icon: "I",
				iconRole: "muted",
				label: "Issue",
				title: "#1",
				subtitle: "Summary",
				typeIcon: "T",
			},
			theme,
		),
	).not.toThrow();
});
