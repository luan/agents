import { describe, expect, it } from "bun:test";

import { renderLensCompactStatus, renderLensWidgetLines } from "./lens-ui.ts";

const clean = {
	status: "ok",
	data: {
		status: "clean",
		sources: [
			{ name: "lsp", connected: true, errors: 0, warnings: 0 },
			{ name: "tree-sitter", connected: true, errors: 0, warnings: 0 },
			{ name: "biome", connected: true, errors: 0, warnings: 0 },
		],
	},
};

const warnings = {
	status: "warning",
	data: {
		status: "warnings",
		sources: [
			{ name: "lsp", connected: true, errors: 0, warnings: 2 },
			{ name: "biome", connected: true, errors: 0, warnings: 0 },
		],
		diagnostics: [
			{
				source: "lsp",
				severity: "warning",
				path: "src/foo.ts",
				start_line: 12,
				message: "Unused variable",
				fix_instructions: "Remove the unused variable.",
			},
		],
	},
	warnings: [{ code: "diagnostics_active", message: "warnings remain" }],
};

const errors = {
	status: "error",
	data: {
		status: "errors",
		sources: [
			{ name: "lsp", connected: true, errors: 2, warnings: 1 },
			{ name: "biome", connected: false, errors: 0, warnings: 0 },
		],
		diagnostics: [
			{
				source: "lsp",
				severity: "error",
				path: "src/foo.ts",
				start_line: 7,
				message: "Type mismatch",
				fix_command: "bun run typecheck",
			},
		],
	},
	errors: [{ code: "diagnostics_error", message: "errors remain" }],
};

describe("Lens Pi UI rendering", () => {
	it("renders compact session source summaries", () => {
		expect(renderLensCompactStatus(clean)).toContain("󰛩 Lens ✓ clean");
		expect(renderLensCompactStatus(clean)).toContain("sources: lsp ✓ tree-sitter ✓ biome ✓");
		expect(renderLensCompactStatus(warnings)).toContain("󰛩 Lens ⚠ warnings");
		expect(renderLensCompactStatus(warnings)).toContain("lsp 0 err/2 warn");
		expect(renderLensCompactStatus(errors)).toContain("󰛩 Lens ✗ errors");
		expect(renderLensCompactStatus(errors)).toContain("sources: lsp ✓ biome ×");
		expect(renderLensCompactStatus(errors)).toContain("lsp 2 err/1 warn");
	});

	it("can render dim ANSI color by section", () => {
		const rendered = renderLensCompactStatus(errors, { ansi: true });
		expect(rendered).toContain("\x1b[2;38;5;111m󰛩 Lens\x1b[0m");
		expect(rendered).toContain("\x1b[2;38;5;203m✗ errors\x1b[0m");
		expect(rendered).toContain("\x1b[2;38;5;181mlsp 2 err/1 warn\x1b[0m");
	});

	it("renders expanded diagnostics and fixes", () => {
		const lines = renderLensWidgetLines(errors, true);
		expect(lines).toContain("  source: lsp connected");
		expect(lines).toContain("  source: biome unavailable");
		expect(lines).toContain("  diagnostics: lsp 2 error(s), 1 warning(s)");
		expect(lines).toContain("  error: errors remain");
		expect(lines).toContain("  diagnostics: [lsp/error] src/foo.ts:7: Type mismatch");
		expect(lines).toContain("  fix: bun run typecheck");
	});

	it("renders warning diagnostics with fix instructions", () => {
		const lines = renderLensWidgetLines(warnings, true);
		expect(lines).toContain("  diagnostics: [lsp/warning] src/foo.ts:12: Unused variable");
		expect(lines).toContain("  fix: Remove the unused variable.");
	});
});
