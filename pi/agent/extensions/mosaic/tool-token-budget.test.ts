import { afterEach, describe, expect, test } from "bun:test";
import { createMosaicV2Tools, isMosaicV2ToolsEnabled } from "./v2-tools";

const MOSAIC_V2_DESCRIPTION_BUDGET = 1_000;

afterEach(() => {
	delete process.env.MOSAIC_V2_TOOLS;
});

describe("mosaic tool token budget", () => {
	test("keeps v2 tool descriptions compact", () => {
		const budget = descriptionBudget(
			createMosaicV2Tools({
				spawnAgent: async () => ({}),
				sendMessage: async () => ({}),
				waitAgent: async () => ({}),
				listAgents: async () => ({}),
				closeAgent: async () => ({}),
			}),
		);

		if (budget > MOSAIC_V2_DESCRIPTION_BUDGET) {
			throw new Error(
				`Mosaic v2 tool descriptions use ${budget} characters; budget is ${MOSAIC_V2_DESCRIPTION_BUDGET}. ` +
					"Keep model-facing tool text compact and move guidance to docs.",
			);
		}
		expect(budget).toBeGreaterThan(0);
	});

	test("removes v2 schema cost when the v2 tool gate is disabled", () => {
		process.env.MOSAIC_V2_TOOLS = "0";
		expect(isMosaicV2ToolsEnabled()).toBe(false);
	});
});

function descriptionBudget(value: unknown): number {
	if (!value || typeof value !== "object") return 0;
	if (Array.isArray(value)) return value.reduce((sum, item) => sum + descriptionBudget(item), 0);
	return Object.entries(value).reduce((sum, [key, item]) => {
		if (key === "description" && typeof item === "string") return sum + item.length;
		return sum + descriptionBudget(item);
	}, 0);
}
