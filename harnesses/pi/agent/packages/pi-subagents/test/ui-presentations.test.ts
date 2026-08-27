import { afterEach, describe, expect, test } from "bun:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { configureTuiAppearance, DEFAULT_TUI_APPEARANCE, tuiTheme } from "pi-libtui";
import {
	formatAgentCost,
	formatAgentDuration,
	formatAgentTokens,
	renderAgentIdentity,
	renderAgentStatusMarker,
} from "../src/ui/agent-summary.ts";
import { createWaitToolPresentation, spawnToolPresentation } from "../src/ui/tool-presentations.ts";

const theme = {
	name: "subagents-test",
	bold: (text: string) => text,
	getColorMode: () => "truecolor",
	getFgAnsi: (token: string) =>
		({
			accent: "\x1b[38;2;80;160;240m",
			dim: "\x1b[38;2;70;80;110m",
			text: "\x1b[38;2;190;200;220m",
		})[token] ?? "\x1b[38;2;120;160;220m",
	getBgAnsi: () => "\x1b[48;2;20;24;30m",
} as never;

afterEach(() => configureTuiAppearance(DEFAULT_TUI_APPEARANCE));

describe("agent presentation formatting", () => {
	test("keeps small costs and large token counts useful", () => {
		expect(formatAgentCost(0.0042)).toBe("$0.0042");
		expect(formatAgentDuration(-50)).toBe("0.0s");
		expect(formatAgentTokens(1_250_000)).toBe("1.3m tokens");
	});

	test("keeps running agent shimmer text independent from markers", () => {
		const colors = tuiTheme(theme);
		configureTuiAppearance({ activityIndicator: "static", textEffect: "off", pulseEffect: "color" });
		expect(stripTerminalSequences(renderAgentStatusMarker(colors, "running", 0, 300))).toBe("●");
		configureTuiAppearance({ activityIndicator: "off", textEffect: "glow" });
		expect(renderAgentStatusMarker(colors, "running", 0, 300)).toBe("");
		const shimmeredIdentity = renderAgentIdentity(colors, "worker", "running", 0, 300);
		expect(stripTerminalSequences(shimmeredIdentity)).toBe("worker");
		expect(new Set(shimmeredIdentity.match(/\x1b\[38;[^m]+m/gu) ?? []).size).toBeGreaterThan(1);
		expect(shimmeredIdentity).toContain("\x1b[1m");
		configureTuiAppearance({ activityIndicator: "static", pulseEffect: "color" });
		expect(stripTerminalSequences(renderAgentIdentity(colors, "worker", "running", 0, 300))).toBe("● worker");
		configureTuiAppearance({ activityIndicator: "static", textEffect: "off" });
		expect(stripTerminalSequences(renderAgentStatusMarker(colors, "running", 0, 300))).toBe("●");
	});

	test("renders spawn details from the versioned result model", () => {
		const component = spawnToolPresentation.renderResult(
			{
				details: {
					version: 1,
					tool: "spawn_agent",
					status: "running",
					input: {
						taskName: "ui-port",
						message: "Port the UI",
						forkTurns: "all",
						modelRole: "worker",
					},
					agent: {
						id: "/root/ui-port",
						rootSessionId: "root",
						parentId: "/root",
						cwd: "/tmp",
						status: "running",
						description: "ui-port",
						startedAt: 1,
						durationMs: 2,
						toolUses: 0,
						cost: 0,
						tokenCount: 0,
						compactions: 0,
						transcriptAvailable: true,
					},
					truncation: { agentsOmitted: 0, textCharactersOmitted: 0 },
				},
			},
			{},
			theme,
			{ args: {}, toolCallId: "spawn-1", invalidate() {}, state: {} },
		);
		const text = stripTerminalSequences(component.render(100).join("\n"));
		expect(text).toContain("Spawned agent · ui-port");
		expect(text).toContain("role worker");
		expect(text).toContain("full history");
	});

	test("reuses and settles the live wait presentation", () => {
		const presentation = createWaitToolPresentation(() => "/root/ui-port");
		const context = { args: {}, toolCallId: "wait-1", invalidate() {}, state: {}, isPartial: true };
		const live = presentation.renderCall({}, theme, context);
		expect(stripTerminalSequences(live.render(100).join("\n"))).toContain("Waiting for agent · ui-port");
		const settledCall = presentation.renderCall({}, theme, { ...context, isPartial: false });
		expect(settledCall.render(100)).toEqual([]);
		const settled = presentation.renderResult(
			{
				details: {
					version: 1,
					tool: "wait_agent",
					status: "updated",
					input: { timeoutMs: 30_000 },
					update: { target: "/root/ui-port", agentStatus: "idle" },
					timing: { durationMs: 1_500 },
				},
			},
			{},
			theme,
			context,
		);
		expect(settled).toBe(live);
		const text = stripTerminalSequences(settled.render(100).join("\n"));
		expect(text).toContain("Waited for agent · ui-port");
		expect(text).toContain("2s");
		if ("dispose" in live && typeof live.dispose === "function") live.dispose();
	});
});
