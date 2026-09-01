import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { CommandTranscript } from "../src/ui/command-transcript.ts";

const theme = {
	name: "exec-ui-test",
	bold: (text: string) => text,
	getColorMode: () => "truecolor",
	getFgAnsi: (token: string) => (token === "text" ? "\x1b[38;2;240;240;240m" : "\x1b[38;2;100;140;200m"),
	getBgAnsi: () => "\x1b[48;2;30;34;40m",
} as never as Theme;

describe("exec command UI", () => {
	test("wraps shell commands without adding a branch glyph", () => {
		const source = "diff -u /dev/null .apply-patch-demo.ts || true; rm .apply-patch-demo.ts";
		const command = new CommandTranscript({
			theme,
			requestRender() {},
			view: {
				command: source,
				status: "succeeded",
				meta: ["11ms"],
				output: "first\nsecond",
			},
		});
		const rendered = command.render(32);

		expect(rendered.length).toBeGreaterThan(1);
		expect(rendered.every((line) => visibleWidth(line) <= 32)).toBe(true);
		const plain = stripTerminalSequences(rendered.join("\n"));
		expect(plain).toContain("$ diff -u /dev/null");
		expect(plain).toContain("|| true;");
		expect(plain.replace(/\s+/gu, "")).toContain(`$${source.replace(/\s+/gu, "")}`);
		expect(plain).toContain("· 11ms");
		expect(plain).toMatch(/\nfirst\s*\nsecond\s*$/u);
		expect(plain).not.toContain("└");
		command.dispose();
	});

	test("preserves explicit shell newlines as a command block", () => {
		const command = new CommandTranscript({
			theme,
			requestRender() {},
			view: {
				command:
					"rg --files -g '.mise.toml' -g 'mise.toml' -g '.tool-versions' -g 'rust-toolchain*' -g 'Cargo.toml' | head -100;  \nfor f in .mise.toml mise.toml .tool-versions; do\n\ttest -f \"$f\" && { echo ---$f; cat \"$f\"; };\ndone 2>/dev/null || true",
				status: "failed",
				meta: ["exit 1"],
			},
		});
		const plain = stripTerminalSequences(command.render(100).join("\n"));
		const lines = plain.split("\n");

		expect(lines.length).toBeGreaterThan(3);
		expect(lines.some((line) => line.includes("for f in .mise.toml"))).toBe(true);
		expect(lines.some((line) => line.includes('test -f "$f"'))).toBe(true);
		expect(lines.some((line) => line.includes("done 2>/dev/null || true"))).toBe(true);
		expect(plain).not.toContain("head -100; for f");
		command.dispose();
	});

	test("bounds large command headers to their visible rows", () => {
		const command = new CommandTranscript({
			theme,
			requestRender() {},
			view: {
				command: `printf \x1b]52;c;secret\x07${"🙂\u0301".repeat(50_000)}\nignored`,
				status: "running",
			},
		});
		const rendered = command.render(40);

		expect(rendered.length).toBeGreaterThan(1);
		expect(rendered.length).toBeLessThanOrEqual(6);
		expect(rendered.every((line) => visibleWidth(line) <= 40)).toBe(true);
		expect(stripTerminalSequences(rendered.at(-1) ?? "").trimEnd()).toEndWith("…");
		expect(rendered.join("\n")).not.toContain("\x1b]52");
		expect(rendered.join("\n")).not.toContain("secret");
		command.dispose();
	});

	test("replaces output when callers omit revisions", () => {
		const command = new CommandTranscript({
			theme,
			requestRender() {},
			view: { command: "printf foo", status: "running", output: "foo" },
		});
		expect(stripTerminalSequences(command.render(40).join("\n"))).toContain("foo");

		command.update({ command: "printf bar", status: "succeeded", output: "bar" });

		const rendered = stripTerminalSequences(command.render(40).join("\n"));
		expect(rendered).toContain("bar");
		expect(rendered).not.toContain("foo");
		command.dispose();
	});

	test("preserves PTY state only for an explicit cumulative tail", () => {
		const cumulative = `\x1b[31m${"red ".repeat(80)}`;
		const command = new CommandTranscript({
			theme,
			requestRender() {},
			view: {
				command: "progress",
				status: "running",
				tty: true,
				output: cumulative,
				outputUpdate: "cumulative",
			},
		});
		command.update({
			command: "progress",
			status: "running",
			tty: true,
			output: cumulative.slice(-100),
			outputUpdate: "cumulative-tail",
		});

		expect(command.render(40).join("\n")).toContain("31m");
		command.dispose();
	});
});
