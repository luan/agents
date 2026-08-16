import { expect, it } from "bun:test";
import {
	projectAstEditDetails,
	projectEditDetails,
	projectFindDetails,
	projectReadDetails,
	projectSearchDetails,
	projectWriteDetails,
} from "../fileops/contracts.ts";
import { approxTokenCount } from "../shared/output-budget.ts";
import { projectCommandDetails } from "./tool-results.ts";

it("projects edit renderer details to changed paths and fresh hashlines", () => {
	const diff = Array.from({ length: 10_000 }, (_, index) => `+row ${index}`).join("\n");
	const projected = projectEditDetails({
		diff,
		patch: diff,
		results: [
			{ path: "src/a.ts", header: "[src/a.ts#A1B2]" },
			{ path: "src/b.ts", header: "[src/b.ts#C3D4]" },
		],
		firstChangedLine: 17,
	});

	expect(projected).toEqual({
		changes: [
			{ path: "src/a.ts", hashlineTag: "A1B2" },
			{ path: "src/b.ts", hashlineTag: "C3D4" },
		],
		firstChangedLine: 17,
	});
	expect(approxTokenCount(JSON.stringify(projected))).toBeLessThan(500);
});

it("projects search renderer rows to plain matched hits", () => {
	const projected = projectSearchDetails(
		{ highlightedSections: [{ path: "src/a.ts", rows: ["\u001b[31mconst value = 1\u001b[0m"] }] },
		"[src/a.ts#A1B2]\n 4:const context = true\n*5:const value = 1",
	);

	expect(projected).toEqual({
		hits: [{ path: "src/a.ts", line: 5, ref: "src/a.ts:5", text: "const value = 1" }],
	});
	expect(JSON.stringify(projected)).not.toContain("\u001b");
	expect(approxTokenCount(JSON.stringify(projected))).toBeLessThan(2_000);
});

it("uses plain search output when a hashline tag is unavailable", () => {
	const projected = projectSearchDetails(
		{ highlightedSections: [{ path: "src/a.ts", rows: ["renderer row"] }] },
		"src/a.ts\n 4:const context = true\n*5:const value = 1",
	);

	expect(projected).toEqual({
		hits: [{ path: "src/a.ts", line: 5, ref: "src/a.ts:5", text: "const value = 1" }],
	});
});

it("projects read, find, and write details to their declared fields", () => {
	expect(projectReadDetails({ hashlineTag: "A1B2", outputTokens: 42, previewImage: "renderer" })).toEqual({
		hashlineTag: "A1B2",
		outputTokens: 42,
	});
	expect(projectFindDetails({ outputTokens: 7, outputBounded: false, resources: ["renderer"] })).toEqual({
		outputTokens: 7,
		outputBounded: false,
	});
	expect(projectWriteDetails({ bytes: 12, resource: { uri: "vault://note" } })).toEqual({ bytes: 12 });
});

it("projects command details without duplicating output", () => {
	const projected = projectCommandDetails({
		output: "x".repeat(100_000),
		exit_code: 0,
		wall_time_seconds: 0.08,
		process_id: 42,
		stdin_open: true,
		terminal_state: "exited",
		output_truncated: true,
		original_token_count: 30_000,
		capture_output: "duplicate",
	});

	expect(projected).toEqual({
		exit_code: 0,
		wall_time_seconds: 0.08,
		process_id: 42,
		stdin_open: true,
		terminal_state: "exited",
		output_truncated: true,
		original_token_count: 30_000,
	});
	expect(approxTokenCount(JSON.stringify(projected))).toBeLessThan(1_250);
});

it("projects AST edit renderer payload to model metadata", () => {
	const projected = projectAstEditDetails({
		matches: 4,
		applied: true,
		diff: "x".repeat(100_000),
		highlightedDiffRows: ["renderer payload"],
	});

	expect(projected).toEqual({ matches: 4, applied: true });
});
