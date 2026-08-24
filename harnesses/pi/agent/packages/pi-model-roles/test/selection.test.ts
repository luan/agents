import { expect, test } from "bun:test";
import { latestRoleSelection, MODEL_ROLE_SELECTION_ENTRY } from "../src/runtime/selection.ts";
import { customEntry } from "./fixtures.ts";

test("restores the latest versioned selection including a clear tombstone", () => {
	const entries = [
		customEntry(MODEL_ROLE_SELECTION_ENTRY, { version: 1, role: "tiny" }),
		customEntry("foreign", { version: 1, role: "task" }),
		customEntry(MODEL_ROLE_SELECTION_ENTRY, { version: 1, role: null }),
	];

	expect(latestRoleSelection(entries)).toBeNull();
});

test("ignores malformed and obsolete selection entries", () => {
	const entries = [
		customEntry(MODEL_ROLE_SELECTION_ENTRY, { version: 0, role: "tiny" }),
		customEntry(MODEL_ROLE_SELECTION_ENTRY, { version: 1, role: 4 }),
	];

	expect(latestRoleSelection(entries)).toBeUndefined();
});
