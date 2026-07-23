import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { formatTaskResults, renderSubagentList, type TaskResult } from "./index";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

test("frames multiline subagent output as a single transcript preview row", () => {
	const component = renderSubagentList(
		{
			details: {
				agents: [
					{
						id: "agent-1",
						type: "explore",
						description: "Analyze skill consolidation",
						status: "completed",
						result: "**NO FILES CHANGED**\n\nWorking notes\n54m20s total",
					},
				],
			},
		},
		{},
		theme as never,
	);

	const lines = component.render(64);

	expect(lines).toHaveLength(4);
	expect(lines.every((line) => !line.includes("\n"))).toBe(true);
	expect(lines.every((line) => visibleWidth(line) === 64)).toBe(true);
	expect(lines.slice(1, -1).every((line) => line.startsWith("│ ") && line.endsWith(" │"))).toBe(true);
});

test("returns complete subagent output to the parent", () => {
	const result: TaskResult = {
		index: 0,
		id: "agent-1",
		agent: "librarian",
		description: "Research Chromium inbound sync",
		assignment: "Research the implementation.",
		status: "completed",
		output: "Finding one.\n\nFinding two with exact source paths.",
		durationMs: 1,
		toolUses: 0,
	};

	expect(formatTaskResults([result])).toBe(
		"## Research Chromium inbound sync (completed)\nFinding one.\n\nFinding two with exact source paths.",
	);
});
