import { expect, it } from "bun:test";

import { diagnoseNotebook, formatDiagnostics, type NotebookCodeCell, parseDiagnosticReport } from "./diagnostics.ts";

const CELL: NotebookCodeCell = {
	id: "cell-1",
	index: 0,
	source: 'const value = globalThis.value;\ntools.read({ path: "a" });\n',
};

function item(overrides: Record<string, unknown>): Record<string, unknown> {
	return {
		message: "Cannot find name 'tools'.",
		range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
		severity: 1,
		code: 2304,
		source: "deno-ts",
		...overrides,
	};
}

it("returns early without starting a process when there are no cells", async () => {
	const result = await diagnoseNotebook({ deno: "/nonexistent/deno", cwd: "/tmp", path: "/tmp/x.ipynb", cells: [] });
	expect(result.message).toContain("No code cells to diagnose");
	expect(result.details["cells"]).toBe(0);
});

it("drops a Cannot-find-name for a binding the runtime supplies", () => {
	const report = { items: [item({}), item({ message: "Cannot find name 'restored'." })] };
	expect(parseDiagnosticReport(report, CELL, new Set(["tools"]))).toEqual([
		expect.objectContaining({ message: "Cannot find name 'restored'." }),
	]);
});

it("drops an implicit-any index only for globalThis", () => {
	const globalIndex = item({
		code: 7017,
		message: "Element implicitly has an 'any' type.",
		range: { start: { line: 0, character: 25 }, end: { line: 0, character: 30 } },
	});
	expect(parseDiagnosticReport({ items: [globalIndex] }, CELL, new Set())).toEqual([]);

	const otherIndex = item({
		code: 7017,
		message: "Element implicitly has an 'any' type.",
		range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
	});
	expect(parseDiagnosticReport({ items: [otherIndex] }, CELL, new Set())).toHaveLength(1);
});

it("ignores a report that is not a diagnostic report", () => {
	for (const report of [undefined, null, [], { items: "no" }, { items: [null, 42, item({ range: undefined })] }]) {
		expect(parseDiagnosticReport(report, CELL, new Set())).toEqual([]);
	}
	expect(
		parseDiagnosticReport(
			{ items: [item({ range: { start: { line: -1, character: 0 }, end: { line: 0, character: 0 } } })] },
			CELL,
			new Set(),
		),
	).toEqual([]);
});

it("reports one-based positions and names the severity", () => {
	const [diagnostic] = parseDiagnosticReport({ items: [item({ severity: 2 })] }, CELL, new Set());
	expect(diagnostic).toEqual({
		cellId: "cell-1",
		cellIndex: 0,
		line: 2,
		column: 1,
		endLine: 2,
		endColumn: 6,
		severity: "warning",
		code: 2304,
		source: "deno-ts",
		message: "Cannot find name 'tools'.",
	});
});

it("truncates at the message budget and says how many were omitted", () => {
	const many = Array.from({ length: 400 }, (_, index) => ({
		cellId: "cell-1",
		cellIndex: 0,
		line: index + 1,
		column: 1,
		endLine: index + 1,
		endColumn: 2,
		severity: "error" as const,
		code: 2304,
		source: "deno-ts",
		message: "x".repeat(200),
	}));
	const result = formatDiagnostics("/tmp/x.ipynb", 1, many);
	expect(result.message.length).toBeLessThanOrEqual(16 * 1024);
	expect(result.message).toContain("additional diagnostics omitted");
	expect(result.details["omitted"] as number).toBeGreaterThan(0);
});

it("says so when nothing is wrong", () => {
	const result = formatDiagnostics("/tmp/x.ipynb", 3, []);
	expect(result.message).toBe("No Deno diagnostics in /tmp/x.ipynb (3 code cells)");
	expect(result.details["diagnostics"]).toEqual([]);
});
