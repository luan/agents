import { describe, expect, test } from "bun:test";
import { createMosaicTools } from "./tools";

const MOSAIC_DESCRIPTION_BUDGET = 1_000;

describe("mosaic tool token budget", () => {
	test("keeps tool descriptions compact", () => {
		const budget = descriptionBudget(
			createMosaicTools({
				spawnAgent: async () => ({}),
				sendMessage: async () => ({}),
				waitAgent: async () => ({}),
				listAgents: async () => ({}),
				closeAgent: async () => ({}),
			}),
		);

		if (budget > MOSAIC_DESCRIPTION_BUDGET) {
			throw new Error(
				`Mosaic tool descriptions use ${budget} characters; budget is ${MOSAIC_DESCRIPTION_BUDGET}. ` +
					"Keep model-facing tool text compact and move guidance to docs.",
			);
		}
		expect(budget).toBeGreaterThan(0);
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
