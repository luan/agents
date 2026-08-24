import { beforeAll, describe, expect, test } from "bun:test";
import { highlightSyntaxBlock, whenSyntaxReady } from "../src/syntax.ts";

beforeAll(async () => {
	await new Promise<void>((resolve) => whenSyntaxReady(resolve));
});

describe("syntax highlighting", () => {
	test("adapts Shiki tokens into semantic spans without changing source text", () => {
		const source = "const Crab: usize = 42; // safe 🦀";
		const [spans] = highlightSyntaxBlock(source, "src/main.rs");

		expect(spans?.map((span) => span.text).join("")).toBe(source);
		expect(spans?.filter((span) => span.foreground !== undefined).length).toBeGreaterThan(1);
	});

	test("falls back to Shiki plain text for unsupported filenames", () => {
		const source = "ordinary words # remain ordinary";
		const [spans] = highlightSyntaxBlock(source, "notes.unknown-language");

		expect(spans?.map((span) => span.text).join("")).toBe(source);
		expect(spans?.some((span) => span.emphasized)).toBe(false);
	});

	test("keeps JSON punctuation and values on the shared syntax path", () => {
		const source = '{"value": true}';
		const [spans] = highlightSyntaxBlock(source, ".json");

		expect(spans?.map((span) => span.text).join("")).toBe(source);
		expect(spans?.some((span) => span.text.includes('"value"') && span.foreground !== undefined)).toBe(true);
		expect(spans?.some((span) => span.text.includes("true") && span.foreground !== undefined)).toBe(true);
	});

	test("uses shared shell spans for command syntax", () => {
		const source = `echo "$HOME" && printf '%s\\n' ok`;
		const [spans] = highlightSyntaxBlock(source, "script.sh");

		expect(spans?.map((span) => span.text).join("")).toBe(source);
		expect(spans?.filter((span) => span.foreground !== undefined).length).toBeGreaterThan(1);
	});

	test("keeps shell heredoc state across lines", () => {
		const source = "cat <<EOF\nhello world\nEOF\necho done";
		const lines = highlightSyntaxBlock(source, "script.sh");

		expect(lines.map((line) => line.map((span) => span.text).join("")).join("\n")).toBe(source);
		expect(lines[1]).toHaveLength(1);
		expect(lines[1]?.[0]?.foreground).toEqual(lines[2]?.[0]?.foreground);
	});

	test("keeps JavaScript template strings open across lines", () => {
		const source = "const message = `first\nsecond`;\nconsole.log(message);";
		const lines = highlightSyntaxBlock(source, "message.js");

		expect(lines.map((line) => line.map((span) => span.text).join("")).join("\n")).toBe(source);
		expect(lines[1]?.[0]?.text).toBe("second`");
		expect(lines[1]?.[0]?.foreground).toEqual(lines[0]?.at(-1)?.foreground);
	});
});
