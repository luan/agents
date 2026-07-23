import { expect, test } from "bun:test";
import { formatAgentModelInfo } from "./agent-widget";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

test("shows the subagent model and thinking effort", () => {
	expect(formatAgentModelInfo({ modelName: "GPT-5.6 Luna", thinkingLevel: "medium" }, theme)).toBe(
		"GPT-5.6 Luna · effort medium",
	);
});
