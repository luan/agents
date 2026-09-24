import { expect, test } from "bun:test";
import { replayWindowCheckpoint } from "../src/compaction/window-checkpoint.ts";
import { createNativeCompactionDetails } from "../src/compaction/types.ts";
import { getCodexModels } from "../src/provider/models.ts";
const model = getCodexModels()[0]!;
const checkpoint = JSON.stringify(
	createNativeCompactionDetails({
		provider: model.provider,
		api: model.api,
		model: model.id,
		baseUrl: model.baseUrl,
		compactedWindow: [
			{
				role: "user",
				content: [{ type: "input_text", text: "<context_window>\nCurrent window: old\n</context_window>" }],
			},
			{ role: "user", content: [{ type: "input_text", text: "Explain <context_window> to me" }] },
			{ type: "compaction", encrypted_content: "opaque" },
		],
	}),
);

test("replay preserves instructions and real requests while replacing the old window reminder", () => {
	const replay = replayWindowCheckpoint(checkpoint, model, [
		{ role: "developer", content: "Current instructions" },
		{ role: "user", content: "Current window: new" },
	]);
	expect(replay[0]).toEqual({ role: "developer", content: "Current instructions" });
	expect(JSON.stringify(replay)).toContain("Explain <context_window> to me");
	expect(JSON.stringify(replay)).not.toContain("Current window: old");
	expect(replay.at(-1)).toEqual({ role: "user", content: "Current window: new" });
});

test.each(["{}", "not json", checkpoint.replace('"encrypted_content":"opaque"', '"missing":"opaque"')])(
	"damaged checkpoints fail closed (%s)",
	(damaged) => {
		expect(() => replayWindowCheckpoint(damaged, model, [])).toThrow();
	},
);

test("a checkpoint cannot cross provider endpoints", () => {
	expect(() => replayWindowCheckpoint(checkpoint, { ...model, baseUrl: "https://different.invalid" }, [])).toThrow(
		"different provider endpoint",
	);
});
