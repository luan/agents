import { afterEach, expect, mock, spyOn, test } from "bun:test";
import {
	AssistantMessageComponent,
	initTheme,
	type SessionEntry,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, ProcessTerminal, Text, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { configureTuiAppearance, DEFAULT_TUI_APPEARANCE, sharedMotionScheduler, tuiTheme } from "@luan.sh/pi-libtui";
import type { TuiMouseEvent } from "@luan.sh/pi-libtui/mouse";
import { mountTranscriptProjection, ToolActivity, type TranscriptEntry } from "@luan.sh/pi-libtui/tool";
import {
	getThemeByName,
	theme,
} from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { ActivityTimings } from "../src/activity-timing.ts";
import { ActivityTranscript, activitySummary } from "../src/activity-transcript.ts";

initTheme("dark", false);
afterEach(() => {
	configureTuiAppearance(DEFAULT_TUI_APPEARANCE);
	mock.restore();
});

class TestTui extends TuiAltScreen {
	requestRender(): void {}
}

function message(content: Parameters<AssistantMessageComponent["updateContent"]>[0]["content"]) {
	return {
		role: "assistant" as const,
		content,
		api: "openai-responses" as const,
		provider: "openai",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse" as const,
		timestamp: 0,
	};
}

function fixture(timings = new ActivityTimings(), now: () => number = () => 0, activeTheme = theme) {
	configureTuiAppearance({ activityIndicator: "static", textEffect: "off" });
	const tui = new TestTui(new ProcessTerminal());
	const document = new Container();
	const chat = new Container();
	document.addChild(new Container());
	document.addChild(new Container());
	document.addChild(chat);
	tui.addChild(document);
	let projection: ActivityTranscript | undefined;
	const unmount = mountTranscriptProjection(tui, (entries) => {
		projection = new ActivityTranscript(entries, activeTheme, () => {}, timings, now);
		return projection;
	});
	if (!unmount || !projection) throw new Error("Expected a mounted transcript");
	return { tui, document, chat, projection, unmount };
}

function lines(component: { render(width: number): string[] }, width = 80): string[] {
	return component.render(width).map((line) => Bun.stripANSI(line).trimEnd());
}
function click(projection: ActivityTranscript, row: number): void {
	const event: TuiMouseEvent = {
		type: "press",
		row,
		col: 2,
		screenRow: row,
		screenCol: 2,
		button: 0,
		wheel: undefined,
		shift: false,
		alt: false,
		ctrl: false,
	};
	expect(projection.onMouse(event)).toBe(true);
	expect(projection.onMouse({ ...event, type: "release" })).toBe(true);
}

test("native thinking and tool rows collapse together and expand with their original content", () => {
	const f = fixture();
	const thought = new AssistantMessageComponent(
		message([{ type: "thinking", thinking: "**Inspect source**\n\nDetailed reasoning." }]),
	);
	const tool = new ToolExecutionComponent(
		"exec_command",
		"one",
		{ cmd: "cat file" },
		undefined,
		undefined,
		f.tui,
		"/tmp",
	);
	tool.markExecutionStarted();
	tool.updateResult({ content: [{ type: "text", text: "original output" }], isError: false });
	f.chat.addChild(thought);
	f.chat.addChild(tool);
	const compact = lines(f.document);
	expect(compact.filter(Boolean)).toHaveLength(1);
	expect(compact.join("\n")).toContain("Inspect source");
	expect(compact.join("\n")).toContain("2 steps");
	expect(compact.join("\n")).not.toContain("Detailed reasoning.");
	expect(compact.join("\n")).not.toContain("original output");
	click(f.projection, 1);
	const expanded = lines(f.document).join("\n");
	expect(expanded).toContain("Detailed reasoning.");
	expect(expanded).toContain("original output");
	click(f.projection, 1);
	expect(lines(f.document).filter(Boolean)).toHaveLength(1);
	f.unmount();
	expect(f.document.children[2]).toBe(f.chat);
	expect(lines(f.document).join("\n")).toContain("original output");
});

test("active work stays compact across tools and continuations while prose and previous folds stay visible", () => {
	const f = fixture();
	f.chat.addChild(
		new AssistantMessageComponent(
			message([{ type: "thinking", thinking: "**Previous turn**\n\nHistorical details." }]),
		),
	);
	f.chat.addChild(new Text("Next user request", 0, 0));
	f.projection.beginTurn();
	const thought = new AssistantMessageComponent();
	const source = message([{ type: "thinking", thinking: "**Current work**\n\nLive reasoning." }]);
	thought.updateContent(source, true);
	f.chat.addChild(thought);
	let rendered = lines(f.document).join("\n");
	expect(rendered).toContain("Working for 0s · Current work · 1 step");
	expect(rendered).not.toContain("Live reasoning.");
	expect(rendered).not.toContain("Historical details.");
	thought.updateContent(source, false);
	const tool = new ToolExecutionComponent("read", "live", {}, undefined, undefined, f.tui, "/tmp");
	tool.markExecutionStarted();
	tool.updateResult({ content: [{ type: "text", text: "Live tool progress" }], isError: false }, true);
	f.chat.addChild(tool);
	rendered = lines(f.document).join("\n");
	expect(rendered).toContain("Working · Current work · 2 steps");
	expect(rendered).not.toContain("Live tool progress");
	tool.updateResult({ content: [{ type: "text", text: "Completed tool output" }], isError: false });
	// The group stays live between tool completion and the next model request.
	expect(lines(f.document).join("\n")).toContain("Working · Current work · 2 steps");
	f.chat.addChild(new AssistantMessageComponent(message([{ type: "text", text: "Checking the result." }])));
	// Automatic continuation must not reveal the earlier output.
	f.projection.beginTurn();
	f.chat.addChild(
		new AssistantMessageComponent(message([{ type: "thinking", thinking: "**Verify result**\n\nFollow-up detail." }])),
	);
	rendered = lines(f.document).join("\n");
	expect(rendered).not.toContain("Live reasoning.");
	expect(rendered).not.toContain("Completed tool output");
	expect(rendered).not.toContain("Follow-up detail.");
	expect(rendered).toContain("Worked · Current work · 2 steps");
	expect(rendered).toContain("Working · Verify result · 1 step");
	expect(rendered).toContain("Checking the result.");
	f.projection.finishTurn();
	rendered = lines(f.document).join("\n");
	expect(rendered).not.toContain("Live reasoning.");
	expect(rendered).not.toContain("Completed tool output");
	expect(rendered).not.toContain("Follow-up detail.");
	expect(rendered).toContain("Current work · 2 steps");
	expect(rendered).toContain("Verify result · 1 step");
	expect(rendered).not.toContain("Working");
	expect(rendered).toContain("Checking the result.");
	// Starting another turn leaves the finished folds alone.
	f.projection.beginTurn();
	expect(lines(f.document).join("\n")).toBe(rendered);
	f.unmount();
});

test("streamed updates retain expansion and update the latest thinking heading", () => {
	const f = fixture();
	f.projection.beginTurn();
	const thought = new AssistantMessageComponent();
	const source = message([{ type: "thinking", thinking: "**First step**\n\nDetails." }]);
	thought.updateContent(source, true);
	f.chat.addChild(thought);
	expect(lines(f.document).join("\n")).toContain("First step");
	click(f.projection, 1);
	// Pi may reuse the same streamed message object.
	source.content = [{ type: "thinking", thinking: "**Second step**\n\nMore detail." }];
	thought.updateContent(source, true);
	const updated = lines(f.document).join("\n");
	expect(updated).toContain("Second step");
	expect(updated).toContain("More detail.");
	thought.updateContent(source, false);
	f.projection.beginTurn();
	expect(lines(f.document).join("\n")).toContain("More detail.");
	f.projection.finishTurn();
	expect(lines(f.document).join("\n")).toContain("More detail.");
	expect(lines(f.document).join("\n")).not.toContain("●");
	click(f.projection, 1);
	expect(lines(f.document).join("\n")).not.toContain("More detail.");
	f.unmount();
});

test("tools retain the latest thinking summary while running and after completion", () => {
	const f = fixture();
	const thought = new AssistantMessageComponent(
		message([{ type: "thinking", thinking: "**First step**\n\nDetails.\n\n**Implement marker helper**\n\nNext." }]),
	);
	f.chat.addChild(thought);
	const tool = new ToolExecutionComponent("exec", "one", {}, undefined, undefined, f.tui, "/tmp");
	tool.markExecutionStarted();
	f.chat.addChild(tool);
	const running = lines(f.document).join("\n");
	expect(running).toContain("Implement marker helper");
	expect(running).toContain("2 steps");
	expect(running).not.toContain("exec");
	tool.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
	expect(lines(f.document).join("\n")).toContain("Implement marker helper");
	const next = new AssistantMessageComponent();
	next.updateContent(message([{ type: "thinking", thinking: "**Verify marker rendering**" }]), true);
	f.chat.addChild(next);
	expect(lines(f.document).join("\n")).toContain("Verify marker rendering");
	f.unmount();
});

test("tool summaries use live semantic fields without flattening or pre-truncating custom renderers", () => {
	const f = fixture();
	f.projection.beginTurn();
	let headerRenders = 0;
	let payloadRenders = 0;
	const detail = `${"long/path/".repeat(12)}transcript.ts`;
	const activity = new ToolActivity({
		theme,
		requestRender: () => {},
		action: {
			render: () => {
				headerRenders++;
				return ["Explored", "  └ Read truncated…"];
			},
			invalidate() {},
		},
		view: {
			action: { verb: "Read", detail, status: "succeeded" },
			payload: {
				kind: "component",
				preview: {
					render: () => {
						payloadRenders++;
						return ["original tool output"];
					},
					invalidate() {},
				},
			},
		},
	});
	const tool = new ToolExecutionComponent(
		"exec",
		"one",
		{},
		undefined,
		{ renderResult: () => activity },
		f.tui,
		"/tmp",
	);
	tool.updateResult({ content: [], isError: false });
	f.chat.addChild(tool);
	const compact = lines(f.document, 200).join("\n");
	expect(compact).toContain(`Read · ${detail}`);
	expect(compact).not.toMatch(/[└…]/u);
	expect(headerRenders).toBe(0);
	expect(payloadRenders).toBe(0);
	// Nested renderers can update independently of the enclosing Pi result.
	activity.update({ action: { verb: "Verified", detail: "transcript.ts", status: "succeeded" } });
	expect(lines(f.document).join("\n")).toContain("Verified · transcript.ts");
	click(f.projection, 1);
	expect(lines(f.document).join("\n")).toContain("Explored");
	expect(headerRenders).toBeGreaterThan(0);
	f.unmount();
	activity.dispose();
});

test("prose separates folds and failed tools stay visible without expanding reasoning", () => {
	const f = fixture();
	f.projection.beginTurn();
	f.chat.addChild(
		new AssistantMessageComponent(
			message([
				{ type: "thinking", thinking: "**Check files**\n\nLonger thought." },
				{ type: "text", text: "Here is my answer." },
			]),
		),
	);
	const tool = new ToolExecutionComponent("build", "one", {}, undefined, undefined, f.tui, "/tmp");
	tool.updateResult({ content: [{ type: "text", text: "build failure details" }], isError: true });
	f.chat.addChild(tool);
	const compact = lines(f.document).join("\n");
	expect(compact).toContain("Here is my answer.");
	expect(compact).toContain("Check files");
	expect(compact).toContain("1 failed");
	expect(compact).not.toContain("Longer thought.");
	expect(compact).toContain("build failure details");
	f.projection.finishTurn();
	expect(lines(f.document).join("\n")).toContain("build failure details");
	f.unmount();
});

test("retains unknown nodes and native error notices; detach stops animation without owning native tools", () => {
	const mounts = sharedMotionScheduler.activeMountCount;
	const f = fixture();
	f.chat.addChild(new Text("unknown notice", 0, 0));
	const failed = new AssistantMessageComponent({
		...message([{ type: "thinking", thinking: "Interrupted thought" }]),
		stopReason: "error",
		errorMessage: "network failed",
	});
	f.chat.addChild(failed);
	const tool = new ToolExecutionComponent("build", "one", {}, undefined, undefined, f.tui, "/tmp");
	tool.markExecutionStarted();
	f.chat.addChild(tool);
	const rendered = lines(f.document).join("\n");
	expect(rendered).toContain("unknown notice");
	expect(rendered).toContain("network failed");
	f.unmount();
	expect(sharedMotionScheduler.activeMountCount).toBe(mounts);
	expect(f.chat.children).toContain(tool);
});

test("unsupported roots and duplicate mounts leave the host unchanged", () => {
	const tui = new TestTui(new ProcessTerminal());
	expect(
		mountTranscriptProjection(tui, () => {
			throw new Error("must not run");
		}),
	).toBeUndefined();
	const f = fixture();
	expect(
		mountTranscriptProjection(f.tui, () => {
			throw new Error("must not run");
		}),
	).toBeUndefined();
	f.unmount();
	const release = mountTranscriptProjection(f.tui, (entries) => new ActivityTranscript(entries, theme, () => {}));
	expect(release).toBeDefined();
	release?.();
});

test("summary uses the latest supplied heading, bounds text and strips control sequences", () => {
	const part: TranscriptEntry = {
		kind: "thinking",
		key: {},
		component: new Container(),
		running: false,
		failed: false,
		summary: "**Old**\n\nPrior.\n\n**Latest**\n\nCurrent.",
	};
	expect(activitySummary(part)).toBe("Latest");
	const text = activitySummary({ ...part, summary: `\x1b]52;c;secret\x07${"word ".repeat(1000)}` });
	expect(text).not.toContain("\x1b");
	expect(text.length).toBeLessThanOrEqual(241);
	const transcript = new ActivityTranscript(
		() => [part],
		theme,
		() => {},
	);
	for (const width of [1, 2, 8, 40])
		expect(transcript.render(width).every((row) => visibleWidth(row) <= width)).toBe(true);
	transcript.dispose();
});

test("muted, underlined rows retain saved wall time across parallel tools and reloads", () => {
	// Chalk disables attributes without a TTY; exercise the terminal theme contract.
	const styledTheme = getThemeByName("dark")!;
	spyOn(styledTheme, "underline").mockImplementation((text) => `\x1b[4m${text}\x1b[24m`);
	spyOn(styledTheme, "italic").mockImplementation((text) => `\x1b[3m${text}\x1b[23m`);
	const source = {
		...message([
			{ type: "thinking", thinking: "**Checking index baseline**" },
			{ type: "toolCall", id: "one", name: "read", arguments: {} },
			{ type: "toolCall", id: "two", name: "read", arguments: {} },
		]),
		timestamp: 1_000,
	};
	const branch: SessionEntry[] = [
		{
			type: "message",
			id: "assistant",
			parentId: null,
			timestamp: new Date(3_000).toISOString(),
			message: source,
		},
	];
	const result = (id: string, timestamp: number): SessionEntry => ({
		type: "message",
		id,
		parentId: "assistant",
		timestamp: new Date(timestamp).toISOString(),
		message: { role: "toolResult", toolCallId: id, toolName: "read", content: [], isError: false, timestamp },
	});
	const timings = new ActivityTimings();
	timings.load(branch);
	let now = 11_000;
	const f = fixture(timings, () => now, styledTheme);
	f.projection.beginTurn();
	f.chat.addChild(new AssistantMessageComponent(source));
	const tools: ToolExecutionComponent[] = [];
	for (const id of ["one", "two"]) {
		const tool = new ToolExecutionComponent("read", id, {}, undefined, undefined, f.tui, "/tmp");
		tool.markExecutionStarted();
		f.chat.addChild(tool);
		tools.push(tool);
	}
	expect(lines(f.document).join("\n")).toContain("Working for 10s · Checking index baseline · 3 steps");
	now = 66_000;
	expect(lines(f.document).join("\n")).toContain("Working for 1m 5s · Checking index baseline · 3 steps");
	branch.push(result("one", 101_000), result("two", 417_000));
	timings.load(branch);
	for (const tool of tools) tool.updateResult({ content: [], isError: false });
	now = 418_000;
	// The live timer includes gaps between completed tools and the next request.
	expect(lines(f.document).join("\n")).toContain("Working for 6m 57s · Checking index baseline · 3 steps");
	f.projection.finishTurn();
	expect(lines(f.document).join("\n")).toContain("Worked for 6m 56s · Checking index baseline · 3 steps");
	f.unmount();
	// Rebuilding native components must use saved timestamps, not their mount time.
	timings.load(branch);
	const reloaded = fixture(timings, () => 999_000, styledTheme);
	reloaded.chat.addChild(new AssistantMessageComponent(source));
	for (const id of ["one", "two"]) {
		const tool = new ToolExecutionComponent("read", id, {}, undefined, undefined, reloaded.tui, "/tmp");
		tool.updateResult({ content: [], isError: false });
		reloaded.chat.addChild(tool);
	}
	const rows = reloaded.document.render(100);
	const row = rows.find((line) => Bun.stripANSI(line).includes("Worked for"))!;
	expect(Bun.stripANSI(row)).toStartWith("  Worked for 6m 56s · Checking index baseline · 3 steps");
	expect(row).toStartWith(tuiTheme(styledTheme).fgAnsi("text.muted"));
	expect(row).toContain(styledTheme.italic("Checking index baseline"));
	expect(row).toContain("\x1b[4:4m");
	expect(visibleWidth(row)).toBe(100);
	const padding = " ".repeat(100 - visibleWidth(Bun.stripANSI(row).trimEnd()));
	expect(padding.length).toBeGreaterThan(20);
	expect(row).toContain(tuiTheme(styledTheme).fg("text.muted", padding));
	expect(row).toContain(`${padding}\x1b[39m\x1b[24m`);
	expect(row).not.toContain("\x1b[1m");
	expect(Bun.stripANSI(row)).not.toMatch(/[•●]/u);
	for (const width of [1, 2, 8, 40])
		expect(reloaded.document.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
	reloaded.unmount();
	timings.load([]);
	expect(
		timings.elapsed(
			[
				{
					kind: "thinking",
					key: {},
					component: new Container(),
					summary: "Old",
					timestamp: 1_000,
					running: false,
					failed: false,
				},
			],
			999_000,
		),
	).toBeUndefined();
});
