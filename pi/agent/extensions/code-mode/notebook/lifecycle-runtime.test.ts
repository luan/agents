import { expect, it } from "bun:test";

import {
	notebookDisposeSource,
	notebookReleaseSource,
	notebookStatusSource,
	parseNotebookRuntimeResult,
} from "./lifecycle-runtime.ts";

/** The kernel compiles the block as an async cell body. A syntax error there is invisible here. */
function parsesAsCell(source: string): boolean {
	new Function(`return (async () => ${source})`);
	return true;
}

it("generates a status block that parses and prints the marker", () => {
	const source = notebookStatusSource(["alpha", "beta"], "__MARK__");
	expect(parsesAsCell(source)).toBe(true);
	expect(source).toContain('console.log("__MARK__"');
	expect(source).toContain('name: "alpha"');
	expect(source).toContain("Deno.memoryUsage()");
});

it("generates a release block that deletes and a dispose block that does not", () => {
	const release = notebookReleaseSource(["alpha"], "__MARK__");
	const dispose = notebookDisposeSource(["alpha"], "__MARK__");
	expect(parsesAsCell(release)).toBe(true);
	expect(parsesAsCell(dispose)).toBe(true);
	expect(release).toContain('delete globalThis["alpha"]');
	expect(dispose).not.toContain("delete globalThis");
	for (const source of [release, dispose]) expect(source).toContain("Symbol.asyncDispose");
});

it("generates blocks that parse with no names", () => {
	for (const source of [
		notebookStatusSource([], "__MARK__"),
		notebookReleaseSource([], "__MARK__"),
		notebookDisposeSource([], "__MARK__"),
	]) {
		expect(parsesAsCell(source)).toBe(true);
	}
});

it("refuses a name that is not an identifier", () => {
	// `alpha; Deno.exit()` inlined as source would run. The builders are the boundary.
	for (const build of [notebookStatusSource, notebookReleaseSource, notebookDisposeSource]) {
		expect(() => build(["alpha; Deno.exit()"], "__MARK__")).toThrow(
			"Notebook binding name is not an identifier: alpha; Deno.exit()",
		);
	}
});

it("parses the first line after the marker and ignores cell output around it", () => {
	const result = parseNotebookRuntimeResult<{ released: string[] }>(
		{ status: "ok", output: 'noise\n__MARK__{"released":["alpha"]}\ntrailing' },
		"__MARK__",
	);
	expect(result.released).toEqual(["alpha"]);
});

it("reports a failed execution, a missing marker, and invalid JSON separately", () => {
	expect(() => parseNotebookRuntimeResult({ status: "error", errorText: "boom" }, "__MARK__")).toThrow("boom");
	expect(() => parseNotebookRuntimeResult({ status: "ok", output: "nothing" }, "__MARK__")).toThrow(
		"returned no result",
	);
	expect(() => parseNotebookRuntimeResult({ status: "ok", output: "__MARK__{oops" }, "__MARK__")).toThrow(
		"returned an invalid result",
	);
});
