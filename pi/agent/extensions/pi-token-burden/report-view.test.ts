import { describe, expect, test } from "bun:test";
import { isBackKey, isForwardKey, isNavigateDownKey, isNavigateUpKey, showReport } from "./report-view";

describe("token burden vim key bindings", () => {
	test("maps vim movement keys to existing overlay actions", () => {
		expect(isNavigateUpKey("k")).toBe(true);
		expect(isNavigateDownKey("j")).toBe(true);
		expect(isForwardKey("l")).toBe(true);
		expect(isBackKey("h")).toBe(true);
		expect(isBackKey("q")).toBe(true);
	});

	test("does not treat unrelated printable keys as navigation", () => {
		expect(isNavigateUpKey("u")).toBe(false);
		expect(isNavigateDownKey("d")).toBe(false);
		expect(isForwardKey("f")).toBe(false);
		expect(isBackKey("b")).toBe(false);
	});
});

describe("token burden tools overlay", () => {
	test("toggles the selected active tool through the supplied handler", async () => {
		const calls: Array<{ toolName: string; enabled: boolean }> = [];
		let renderedAfterToggle = "";
		const ctx = {
			ui: {
				custom: async (factory: any) => {
					const component = factory({ requestRender() {} }, {}, {}, () => {});
					component.handleInput("l");
					component.handleInput(" ");
					renderedAfterToggle = component.render(80).join("\n");
				},
			},
		};

		await showReport(
			{
				totalChars: 20,
				totalTokens: 10,
				skills: [],
				sections: [
					{
						label: "Tool definitions (1 active, 2 total)",
						chars: 20,
						tokens: 10,
						tools: {
							active: [{ name: "bash", chars: 20, tokens: 10, content: '{"name":"bash"}' }],
							inactive: [{ name: "find", chars: 20, tokens: 10, content: '{"name":"find"}' }],
						},
						children: [{ label: "bash", chars: 20, tokens: 10, content: '{"name":"bash"}' }],
						drillable: true,
					} as any,
				],
			},
			100,
			ctx as any,
			[],
			undefined,
			undefined,
			(toolName, enabled) => {
				calls.push({ toolName, enabled });
				return { applied: true, activeToolNames: [] };
			},
		);

		expect(calls).toEqual([{ toolName: "bash", enabled: false }]);
		expect(renderedAfterToggle).toContain("Active (0)");
		expect(renderedAfterToggle).toContain("Inactive (2");
	});
});
