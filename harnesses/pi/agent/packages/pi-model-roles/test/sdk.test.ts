import { expect, test } from "bun:test";
import { seedChildModelRole } from "../src/sdk.ts";

test("seeds a child session with the versioned model-role selection contract", () => {
	const entries: Array<{ customType: string; data: object }> = [];
	const entryId = seedChildModelRole(
		{
			appendCustomEntry(customType, data) {
				entries.push({ customType, data: data as object });
				return "selection-entry";
			},
		},
		"task",
	);

	expect(entryId).toBe("selection-entry");
	expect(entries).toEqual([
		{
			customType: "pi-model-roles/selection",
			data: { version: 1, role: "task" },
		},
	]);
});
