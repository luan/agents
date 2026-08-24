import { expect, test } from "bun:test";
import { toCodeModeToolResult } from "../../src/tools/result.ts";

test("records JavaScript errors for Pi's tool-result failure boundary", () => {
	const result = toCodeModeToolResult({
		kind: "result",
		cellId: "cell-1",
		contentItems: [],
		errorText: "boom",
	});

	expect(result.content).toEqual([{ type: "text", text: "Script error: boom" }]);
	expect(result.details).toMatchObject({
		version: 1,
		tool: "exec",
		status: "failed",
		isError: true,
		scriptError: "boom",
	});
});

test("records missing wait cells for Pi's tool-result failure boundary", () => {
	const result = toCodeModeToolResult({
		kind: "result",
		cellId: "missing",
		contentItems: [{ type: "input_text", text: "Unknown cell: missing" }],
		missingCell: true,
	});

	expect(result.details).toMatchObject({ version: 1, tool: "exec", isError: true, missingCell: true });
});

test("returns audio from the native host to the provider boundary", () => {
	const result = toCodeModeToolResult({
		kind: "result",
		cellId: "audio",
		contentItems: [{ type: "input_audio", audio_url: "data:audio/wav;base64,YQ==" }],
	});

	expect(result.content as readonly object[]).toContainEqual({ type: "audio", mimeType: "audio/wav", data: "YQ==" });
	expect(result.details.output).toMatchObject({ audioCount: 1, audioChars: 4 });
});

test("shows a compact nested-call summary through Pi's default renderer", () => {
	const result = toCodeModeToolResult({
		kind: "result",
		cellId: "cell-1",
		contentItems: [],
		nestedCalls: [
			{
				version: 1,
				id: "one",
				name: "exec_command",
				kind: "function",
				input: { cmd: "pwd" },
				status: "done",
				startedAtMs: 100,
				durationMs: 5,
			},
			{
				version: 1,
				id: "two",
				name: "apply_patch",
				kind: "freeform",
				input: "*** Begin Patch",
				status: "error",
				startedAtMs: 110,
				durationMs: 2,
				error: "failed",
			},
		],
	});

	expect(result.content).toEqual([
		{ type: "text", text: "• Ran exec_command\n• Failed apply_patch" },
		{ type: "text", text: "Script completed" },
	]);
	expect(result.details).toMatchObject({
		version: 1,
		tool: "exec",
		status: "completed",
		nestedCalls: [
			{ name: "exec_command", input: { cmd: "pwd" }, durationMs: 5 },
			{ name: "apply_patch", error: "failed", durationMs: 2 },
		],
	});
	expect(JSON.parse(JSON.stringify(result.details))).toEqual(result.details);
});
