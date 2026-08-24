import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { ToolOutput } from "../src/tool/output.ts";

const theme = {
	name: "output-test",
	getColorMode: () => "truecolor",
	getFgAnsi: () => "\x1b[38;2;180;180;180m",
	getBgAnsi: () => "\x1b[48;2;20;20;20m",
} as never as Theme;

describe("ToolOutput", () => {
	test("makes append and replace explicit while caching exact revisions", () => {
		const output = new ToolOutput({ theme, initial: { text: "one", revision: 1 } });
		const first = output.render(20);
		expect(output.render(20)).toBe(first);
		output.append(" two", 2);
		expect(stripTerminalSequences(output.render(20).join("\n"))).toContain("one two");
		output.replace({ text: "replacement", revision: 3 });
		expect(stripTerminalSequences(output.render(20).join("\n"))).toBe("replacement");
	});

	test("applies caller-owned bounded viewports without breaking ANSI width", () => {
		const text = Array.from({ length: 100 }, (_, index) => `\x1b[3${index % 8}mline-${index}-long\x1b[39m`).join("\n");
		const output = new ToolOutput({
			theme,
			initial: { text, revision: 1 },
			viewport: { maxRows: 5 },
		});
		const collapsed = output.render(8);
		expect(collapsed).toHaveLength(5);
		expect(collapsed.every((line) => visibleWidth(line) <= 8)).toBe(true);
		output.setViewport({ maxRows: 12, selection: "tail" });
		expect(output.render(8)).toHaveLength(12);
	});

	test("keeps an exact head-tail omission row inside the bounded output", () => {
		const output = new ToolOutput({
			theme,
			initial: { text: "line 0\nline 1\nline 2\nline 3\nline 4\nline 5", revision: 1 },
			viewport: { maxRows: 4, selection: "head-tail" },
		});

		expect(stripTerminalSequences(output.render(20).join("\n"))).toBe("line 0\n… 3 rows omitted …\nline 4\nline 5");
		expect(output.getOmissionRow()).toBe(1);
	});

	test("bounds retained append content under stress", () => {
		const output = new ToolOutput({ theme, maxCharacters: 128, viewport: { maxRows: 20, selection: "tail" } });
		for (let revision = 1; revision <= 10_000; revision++) output.append(`${revision},`, revision);
		const rendered = stripTerminalSequences(output.render(80).join("\n"));
		expect(rendered).toContain("earlier characters discarded");
		expect(rendered.length).toBeLessThan(300);
	});

	test("keeps the retention marker inside a one-row viewport", () => {
		const output = new ToolOutput({
			theme,
			initial: { text: "discard this and retain the tail", revision: 1 },
			maxCharacters: 8,
			viewport: { maxRows: 1 },
		});

		const rendered = output.render(80);
		expect(rendered).toHaveLength(1);
		expect(stripTerminalSequences(rendered[0]!)).toContain("earlier characters discarded");
	});

	test("never retains the tail half of an ANSI control sequence", () => {
		const output = new ToolOutput({ theme, maxCharacters: 8, viewport: { maxRows: 20 } });
		output.append(`before\x1b[38;2;100;120;140mcolored\x1b[39m`, 1);
		const plain = stripTerminalSequences(output.render(80).join("\n"));
		expect(plain).not.toMatch(/\[\d+(?:;\d+)*m/);
	});

	test("preserves SGR styling but removes terminal side-effect controls", () => {
		const output = new ToolOutput({
			theme,
			initial: {
				text: "\x1b[31mred\x1b[0m\x1b]52;c;Y2xpcGJvYXJk\x07\x1bPpayload\x1b\\safe",
				revision: 1,
			},
		});
		const rendered = output.render(80).join("\n");
		expect(rendered).toContain("\x1b[31mred\x1b[0m");
		expect(rendered).not.toContain("]52");
		expect(rendered).not.toContain("payload");
		expect(stripTerminalSequences(rendered)).toBe("redsafe");
	});

	test("removes eight-bit OSC and DCS controls with their payloads", () => {
		const output = new ToolOutput({
			theme,
			initial: { text: "before\u009d52;c;secret\u0007middle\u0090device\u009cafter", revision: 1 },
		});
		expect(stripTerminalSequences(output.render(80).join("\n"))).toBe("beforemiddleafter");
	});

	test("carries split SGR sequences across cumulative snapshots", () => {
		const output = new ToolOutput({ theme });
		output.appendCumulative("\x1b[31", 1);
		expect(output.render(80)).toEqual([]);
		output.appendCumulative("\x1b[31mred", 2);
		const rendered = output.render(80).join("\n");
		expect(rendered).toContain("\x1b[31mred");
		expect(stripTerminalSequences(rendered)).toBe("red");
	});

	test("bounds unterminated terminal controls without leaking their payload", () => {
		const output = new ToolOutput({ theme, maxCharacters: 16 });
		output.append(`\x1b]52;c;${"secret".repeat(20_000)}`, 1);
		expect(output.render(80)).toEqual([]);
		output.append("\x07safe", 2);
		expect(stripTerminalSequences(output.render(80).join("\n"))).toBe("safe");
	});

	test("bounds unterminated CSI state even below its introducer width", () => {
		const output = new ToolOutput({ theme, maxCharacters: 1 });
		output.append(`\x1b[${"1".repeat(100_000)}`, 1);
		expect(output.render(80)).toEqual([]);
		output.append("msafe", 2);
		const rendered = stripTerminalSequences(output.render(80).join("\n"));
		expect(rendered).toEndWith("e");
		expect(rendered).not.toContain("1111");
	});

	test("bounds sanitization work before retaining large resumed output", () => {
		const source = "x".repeat(100_000);
		const output = new ToolOutput({ theme, initial: { text: source, revision: 0 }, maxCharacters: 1_000 });
		expect(stripTerminalSequences(output.render(80).join("\n"))).toContain("earlier characters discarded");
	});

	test("clips pathological single lines before wrapping", () => {
		const output = new ToolOutput({
			theme,
			initial: { text: "x".repeat(1_000_000), revision: 1 },
			maxCharacters: 1_000_000,
			viewport: { maxRows: 20 },
		});
		const rendered = stripTerminalSequences(output.render(1).join("\n"));

		expect(rendered).toContain("…");
		expect(output.render(1)).toHaveLength(20);
		expect(rendered.length).toBeLessThan(100);
	});

	test("normalizes non-finite retention limits and appends cumulative snapshots by delta", () => {
		const output = new ToolOutput({
			theme,
			maxCharacters: Number.POSITIVE_INFINITY,
			viewport: { maxRows: 4, selection: "tail" },
		});
		output.appendCumulative("one", 1);
		output.appendCumulative("one\ntwo", 2);
		expect(stripTerminalSequences(output.render(40).join("\n"))).toBe("one\ntwo");
		output.append("x".repeat(1_000_001), 3);
		expect(stripTerminalSequences(output.render(40)[0] ?? "")).toContain("earlier characters discarded");
	});
});
