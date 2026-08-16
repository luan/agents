import { expect, it } from "bun:test";

import {
	boundedReleaseDetails,
	formatNameList,
	formatRelease,
	formatStatus,
	largestUnpinned,
	NOTEBOOK_DETAILS_BUDGET,
	type NotebookStatusDetails,
	takeDetailValues,
	withinNameBudget,
} from "./lifecycle-result.ts";
import type { RetainedProjectBinding } from "./project-state-metadata.ts";

function retained(name: string, bytes: number, pinned = false): RetainedProjectBinding {
	return { name, kind: "value", bytes, updatedAt: new Date().toISOString(), pinned };
}

function statusDetails(overrides: Partial<NotebookStatusDetails> = {}): NotebookStatusDetails {
	return {
		state: "idle",
		userCells: 1,
		checkpoint: { dirty: false, projectGeneration: "gen-1", projectBindings: 0 },
		retainedBindings: 0,
		retainedBytes: 0,
		pinnedBindings: 0,
		pinned: [],
		omittedPinned: 0,
		largestUnpinned: [],
		...overrides,
	};
}

it("names a matched binding by its constructor and falls back to its type", () => {
	// `constructor` as a key would resolve through Object.prototype even when the kernel omits it.
	const message = formatStatus(
		statusDetails({
			query: "a*",
			matches: [
				{ name: "alpha", type: "object", kind: "value", globalProperty: true, constructorName: "Map" },
				{ name: "another", type: "object", kind: "value", globalProperty: true },
			],
			omittedMatches: 0,
		}),
	);
	expect(message).toContain("- alpha: value Map");
	expect(message).toContain("- another: value object");
});

it("reports no match rather than an empty list", () => {
	expect(formatStatus(statusDetails({ query: "z*", matches: [], omittedMatches: 0 }))).toContain("- none");
});

it("lists pinned and largest unpinned bindings only without a query", () => {
	const details = statusDetails({
		retainedBindings: 2,
		retainedBytes: 3072,
		pinnedBindings: 1,
		pinned: [retained("kept", 1024, true)],
		largestUnpinned: [retained("scratch", 2048)],
	});
	expect(formatStatus(details)).toContain("Pinned project bindings:");
	expect(formatStatus(details)).toContain("Largest unpinned retained bindings:");
	expect(formatStatus({ ...details, query: "a*", matches: [], omittedMatches: 0 })).not.toContain(
		"Pinned project bindings:",
	);
});

it("sorts the largest unpinned bindings and never lists a pinned one", () => {
	const bindings = [retained("small", 1), retained("pinned", 9_999, true), retained("big", 100)];
	expect(largestUnpinned(bindings).map(({ name }) => name)).toEqual(["big", "small"]);
});

it("cuts a name list at the budget and says how many it cut", () => {
	const names = Array.from({ length: 4000 }, (_, index) => `binding_${index}`);
	const shown = withinNameBudget(names);
	expect(shown.length).toBeLessThan(names.length);
	expect(formatNameList(names)).toContain(`and ${names.length - shown.length} more`);
});

it("stops taking detail values once the shared budget runs out", () => {
	const budget = { remaining: NOTEBOOK_DETAILS_BUDGET };
	const first = takeDetailValues(
		Array.from({ length: 500 }, () => retained("a".repeat(64), 1)),
		budget,
	);
	const second = takeDetailValues([retained("b", 1)], { remaining: 4 });
	expect(first.length).toBeLessThan(500);
	expect(second).toEqual([]);
});

it("reports counts alongside the truncated release lists", () => {
	const details = boundedReleaseDetails(
		{ released: ["a", "b"], disposed: ["a"], failures: [{ name: "b", reason: "locked" }] },
		["pinnedOne"],
		true,
		{ dirty: false },
	);
	expect(details["restarted"]).toBe(true);
	expect(details["releasedCount"]).toBe(2);
	expect(details["protected"]).toEqual(["pinnedOne"]);
	expect(details["failureCount"]).toBe(1);
});

it("says none when a release freed nothing, and names the restart", () => {
	expect(formatRelease({ released: [], disposed: [], failures: [] }, false)).toBe("Released notebook bindings: none");
	expect(formatRelease({ released: ["a"], disposed: [], failures: [] }, true)).toContain(
		"Kernel restarted to clear lexical bindings",
	);
});

it("truncates a message that exceeds the budget", () => {
	const message = formatStatus(
		statusDetails({
			query: "a*",
			matches: Array.from({ length: 2000 }, (_, index) => ({
				name: `binding_${index}`,
				type: "object",
				kind: "value" as const,
				globalProperty: true,
			})),
			omittedMatches: 0,
		}),
	);
	expect(message).toEndWith("[Notebook lifecycle output truncated; narrow query]");
	expect(message.length).toBeLessThanOrEqual(16 * 1024);
});
