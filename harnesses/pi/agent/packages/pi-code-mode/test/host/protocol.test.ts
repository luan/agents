import { describe, expect, test } from "bun:test";
import { parseExecSource, parseRuntimeResponse, toWireToolDefinition } from "../../src/host/protocol.ts";

describe("exec source protocol", () => {
	test("parses the supported pragma", () => {
		expect(parseExecSource('// @exec: {"yield_time_ms": 250, "max_output_tokens": 123}\ntext("ok")')).toEqual({
			code: 'text("ok")',
			yieldTimeMs: 250,
			maxOutputTokens: 123,
		});
	});

	test("rejects unsupported pragma fields", () => {
		expect(() => parseExecSource('// @exec: {"unknown": true}\ntext("ok")')).toThrow(
			"Unsupported exec pragma field: unknown",
		);
	});
});

test("parses audio returned by the Code Mode host", () => {
	expect(
		parseRuntimeResponse({
			Result: {
				cell_id: "cell-audio",
				content_items: [{ type: "input_audio", audio_url: "data:audio/wav;base64,YQ==" }],
			},
		}),
	).toMatchObject({
		kind: "result",
		cellId: "cell-audio",
		contentItems: [{ type: "input_audio", audio_url: "data:audio/wav;base64,YQ==" }],
	});
});

describe("nested tool wire definition", () => {
	test("keeps function and freeform schemas distinct", () => {
		const invoke = async () => ({ content: [{ type: "text" as const, text: "ok" }], details: undefined });
		const functionTool = toWireToolDefinition({
			name: "web",
			kind: "function",
			parameters: { type: "object" },
			outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
			invoke,
		});
		const freeformTool = toWireToolDefinition({
			name: "apply_patch",
			kind: "freeform",
			invoke,
		});

		expect(functionTool.input_schema).toEqual({ type: "object" });
		expect(functionTool.output_schema).toEqual({
			type: "object",
			properties: { ok: { type: "boolean" } },
			required: ["ok"],
		});
		expect(functionTool.description).toContain("web(args: { [key: string]: unknown; }): Promise<{ ok: boolean; }>");
		expect(freeformTool.input_schema).toBeNull();
	});
});
