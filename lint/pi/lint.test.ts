import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const biome = resolve(root, "node_modules/.bin/biome");
const config = resolve(import.meta.dir, "biome.test.json");

type LintResult = { exitCode: number; output: string };

async function lint(path: string | string[]): Promise<LintResult> {
	const paths = Array.isArray(path) ? path : [path];
	const process = Bun.spawn([biome, "lint", "--config-path", config, ...paths], {
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		process.exited,
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
	]);
	return { exitCode, output: `${stdout}${stderr}` };
}

let failureLint: Promise<LintResult> | undefined;

function lintFailures(): Promise<LintResult> {
	if (failureLint === undefined) {
		failureLint = lint(resolve(import.meta.dir, "fixtures/fail"));
	}
	return failureLint;
}

describe("Pi Biome policy", () => {
	test("accepts semantic pi-libtui colors", async () => {
		const result = await lint(resolve(import.meta.dir, "fixtures/pass/semantic.ts"));
		expect(result.exitCode, result.output).toBe(0);
	});

	const failures = {
		"direct-theme.ts": "Style extension-owned UI with tuiTheme(theme)",
		"aliased-theme.ts": "Style extension-owned UI with tuiTheme(theme)",
		"destructured-theme.ts": "Style extension-owned UI with tuiTheme(theme)",
		"fixed-color.ts": "Do not emit fixed terminal colors",
		"pi-color-helper.ts": "Use pi-libtui's semantic Markdown theme",
		"raw-component.ts": "Use the matching pi-libtui semantic input, editor, or selection component",
		"raw-editor.ts": "Use the matching pi-libtui semantic input, editor, or selection component",
		"raw-editor-theme.ts": "Use the matching pi-libtui semantic input, editor, or selection component",
		"raw-select-list.ts": "Use the matching pi-libtui semantic input, editor, or selection component",
		"root-tool-api.ts": "Import tool presentation APIs from pi-libtui/tool",
	} as const;

	for (const [fixture, diagnostic] of Object.entries(failures)) {
		test(`rejects ${fixture}`, async () => {
			const result = await lintFailures();
			expect(result.exitCode, result.output).not.toBe(0);
			expect(result.output).toContain(diagnostic);
		});
	}
});
