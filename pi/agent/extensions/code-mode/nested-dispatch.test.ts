import { afterEach, expect, it } from "bun:test";
import { approxTokenCount } from "../shared/output-budget.ts";
import { setArtifactMinter } from "../shared/tool-bounding.ts";
import { registerTool } from "../shared/tool-registry.ts";
import { publishToolPolicy, unpublishToolPolicy } from "../tool-policy/policy.ts";
import { buildToolCatalog, callNestedTool, NestedToolError } from "./nested-dispatch.ts";

afterEach(() => {
	setArtifactMinter(undefined);
	unpublishToolPolicy("root-policy-session");
	unpublishToolPolicy("child-policy-session");
});

const noopApi = { registerTool() {} } as never;

it("suggests the registered tool that fixes an unknown name", async () => {
	registerTool(noopApi, { name: "task_write", execute: () => ({ content: [] }) });
	await expect(callNestedTool("task_update", {}, { ctx: undefined })).rejects.toThrow(
		"No tool named `task_update`. Did you mean `task_write`?",
	);
});

it("uses the calling context's policy outside session async-local storage", async () => {
	registerTool(noopApi, {
		name: "probe_policy_target",
		execute: () => ({ content: [{ type: "text", text: "ran" }] }),
	});
	publishToolPolicy({ isHidden: (name: string) => name === "probe_policy_target" } as never, "root-policy-session");
	publishToolPolicy({ isHidden: () => false } as never, "child-policy-session");

	await expect(
		callNestedTool(
			"probe_policy_target",
			{},
			{
				ctx: { sessionManager: { getSessionId: () => "root-policy-session" } } as never,
			},
		),
	).rejects.toThrow("blocked by tool policy");
});
it("prints catalog entries compactly while keeping details addressable", () => {
	registerTool(noopApi, {
		name: "probe_catalog_compact",
		description: "full description",
		execute: () => ({ content: [] }),
	});

	const entry = buildToolCatalog().find(({ name }) => name === "probe_catalog_compact");
	expect(entry).toBeDefined();
	expect(JSON.stringify(entry)).toBe(JSON.stringify("probe_catalog_compact"));
	expect(entry?.description).toBe("full description");
	expect(entry?.input).toBeDefined();
});

// tool-policy's `tool_result` handler never fires for a call made from inside a cell, so code-mode re-applies the bound
// itself. Drop that re-application and nothing fails: cells keep working and the tokens come straight back.
it("bounds a nested result and points at the artifact", async () => {
	const minted: string[] = [];
	setArtifactMinter(async (text) => {
		minted.push(text);
		return "artifact://nested-probe";
	});
	registerTool(noopApi, {
		name: "probe_oversized_tool",
		execute: () => ({
			content: [{ type: "text", text: Array.from({ length: 20_000 }, (_, i) => `row ${i}`).join("\n") }],
			details: { outputTokens: 20_000 },
		}),
	});

	const result = await callNestedTool("probe_oversized_tool", {}, { ctx: undefined });

	expect(approxTokenCount(result.text)).toBeLessThanOrEqual(6_000);
	expect(result.raw?.content).toEqual([{ type: "text", text: result.text }]);
	expect(result.details).toMatchObject({
		outputTokens: approxTokenCount(result.text),
		outputBounded: true,
	});
	expect(result.artifact).toBe("artifact://nested-probe");
	expect(result.text).toContain("artifact://nested-probe");
	expect(minted[0]).toContain("row 19999");
});

it("keeps one artifact for a process drain while unrelated calls still mint separately", async () => {
	const calls: Array<{ text: string; existingUri?: string }> = [];
	setArtifactMinter(async (text, _label, existingUri) => {
		calls.push({ text, existingUri });
		return existingUri ?? `artifact://process-${calls.length}`;
	});
	const firstOutput = Array.from({ length: 20_000 }, (_, index) => `first ${index}`).join("\n");
	let poll = 0;
	registerTool(noopApi, {
		name: "write_stdin",
		execute: () => {
			poll++;
			const output = poll === 1 ? firstOutput : "second chunk";
			const capture = poll === 1 ? firstOutput : `${firstOutput}\nsecond chunk`;
			return {
				content: [{ type: "text", text: output }],
				details: { process_id: 17, capture_output: capture, ...(poll === 2 ? { terminal_state: "exited" } : {}) },
			};
		},
	});
	const first = await callNestedTool("write_stdin", { process_id: 17 }, { ctx: undefined });
	const second = await callNestedTool("write_stdin", { process_id: 17 }, { ctx: undefined });

	registerTool(noopApi, {
		name: "probe_unrelated_drain_tool",
		execute: () => ({ content: [{ type: "text", text: firstOutput }] }),
	});
	const unrelatedFirst = await callNestedTool("probe_unrelated_drain_tool", {}, { ctx: undefined });
	const unrelatedSecond = await callNestedTool("probe_unrelated_drain_tool", {}, { ctx: undefined });

	expect(first.artifact).toBe("artifact://process-1");
	expect(second.artifact).toBe("artifact://process-1");
	expect(calls.slice(0, 2).map((call) => call.existingUri)).toEqual([undefined, "artifact://process-1"]);
	expect(calls.slice(0, 2).map((call) => call.text)).toEqual([firstOutput, `${firstOutput}\nsecond chunk`]);
	expect(unrelatedFirst.artifact).toBe("artifact://process-3");
	expect(unrelatedSecond.artifact).toBe("artifact://process-4");
	expect(calls.slice(2).every((call) => call.existingUri === undefined)).toBe(true);
});

const RED_2X2_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAE0lEQVR4nGP4z8DwnwGM/zMwAAAf7gP9NRsAMwAAAABJRU5ErkJggg==";

// `textOf` kept only text blocks, so `view_image` from a cell reached the model with the pixels stripped.
it("carries a nested tool's image blocks back beside its text", async () => {
	registerTool(noopApi, {
		name: "probe_image_tool",
		execute: () => ({
			content: [
				{ type: "text", text: "Read image file [image/png]" },
				{ type: "image", data: RED_2X2_PNG, mimeType: "image/png" },
			],
		}),
	});

	const result = await callNestedTool("probe_image_tool", {}, { ctx: undefined });

	expect(result.text).toBe("Read image file [image/png]");
	expect(result.images).toEqual([{ data: RED_2X2_PNG, mimeType: "image/png" }]);
	expect(result.raw?.content).toEqual([{ type: "text", text: "Read image file [image/png]" }]);
});

it("names the size when an image will not fit the inline limit", async () => {
	registerTool(noopApi, {
		name: "probe_unbounded_image_tool",
		execute: () => ({
			content: [
				{ type: "text", text: "Screenshot captured." },
				{ type: "image", data: Buffer.alloc(64_000, 7).toString("base64"), mimeType: "image/png" },
			],
		}),
	});

	const result = await callNestedTool("probe_unbounded_image_tool", {}, { ctx: undefined });

	expect(result.images).toBeUndefined();
	expect(result.text).toContain("[Image omitted: 0.1 MB of image/png would not fit");
});

it("leaves images unset for a text-only nested result", async () => {
	registerTool(noopApi, {
		name: "probe_textonly_tool",
		execute: () => ({ content: [{ type: "text", text: "done" }] }),
	});

	expect((await callNestedTool("probe_textonly_tool", {}, { ctx: undefined })).images).toBeUndefined();
});

it("refuses to nest the cell runner", async () => {
	await expect(callNestedTool("exec", {}, { ctx: undefined })).rejects.toBeInstanceOf(NestedToolError);
});

// `exec_command` carries the whole command output in `details.output`, so printing the result object paid twice.
it("drops details that would cost more than the text it repeats", async () => {
	const output = Array.from({ length: 20_000 }, (_, i) => `row ${i}`).join("\n");
	registerTool(noopApi, {
		name: "probe_fat_details_tool",
		execute: () => ({ content: [{ type: "text", text: "Output:\nrow 0\n…" }], details: { output } }),
	});

	const result = await callNestedTool("probe_fat_details_tool", {}, { ctx: undefined });

	expect((result.details as { output?: string }).output).toBeUndefined();
	expect((result.details as { omitted?: string }).omitted).toContain("over the");
	expect((result.raw?.details as { omitted?: string }).omitted).toContain("over the");
});

it("keeps details that stay a metadata bag", async () => {
	registerTool(noopApi, {
		name: "probe_lean_details_tool",
		execute: () => ({ content: [{ type: "text", text: "done" }], details: { exit_code: 0, wall_time: 0.08 } }),
	});

	const result = await callNestedTool("probe_lean_details_tool", {}, { ctx: undefined });

	expect(result.details).toEqual({ exit_code: 0, wall_time: 0.08 });
});

it("projects details before applying the nested details ceiling", async () => {
	const output = Array.from({ length: 20_000 }, (_, i) => `row ${i}`).join("\n");
	registerTool(noopApi, {
		name: "probe_projected_details_tool",
		nestedResult: {
			details: { title: "ProbeDetails", type: "object", properties: { rows: { type: "number" } } },
			projectDetails: ({ details }) => ({ rows: (details as { rows: number }).rows }),
		},
		execute: () => ({ content: [{ type: "text", text: "done" }], details: { output, rows: 20_000 } }),
	});

	const result = await callNestedTool("probe_projected_details_tool", {}, { ctx: undefined });

	expect(result.details).toEqual({ rows: 20_000 });
});

// pi builds a fresh jiti with `moduleCache: false` per extension, so the three modules below hold state on `globalThis`.
// Losing that leaves code-mode's registry copy empty and every `tools.<name>()` reports "no tool named".
it("keeps registry, minter and policy state across a second evaluation of the module", async () => {
	registerTool(noopApi, { name: "probe_shared_state", execute: () => ({ content: [] }) });

	const suffix = `?reevaluated=${Date.now()}`;
	const freshRegistry = await import(`../shared/tool-registry.ts${suffix}`);
	const freshBounding = await import(`../shared/tool-bounding.ts${suffix}`);
	const freshPolicy = await import(`../tool-policy/policy.ts${suffix}`);
	const { getToolPolicy } = await import("../tool-policy/policy.ts");

	expect(freshRegistry.registerTool).not.toBe(registerTool);

	expect(freshRegistry.listRegisteredToolNames()).toContain("probe_shared_state");

	setArtifactMinter(async () => "artifact://from-the-first-instance");
	expect(freshBounding.hasArtifactMinter()).toBe(true);

	expect(freshPolicy.getToolPolicy()).toBe(getToolPolicy());
});
