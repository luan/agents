import { beforeAll, describe, expect, test } from "bun:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { type RgbColor, xtermColor } from "../src/color/palette.ts";
import {
	parseBackgroundAnsi,
	type TuiBackgroundPaint,
	type TuiColor,
	type TuiForegroundPaint,
	type TuiTheme,
	tuiTheme,
} from "../src/color/theme.ts";
import { createUnifiedDiffModel, parseUnifiedDiff, renderUnifiedDiff, UnifiedDiffView } from "../src/diff/index.ts";
import { whenSyntaxReady } from "../src/syntax.ts";
import { terminalColorsRegistry } from "../src/terminal-colors.ts";

beforeAll(async () => {
	await new Promise<void>((resolve) => whenSyntaxReady(resolve));
});

function recordingTheme(name: string): TuiTheme {
	const colors = tuiTheme({ name, getColorMode: () => "truecolor" } as never);
	return {
		color: colors.color,
		mixForeground: colors.mixForeground,
		fg: (paint: TuiForegroundPaint, text: string) =>
			`\x1b]1337;${name}:fg:${typeof paint === "string" ? paint : "hue" in paint ? paint.hue : "color"}\x07${text}\x1b[39m`,
		bg: (paint: TuiBackgroundPaint, text: string) =>
			`<${name}:bg:${typeof paint === "string" ? paint : "color"}>${text}</bg>`,
		fgAnsi: (paint: TuiForegroundPaint) =>
			`\x1b]1337;${name}:fg:${typeof paint === "string" ? paint : "hue" in paint ? paint.hue : "color"}\x07`,
		bgAnsi: (paint: TuiBackgroundPaint) => `\x1b]1337;${name}:bg:${typeof paint === "string" ? paint : "color"}\x07`,
		contrastBackground: colors.contrastBackground,
	};
}

function contrastRecordingTheme(name: string): { theme: TuiTheme; contrastLabels: readonly string[] } {
	const base = recordingTheme(name);
	const labels = new WeakMap<object, string>();
	const contrastLabels: string[] = [];
	let nextUnknown = 0;
	const labelFor = (color: TuiColor): string => {
		const existing = labels.get(color);
		if (existing) return existing;
		const label = `unknown-${nextUnknown++}`;
		labels.set(color, label);
		return label;
	};
	const theme: TuiTheme = {
		...base,
		color(token) {
			const color = base.color(token);
			labels.set(color, `semantic:${typeof token === "string" ? token : token.hue}`);
			return color;
		},
		contrastBackground(color) {
			const contrast = base.contrastBackground(color);
			const label = `contrast:${contrastLabels.length}`;
			contrastLabels.push(label);
			labels.set(contrast, label);
			return contrast;
		},
		fg(color, text) {
			const handle = typeof color !== "string" && !("hue" in color);
			return `\x1b]1337;${name}:${handle ? "fg:color" : "fg"}:${typeof color === "string" ? color : "hue" in color ? color.hue : labelFor(color)}\x07${text}\x1b[39m`;
		},
		fgAnsi(token) {
			return `\x1b]1337;${name}:fg:${typeof token === "string" ? token : "hue" in token ? token.hue : labelFor(token)}\x07`;
		},
	};
	return { theme, contrastLabels };
}

function ansiRgb(ansi: string, foreground: boolean): RgbColor | undefined {
	const prefix = foreground ? 38 : 48;
	const match = new RegExp(`\\x1b\\[${prefix};(?:2;(\\d+);(\\d+);(\\d+)|5;(\\d+))m`, "u").exec(ansi);
	if (!match) return undefined;
	return match[1] === undefined
		? xtermColor(Number(match[4]))
		: { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) };
}

function contrastRatio(left: RgbColor, right: RgbColor): number {
	const channel = (value: number): number => {
		const normalized = value / 255;
		return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
	};
	const luminance = (color: RgbColor): number =>
		channel(color.r) * 0.2126 + channel(color.g) * 0.7152 + channel(color.b) * 0.0722;
	const [lighter, darker] = [luminance(left), luminance(right)].sort((a, b) => b - a);
	return (lighter + 0.05) / (darker + 0.05);
}

const SIMPLE = [
	"diff --git a/café.ts b/café.ts",
	"--- a/café.ts",
	"+++ b/café.ts",
	"@@ -10,2 +10,2 @@ export function x()",
	"-const value = 'old';",
	"+const value = 'new';",
	" unchanged 🦀",
].join("\n");

describe("unified diff parser", () => {
	test("parses files, hunks, line numbers, stable refs, and aggregate stats", () => {
		const model = parseUnifiedDiff(
			`${SIMPLE}\ndiff --git a/old b/new\n--- /dev/null\n+++ b/new\n@@ -0,0 +1 @@\n+created`,
		);

		expect(model.files).toHaveLength(2);
		expect(model.files[0]).toMatchObject({ oldPath: "café.ts", newPath: "café.ts", additions: 1, removals: 1 });
		expect(model.files[1]).toMatchObject({ oldPath: undefined, newPath: "new", additions: 1, removals: 0 });
		expect(model).toMatchObject({ additions: 2, removals: 1, truncated: false });
		expect(model.files[0]!.hunks[0]!.lines.map((line) => [line.ref, line.oldLine, line.newLine])).toEqual([
			["f0:h0:l0", 10, undefined],
			["f0:h0:l1", undefined, 10],
			["f0:h0:l2", 11, 11],
		]);
	});

	test("keeps multiple plain unified diff files separate", () => {
		const model = parseUnifiedDiff(
			[
				"diff -ruN old/one.ts new/one.ts",
				"--- old/one.ts",
				"+++ new/one.ts",
				"@@ -1 +1 @@",
				"-old one",
				"+new one",
				"diff -ruN old/two.ts new/two.ts",
				"--- old/two.ts",
				"+++ new/two.ts",
				"@@ -1 +1 @@",
				"-old two",
				"+new two",
			].join("\n"),
		);

		expect(model.files).toHaveLength(2);
		expect(model.files.map((file) => [file.oldPath, file.newPath, file.additions, file.removals])).toEqual([
			["old/one.ts", "new/one.ts", 1, 1],
			["old/two.ts", "new/two.ts", 1, 1],
		]);
	});

	test("resets plain unified file sides before an added file", () => {
		const model = parseUnifiedDiff(
			[
				"--- old/one.ts",
				"+++ new/one.ts",
				"@@ -1 +1 @@",
				"-old one",
				"+new one",
				"--- /dev/null",
				"+++ new/two.ts",
				"@@ -0,0 +1 @@",
				"+created",
			].join("\n"),
		);

		expect(model.files.map((file) => [file.oldPath, file.newPath])).toEqual([
			["old/one.ts", "new/one.ts"],
			[undefined, "new/two.ts"],
		]);
	});

	test("keeps file sides aligned after a headerless Git diff", () => {
		const model = parseUnifiedDiff(
			[
				"diff --git a/image.png b/image.png",
				"new file mode 100644",
				"Binary files /dev/null and b/image.png differ",
				"diff --git a/two.ts b/two.ts",
				"new file mode 100644",
				"--- /dev/null",
				"+++ b/two.ts",
				"@@ -0,0 +1 @@",
				"+created",
			].join("\n"),
		);

		expect(model.files.map((file) => [file.oldPath, file.newPath])).toEqual([
			[undefined, "image.png"],
			[undefined, "two.ts"],
		]);
	});

	test("keeps the valid Pierre prefix of a malformed streaming hunk", () => {
		const partial = parseUnifiedDiff("--- a/x\n+++ b/x\n@@ -1 +1,2 @@\n-old\n+new\nunfinished");
		const lines = partial.files[0]!.hunks[0]!.lines;
		expect(lines.map((line) => line.kind)).toEqual(["removed", "added"]);
	});

	test("keeps header-looking removed and added lines inside active hunks", () => {
		const model = parseUnifiedDiff("--- a/x\n+++ b/x\n@@ -1 +1 @@\n--- old heading\n+++ new heading");
		expect(model.files[0]!.hunks[0]!.lines.map((line) => [line.kind, line.text])).toEqual([
			["removed", "-- old heading"],
			["added", "++ new heading"],
		]);
	});

	test("keeps /dev/null side markers scoped to file headers", () => {
		const model = parseUnifiedDiff(
			[
				"diff --git a/created.txt b/created.txt",
				"--- /dev/null\t1970-01-01 00:00:00 +0000",
				"+++ b/created.txt",
				"@@ -1 +1 @@",
				"--- /dev/null",
				"+++ /dev/null",
				"diff --git a/removed.txt b/removed.txt",
				"--- a/removed.txt",
				"+++ /dev/null",
				"@@ -1 +1 @@",
				"-old",
				"+new",
			].join("\n"),
		);

		expect(model.files.map((file) => [file.oldPath, file.newPath])).toEqual([
			[undefined, "created.txt"],
			["removed.txt", undefined],
		]);
	});

	test("leaves unsupported range-free patches empty and accepts structured rows", () => {
		const parsed = parseUnifiedDiff("--- a/x\n+++ b/x\n@@\n-old\n+new");
		expect(parsed.files[0]?.hunks).toEqual([]);
		const structured = createUnifiedDiffModel(
			[
				{
					newPath: "x",
					hunks: [
						{
							rows: [
								{ kind: "removed", text: "old" },
								{ kind: "added", text: "new" },
							],
						},
					],
				},
			],
			"patch-action-7",
		);
		expect(structured).toMatchObject({ additions: 1, removals: 1 });
		expect(structured.revision).not.toContain("patch-action-7");
		expect(structured.files[0]!.hunks[0]!.oldStart).toBeUndefined();
	});

	test("converts structured files without losing headers, line numbers, or row kinds", () => {
		const model = createUnifiedDiffModel([
			{
				newPath: "created.ts",
				hunks: [
					{
						header: "@@ -0,0 +1,2 @@",
						oldStart: 0,
						oldCount: 0,
						newStart: 1,
						newCount: 2,
						rows: [
							{ kind: "added", text: "const created = true;", newLine: 1 },
							{ kind: "metadata", text: "\\ No newline at end of file" },
						],
					},
				],
			},
			{
				oldPath: "removed.ts",
				headerLines: ["file deleted"],
				hunks: [],
			},
		]);

		expect(model.files.map((file) => [file.ref, file.oldPath, file.newPath, file.headerLines])).toEqual([
			["f0", undefined, "created.ts", ["--- /dev/null", "+++ b/created.ts"]],
			["f1", "removed.ts", undefined, ["file deleted"]],
		]);
		expect(model.files[0]!.hunks[0]!.lines.map((line) => [line.ref, line.kind, line.text, line.newLine])).toEqual([
			["f0:h0:l0", "added", "const created = true;", 1],
			["f0:h0:l1", "metadata", "\\ No newline at end of file", undefined],
		]);
		expect(model.files[0]!.hunks[0]).toMatchObject({
			header: "@@ -0,0 +1,2 @@",
			oldStart: 0,
			oldCount: 0,
			newStart: 1,
			newCount: 2,
		});
		expect(model).toMatchObject({ additions: 1, removals: 0, truncated: false });
	});

	test("derives omitted structured ranges from Pierre's hunk header", () => {
		const model = createUnifiedDiffModel([
			{
				newPath: "changed.ts",
				hunks: [
					{
						header: "@@ -77,14 +81,2 @@ context",
						rows: [
							{ kind: "removed", text: "old" },
							{ kind: "added", text: "new" },
						],
					},
				],
			},
		]);

		expect(model.files[0]?.hunks[0]).toMatchObject({ oldStart: 77, oldCount: 14, newStart: 81, newCount: 2 });
		expect(model.files[0]?.hunks[0]?.lines.map((line) => [line.oldLine, line.newLine])).toEqual([
			[77, undefined],
			[undefined, 81],
		]);
	});

	test("bounds structured conversion at file, character, and row limits", () => {
		const model = createUnifiedDiffModel(
			[
				{
					newPath: "first.ts",
					hunks: [{ rows: [{ kind: "added", text: "a".repeat(100) }] }],
				},
				{ newPath: "second.ts", hunks: [{ rows: [{ kind: "added", text: "unseen" }] }] },
			],
			{ maxCharacters: 80, maxRows: 5 },
		);

		expect(model.truncated).toBe(true);
		expect(model.sourceRows).toBeLessThanOrEqual(5);
		expect(model.files.length).toBeLessThan(2);
		expect(model.files.flatMap((file) => file.hunks.flatMap((hunk) => hunk.lines)).length).toBeLessThan(2);
	});

	test("does not report internal path and header caps as global truncation", () => {
		const model = createUnifiedDiffModel([
			{
				newPath: "p".repeat(4_097),
				headerLines: ["h".repeat(16_385), "later header"],
				hunks: [{ rows: [{ kind: "added", text: "kept" }] }],
			},
		]);

		expect(model.truncated).toBe(false);
		expect(model.files[0]?.newPath).toHaveLength(4_096);
		expect(model.files[0]?.headerLines[0]).toHaveLength(16_384);
		expect(model.files[0]?.headerLines[1]).toBe("later header");
		expect(model.files[0]?.hunks[0]?.lines[0]?.text).toBe("kept");
	});

	test("applies character and row escape hatches and reuses parsed models", () => {
		const source = `${SIMPLE}\n${" context\n".repeat(100)}`;
		const first = parseUnifiedDiff(source, { maxCharacters: 200, maxRows: 6 });
		const second = parseUnifiedDiff(source, { maxCharacters: 200, maxRows: 6 });
		expect(first).toBe(second);
		expect(first.truncated).toBe(true);
		expect(first.sourceRows).toBe(6);
	});

	test("bounds structured models and hashes caller revisions", () => {
		const model = createUnifiedDiffModel(
			[{ newPath: "huge", hunks: [{ rows: [{ kind: "added", text: "x".repeat(100_000) }] }] }],
			{ revision: "secret-raw-revision", maxCharacters: 128, maxRows: 2 },
		);

		expect(model.truncated).toBe(true);
		expect(model.sourceRows).toBeLessThanOrEqual(2);
		expect(model.revision).not.toContain("secret-raw-revision");
	});

	test("charges structured paths to the hard character budget", () => {
		const model = createUnifiedDiffModel([{ oldPath: "a".repeat(8_000), newPath: "b".repeat(8_000), hunks: [] }], {
			maxCharacters: 16,
		});

		expect((model.files[0]?.oldPath?.length ?? 0) + (model.files[0]?.newPath?.length ?? 0)).toBeLessThanOrEqual(16);
		expect(model.truncated).toBe(true);
	});

	test("bounds structured files even when every file is empty", () => {
		const files = Array.from({ length: 10_000 }, (_, index) => ({ newPath: `file-${index}`, hunks: [] }));
		const model = createUnifiedDiffModel(files, { maxRows: 20_000, maxCharacters: 1_000_000 });
		expect(model.files.length).toBeLessThan(files.length);
		expect(model.truncated).toBe(true);
	});

	test("does not count a final newline as an extra truncated row", () => {
		const model = parseUnifiedDiff("--- a/x\n+++ b/x\n", { maxRows: 2 });
		expect(model.sourceRows).toBe(2);
		expect(model.truncated).toBe(false);
	});
});

describe("unified diff rendering", () => {
	test("uses semantic full-row paint and intraline emphasis", () => {
		const rendered = renderUnifiedDiff(parseUnifiedDiff(SIMPLE), {
			width: 40,
			theme: recordingTheme("dark"),
			surface: "surface.raised",
		});
		const output = rendered.lines.join("\n");
		expect(output).toContain("dark:bg:diff.removed");
		expect(output).toContain("dark:bg:diff.added");
		expect(output).toContain("dark:bg:diff.removedGutter");
		expect(output).toContain("dark:bg:diff.addedGutter");
		expect(output).toContain("dark:bg:diff.removedEmphasis");
		expect(output).toContain("dark:bg:diff.addedEmphasis");
		expect(output).toContain("dark:bg:diff.hunk");
		expect(output).toContain("dark:bg:diff.hunkGutter");
		expect(output).toContain("dark:fg:gray");
		expect(output).toContain("dark:fg:red");
		expect(output).toContain("dark:fg:text.primary");
		expect(output).toContain("dark:bg:surface.raised");
		expect(rendered.lines.every((line) => visibleWidth(line) === 40)).toBe(true);
	});

	test("uses semantic changed-line colors and contrasting hunk text", () => {
		const { theme, contrastLabels } = contrastRecordingTheme("contrast");
		const model = parseUnifiedDiff(
			["--- a/x", "+++ b/x", "@@ -1,4 +1,4 @@", "-old", "+new", " keep", " tail"].join("\n"),
		);
		const full = renderUnifiedDiff(model, { width: 60, theme });
		const hunk = full.lines.find((line) => stripTerminalSequences(line).includes("@@"));
		const removed = full.lines.find((line) => stripTerminalSequences(line).includes("old"));
		const added = full.lines.find((line) => stripTerminalSequences(line).includes("new"));
		expect(hunk).toContain("contrast:fg:color:contrast:");
		expect(hunk).not.toContain("contrast:fg:text.secondary");
		expect(removed).toContain("contrast:fg:negative");
		expect(added).toContain("contrast:fg:positive");

		const folded = renderUnifiedDiff(model, {
			width: 60,
			theme,
			viewport: { maxRows: 3, selection: "head-tail" },
		});
		const fold = folded.lines[folded.omissionRow ?? -1];
		expect(fold).toContain("contrast:fg:color:contrast:");
		expect(fold).not.toContain("contrast:fg:text.secondary");
		expect(contrastLabels).toHaveLength(4);
	});

	test("keeps null-side metadata in the model but omits it from presentation", () => {
		const model = parseUnifiedDiff("--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+created");
		expect(model.files[0]?.headerLines).toContain("--- /dev/null");
		const rendered = stripTerminalSequences(
			renderUnifiedDiff(model, { width: 40, theme: recordingTheme("new-file") }).lines.join("\n"),
		);
		expect(rendered).not.toContain("/dev/null");
		expect(rendered).toContain("+++ b/new.txt");
	});

	test("marks separate changed words instead of one broad changed range", () => {
		const model = parseUnifiedDiff(
			"--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-return oldValue + first;\n+return newValue + second;",
		);
		const output = renderUnifiedDiff(model, { width: 60, theme: recordingTheme("words") }).lines.join("\n");
		expect(output.match(/words:bg:diff\.removedEmphasis/gu)).toHaveLength(2);
		expect(output.match(/words:bg:diff\.addedEmphasis/gu)).toHaveLength(2);
	});

	test("uses Pierre's bounded change-block alignment when insertions differ", () => {
		const model = parseUnifiedDiff(
			"--- a/x.ts\n+++ b/x.ts\n@@ -1 +1,2 @@\n-return oldValue;\n+const trimmed = value.trim();\n+return trimmed;",
		);
		const output = renderUnifiedDiff(model, { width: 80, theme: recordingTheme("aligned") }).lines.join("\n");
		expect(output.match(/aligned:bg:diff\.removedEmphasis/gu)?.length ?? 0).toBeGreaterThan(0);
	});

	test("theme identity is part of the cache and repeated renders are stable", () => {
		const model = parseUnifiedDiff(SIMPLE);
		const dark = renderUnifiedDiff(model, { width: 32, theme: recordingTheme("dark") });
		const darkAgain = renderUnifiedDiff(model, { width: 32, theme: recordingTheme("dark") });
		const stableTheme = recordingTheme("stable");
		const stable = renderUnifiedDiff(model, { width: 32, theme: stableTheme });
		const stableAgain = renderUnifiedDiff(model, { width: 32, theme: stableTheme });
		const light = renderUnifiedDiff(model, { width: 32, theme: recordingTheme("light") });
		expect(darkAgain).not.toBe(dark);
		expect(stableAgain).toBe(stable);
		expect(light.lines[0]).not.toBe(dark.lines[0]);
	});

	test("wraps Unicode safely and never exceeds narrow terminal widths", () => {
		const model = parseUnifiedDiff(`${SIMPLE}\n+界界界界界\n+\x1b[31munsafe\x1b[0m\n+safe\u009d52;c;secret\u0007tail`);
		for (const width of [1, 2, 9, 17]) {
			const result = renderUnifiedDiff(model, {
				width,
				theme: recordingTheme("width"),
				viewport: { maxRows: 2_000 },
			});
			expect(result.lines.every((line) => visibleWidth(line) <= width)).toBe(true);
			expect(stripTerminalSequences(result.lines.join("\n"))).not.toContain("\x1b");
			expect(stripTerminalSequences(result.lines.join("\n"))).not.toContain("secret");
		}
	});

	test("head-tail keeps both ends while tail selection keeps the newest rows", () => {
		const body = Array.from({ length: 30 }, (_, index) => ` line ${index}`).join("\n");
		const model = parseUnifiedDiff(`--- a/x\n+++ b/x\n@@ -1,30 +1,30 @@\n${body}`);
		const headTail = renderUnifiedDiff(model, {
			width: 40,
			theme: recordingTheme("c"),
			viewport: { maxRows: 8, selection: "head-tail" },
		});
		const tail = renderUnifiedDiff(model, {
			width: 40,
			theme: recordingTheme("s"),
			viewport: { maxRows: 5, selection: "tail" },
		});
		const headTailText = stripTerminalSequences(headTail.lines.join("\n"));
		const tailText = stripTerminalSequences(tail.lines.join("\n"));
		expect(headTailText).toContain("line 0");
		expect(headTailText).toContain("line 29");
		expect(tailText).toContain("line 0"); // fold context keeps one omitted sample visible
		expect(tailText).toContain("line 29");
		expect(headTail.omittedRows).toBeGreaterThan(0);
	});

	test("uses the omitted hunk summary instead of a generic row count", () => {
		const model = parseUnifiedDiff(
			[
				"--- a/Cargo.toml",
				"+++ b/Cargo.toml",
				"@@ -1,2 +1,2 @@",
				" one",
				" two",
				'@@ -77,1 +77,1 @@ objc2-foundation = { version = "0.3", default-features = false, features = [',
				" keep",
			].join("\n"),
		);
		const rendered = renderUnifiedDiff(model, {
			width: 100,
			theme: recordingTheme("omitted-summary"),
			viewport: { maxRows: 1, selection: "tail" },
		});
		const text = stripTerminalSequences(rendered.lines[0] ?? "");
		expect(text).toContain("@@ -1,2 +1,2 @@");
		expect(text).toContain("one");
		expect(text).not.toContain("rows omitted");
	});

	test("bounds wrapped output and component viewport changes", () => {
		const model = parseUnifiedDiff(`--- a/x\n+++ b/x\n@@ -1 +1 @@\n-${"a".repeat(1_000)}\n+${"b".repeat(1_000)}`);
		const options = {
			model,
			theme: recordingTheme("bounded"),
			maxRenderedRows: 10,
			viewport: { maxRows: 100 },
		} as const;
		const view = new UnifiedDiffView(options);
		expect(view.render(12)).toHaveLength(10);
		view.setViewport({ maxRows: 5, selection: "tail" });
		expect(view.render(12)).toHaveLength(10);
		expect(renderUnifiedDiff(model, { ...options, width: 12 }).truncated).toBe(true);
	});

	test("sizes gutters from explicit structured line numbers", () => {
		const model = createUnifiedDiffModel([
			{
				newPath: "x.ts",
				hunks: [{ rows: [{ kind: "added", text: "value", newLine: 1_000 }] }],
			},
		]);
		const output = stripTerminalSequences(
			renderUnifiedDiff(model, { width: 30, theme: recordingTheme("numbers") }).lines.at(-1) ?? "",
		);
		expect(output).toContain("┃ 1000 value");
		expect(output).not.toContain("+");
	});

	test("uses distinct semantic rails and one relevant line number", () => {
		const model = parseUnifiedDiff("--- a/x\n+++ b/x\n@@ -16,2 +16,2 @@\n-old\n-stale\n+new\n+fresh");
		const rendered = renderUnifiedDiff(model, { width: 30, theme: contrastRecordingTheme("rail").theme }).lines.join(
			"\n",
		);
		const output = stripTerminalSequences(rendered);
		expect(output).toContain("┋ 16 old");
		expect(output).toContain("┋ 17 stale");
		expect(output).toContain("┃ 16 new");
		expect(output).toContain("┃ 17 fresh");
		expect(output).not.toContain(" 16  16");
		expect(rendered.match(/rail:fg:negative\x07┋/gu)).toHaveLength(2);
		expect(rendered.match(/rail:fg:positive\x07┃/gu)).toHaveLength(2);
		expect(rendered.match(/rail:fg:text\.primary\x0716/gu)).toHaveLength(2);
	});

	test("keeps changed line numbers readable on generated dark and light palettes", () => {
		const model = parseUnifiedDiff("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new");
		const hostTheme = (
			name: string,
			background: readonly [number, number, number],
			text: readonly [number, number, number],
		) =>
			({
				name,
				getColorMode: () => "truecolor",
				getFgAnsi: (token: string) => (token === "text" ? `\\x1b[38;2;${text.join(";")}m` : "\\x1b[39m"),
				getBgAnsi: () => `\\x1b[48;2;${background.join(";")}m`,
			}) as never;
		const registry = terminalColorsRegistry();
		registry.publish({ scheme: "dark", indexedPalette: "generated" });
		try {
			for (const theme of [
				hostTheme("generated-dark", [26, 27, 38], [203, 203, 203]),
				hostTheme("generated-light", [235, 238, 242], [25, 25, 25]),
				{ name: "harmonious", getColorMode: () => "truecolor" } as never,
			]) {
				const colors = tuiTheme(theme);
				const addedGutter = parseBackgroundAnsi(colors.bgAnsi("diff.addedGutter"));
				const removedGutter = parseBackgroundAnsi(colors.bgAnsi("diff.removedGutter"));
				const foreground = ansiRgb(colors.fgAnsi("text.primary"), true);
				expect(addedGutter).toBeDefined();
				expect(removedGutter).toBeDefined();
				expect(foreground).toBeDefined();
				expect(contrastRatio(addedGutter!, foreground!)).toBeGreaterThanOrEqual(4.5);
				expect(contrastRatio(removedGutter!, foreground!)).toBeGreaterThanOrEqual(4.5);
				const rendered = renderUnifiedDiff(model, { width: 40, theme: colors }).lines.join("\\n");
				expect(rendered).toContain(`${colors.bgAnsi("diff.addedGutter")}${colors.fgAnsi("positive")}`);
				expect(rendered).toContain(`${colors.fgAnsi("text.primary")}1`);
			}
		} finally {
			registry.publish(undefined);
		}
	});

	test("keeps the omission action centered with its fold glyph in the number lane", () => {
		const model = parseUnifiedDiff(
			["--- a/x", "+++ b/x", "@@ -1,20 +1,20 @@", ...Array.from({ length: 20 }, (_, index) => ` line ${index}`)].join(
				"\n",
			),
		);
		const rendered = renderUnifiedDiff(model, {
			width: 30,
			theme: recordingTheme("fold-lane"),
			viewport: { maxRows: 5, selection: "head-tail" },
		});
		expect(rendered.omissionRow).toBeGreaterThan(0);
		expect(rendered.omissionRow).toBeLessThan(rendered.lines.length - 1);
		const omission = stripTerminalSequences(rendered.lines[rendered.omissionRow!]!);
		expect(omission.slice(0, 5)).toBe("  ↕  ");
		expect(omission[0]).toBe(" ");
		expect(stripTerminalSequences(rendered.lines[2] ?? "").slice(0, 5)).toBe("  ≋  ");
	});

	test("hovers the omission action across its hunk gutter and body", () => {
		const model = parseUnifiedDiff(
			["--- a/x", "+++ b/x", "@@ -1,12 +1,12 @@", ...Array.from({ length: 12 }, (_, index) => ` line ${index}`)].join(
				"\n",
			),
		);
		const theme = recordingTheme("hover");
		const rest = renderUnifiedDiff(model, {
			width: 40,
			theme,
			viewport: { maxRows: 3, selection: "head-tail" },
		});
		const hovered = renderUnifiedDiff(model, {
			width: 40,
			theme,
			viewport: { maxRows: 3, selection: "head-tail" },
			omissionRowHovered: true,
		});
		const row = hovered.lines[hovered.omissionRow!]!;
		expect(row).toContain("hover:bg:diff.hunkGutterHover");
		expect(row).toContain("hover:bg:diff.hunkHover");
		expect(row).not.toBe(rest.lines[rest.omissionRow!]!);
	});

	test("expands monotonically across the omission threshold", () => {
		const model = parseUnifiedDiff(
			["--- a/x", "+++ b/x", "@@ -1,12 +1,12 @@", ...Array.from({ length: 12 }, (_, index) => ` line ${index}`)].join(
				"\n",
			),
		);
		const theme = recordingTheme("threshold");
		const full = renderUnifiedDiff(model, { width: 80, theme, viewport: { maxRows: 100 } });
		const exact = renderUnifiedDiff(model, {
			width: 80,
			theme,
			viewport: { maxRows: full.lines.length },
		});
		const preview = renderUnifiedDiff(model, {
			width: 80,
			theme,
			viewport: { maxRows: full.lines.length - 1, selection: "head-tail" },
		});
		expect(full.omissionRow).toBeUndefined();
		expect(exact.omissionRow).toBeUndefined();
		expect(preview.omissionRow).toBeDefined();
		expect(full.lines.length).toBeGreaterThanOrEqual(preview.lines.length);
	});
});
