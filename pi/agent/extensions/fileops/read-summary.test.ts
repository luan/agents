/**
 * The structural summary is the only read path that shows some of a file and
 * records a snapshot of all of it, which is exactly the shape that breaks
 * hashline. Two failures are possible and both are silent:
 *
 *   - marking an elided line observed lets an edit anchor to text the model
 *     never saw, which is the whole guarantee `unobservedAnchorWarning` exists
 *     to provide;
 *   - marking a displayed line unobserved makes every edit after a summary
 *     read fail, which reads as hashline being broken rather than as the
 *     summary being wrong.
 *
 * Neither shows up in a type check or in a smoke test of the tool, so the
 * partition between displayed and elided lines is asserted directly here.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import fileopsExtension from "./index.ts";

function registerTools(): Map<string, any> {
	process.env.PI_FILEOPS_EDIT_VARIANT = "hashline";
	const tools = new Map<string, any>();
	fileopsExtension({
		registerTool: (definition: any) => tools.set(definition.name, definition),
		registerCommand: () => {},
	} as any);
	return tools;
}

async function expectHashlineFailure(promise: Promise<any>, expected: RegExp): Promise<void> {
	const result = await promise;
	expect(result.details.status).toBe("failure");
	expect(result.details.error).toMatch(expected);
}

/** A file with enough long method bodies that the outline must elide some. */
function writeSummarizableFile(cwd: string): string {
	const lines: string[] = ["export class Sample {"];
	for (let index = 0; index < 12; index++) {
		lines.push(`\tmethod${index}(arg: number): number {`);
		lines.push("\t\tlet total = 0;");
		for (let step = 0; step < 8; step++) lines.push(`\t\ttotal += arg * ${step};`);
		lines.push("\t\treturn total;");
		lines.push("\t}");
		lines.push("");
	}
	lines.push("}");
	const path = join(cwd, "sample.ts");
	writeFileSync(path, `${lines.join("\n")}\n`);
	return path;
}

/**
 * A file far too large for a per-declaration outline to fit the read budget,
 * so the outline has to hide whole declarations to stay inside it.
 */
function writeLargeSummarizableFile(cwd: string): string {
	const lines: string[] = [];
	for (let index = 0; index < 300; index++) {
		lines.push(
			"/**",
			` * Compute the ${index}th total.`,
			" *",
			" * Wide enough that the comment itself folds.",
			" */",
		);
		lines.push(
			`export function compute${index}(`,
			"\tfirst: number,",
			"\tsecond: number,",
			"\tthird: number,",
			"): number {",
		);
		lines.push("\tlet total = 0;");
		for (let step = 0; step < 8; step++) lines.push(`\ttotal += first * ${step} + second;`);
		lines.push("\treturn total + third;", "}", "");
	}
	const path = join(cwd, "large.ts");
	writeFileSync(path, `${lines.join("\n")}\n`);
	return path;
}

function footerRanges(text: string): Array<[number, number]> {
	const listed = /Re-read only what you need, e\.g\. `[^`:]+:([0-9,-]+)`/.exec(text)?.[1];
	expect(listed).toBeDefined();
	return (listed ?? "").split(",").map((range) => {
		const [start, end] = range.split("-");
		return [Number(start), Number(end)] as [number, number];
	});
}

function displayedLineNumbers(text: string): number[] {
	return text
		.split("\n")
		.flatMap((line) => {
			const match = /^([1-9]\d*):/.exec(line);
			return match ? [Number(match[1])] : [];
		})
		.sort((left, right) => left - right);
}

function elidedSpans(text: string): Array<[number, number]> {
	const match = /elided in (\d+) spans/.exec(text);
	expect(match).not.toBeNull();
	const displayed = new Set(displayedLineNumbers(text));
	const spans: Array<[number, number]> = [];
	let start: number | undefined;
	const total = Number(/of (\d+) lines elided/.exec(text)?.[1] ?? 0);
	for (let line = 1; line <= total; line++) {
		if (displayed.has(line)) {
			if (start !== undefined) spans.push([start, line - 1]);
			start = undefined;
		} else start ??= line;
	}
	if (start !== undefined) spans.push([start, total]);
	return spans;
}

describe("structural summary read", () => {
	it("summarizes an unscoped read of parseable code and names recovery ranges", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-read-summary-"));
		writeSummarizableFile(cwd);
		const read = registerTools().get("read");

		const result = await read.execute("read", { path: "sample.ts" }, undefined, undefined, { cwd });
		const text = result.content[0].text;

		expect(result.details.summary.elidedLines).toBeGreaterThan(0);
		expect(text).toMatch(/^\[sample\.ts#[0-9A-F]{4}\]/);
		expect(text).toContain("Structural summary:");
		expect(text).toContain("Re-read only what you need, e.g. `sample.ts:");
		// Every method keeps its signature line; that is what makes the outline
		// worth returning instead of the file.
		for (let index = 0; index < 12; index++) expect(text).toContain(`method${index}(arg: number)`);
	});

	it("marks exactly the displayed rows observed, so elided lines stay unobserved", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-read-summary-authority-"));
		const path = writeSummarizableFile(cwd);
		const tools = registerTools();

		const result = await tools.get("read").execute("read", { path: "sample.ts" }, undefined, undefined, { cwd });
		const text = result.content[0].text;
		const header = text.split("\n")[0];
		const displayed = displayedLineNumbers(text);
		const totalLines = result.details.summary.totalLines;

		// Displayed and elided partition the file: no line is both, none is neither.
		const elided = new Set<number>();
		for (const [start, end] of elidedSpans(text)) for (let line = start; line <= end; line++) elided.add(line);
		expect(displayed.length + elided.size).toBe(totalLines);
		expect(displayed.some((line) => elided.has(line))).toBe(false);
		expect(result.details.summary.elidedLines).toBe(elided.size);

		// An anchor inside an elided body is refused, and the file is left alone.
		const before = readFileSync(path, "utf-8");
		const elidedTarget = [...elided][0];
		expect(elidedTarget).toBeDefined();
		await expectHashlineFailure(
			tools
				.get("edit")
				.execute(
					"call",
					{ input: `${header}\nPUT ${elidedTarget}..${elidedTarget}:\n+\t\tlet total = 99;\n` },
					undefined,
					undefined,
					{ cwd },
				),
			/did not display/,
		);
		expect(readFileSync(path, "utf-8")).toBe(before);

		// An anchor on a displayed line is authorized against the same snapshot.
		const displayedTarget = Number(/^(\d+):\tmethod3\(/m.exec(text)?.[1]);
		expect(displayed).toContain(displayedTarget);
		await tools.get("edit").execute(
			"call",
			{
				input: `${header}\nPUT ${displayedTarget}..${displayedTarget}:\n+\trenamed3(arg: number): number {\n`,
			},
			undefined,
			undefined,
			{ cwd },
		);
		expect(readFileSync(path, "utf-8")).toContain("renamed3(arg: number)");
	});

	it("collapses a large file into the read budget without losing the partition or the ranges", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-read-summary-large-"));
		const path = writeLargeSummarizableFile(cwd);
		const tools = registerTools();

		const result = await tools.get("read").execute("read", { path: "large.ts" }, undefined, undefined, { cwd });
		const text = result.content[0].text;

		// The outline of a 6,300-line file has to fit `TOOL_TOKEN_BUDGETS.read`,
		// which is 6,000. Bounding it in lines is what let it reach ~7,700 and get
		// middle-truncated — the failure this whole path exists to avoid.
		expect(Math.ceil(Buffer.byteLength(text, "utf8") / 4)).toBeLessThan(4_500);
		expect(result.details.outputBounded).toBeFalsy();
		expect(text).toContain("300 functions");
		expect(text).toContain("(300 exported)");

		// Whole declarations are hidden at this size, so the partition and the
		// recovery ranges are the only things holding the guarantee together.
		const displayed = displayedLineNumbers(text);
		const elided = new Set<number>();
		for (const [start, end] of elidedSpans(text)) for (let line = start; line <= end; line++) elided.add(line);
		expect(displayed.length + elided.size).toBe(result.details.summary.totalLines);
		expect(displayed.some((line) => elided.has(line))).toBe(false);
		expect(result.details.summary.elidedLines).toBe(elided.size);
		expect(elidedSpans(text).slice(0, 6)).toEqual(footerRanges(text));

		// The snapshot authorizes exactly what was shown, at any collapse level.
		const header = text.split("\n")[0];
		const before = readFileSync(path, "utf-8");
		await expectHashlineFailure(
			tools
				.get("edit")
				.execute(
					"call",
					{ input: `${header}\nPUT ${[...elided][0]}..${[...elided][0]}:\n+// hidden\n` },
					undefined,
					undefined,
					{ cwd },
				),
			/did not display/,
		);
		expect(readFileSync(path, "utf-8")).toBe(before);

		const displayedTarget = Number(/^(\d+):export function compute(\d+)\($/m.exec(text)?.[1]);
		expect(displayed).toContain(displayedTarget);
		await tools
			.get("edit")
			.execute(
				"call",
				{ input: `${header}\nPUT ${displayedTarget}..${displayedTarget}:\n+export function renamed(\n` },
				undefined,
				undefined,
				{ cwd },
			);
		expect(readFileSync(path, "utf-8")).toContain("export function renamed(");
	});

	it("keeps a small file verbatim so every line stays editable", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-read-summary-small-"));
		writeFileSync(join(cwd, "small.ts"), "export function tiny() {\n\treturn 1;\n}\n");
		const tools = registerTools();

		const result = await tools.get("read").execute("read", { path: "small.ts" }, undefined, undefined, { cwd });
		const text = result.content[0].text;
		expect(text).not.toContain("Structural summary:");
		const header = text.split("\n")[0];

		await tools
			.get("edit")
			.execute("call", { input: `${header}\nPUT 2..2:\n+\treturn 2;\n` }, undefined, undefined, { cwd });
		expect(readFileSync(join(cwd, "small.ts"), "utf-8")).toBe("export function tiny() {\n\treturn 2;\n}\n");
	});
});
