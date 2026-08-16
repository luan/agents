import { expect, it } from "bun:test";
import { registerTool } from "../shared/tool-registry.ts";
import { callNestedTool } from "./nested-dispatch.ts";
import { CellSession, collect } from "./runtime.ts";

// Needs a real kernel: the child puts the cell id on the message and the host reads it back. Without that attribution
// every turn renders as a bare status line while the suite stays green.
it("files a cell's tool calls against the cell and reports each one as it happens", async () => {
	registerTool({ registerTool() {} } as never, {
		name: "probe_activity_tool",
		execute: () => ({ content: [{ type: "text", text: "first line\nsecond line" }] }),
	});

	const session = new CellSession({
		callTool: (call) =>
			callNestedTool(call.name, call.args, {
				ctx: undefined,
				signal: call.signal,
				maxTokens: call.maxTokens,
				toolCallId: call.toolCallId,
			}),
		notify: () => {},
	});
	const record = session.start({
		code: "const r = await tools.probe_activity_tool({}); text(r.text.split('\\n')[0]);",
		language: "js",
		// The Rust host builds the `tools` object from the catalog, so an absent entry is not callable.
		catalog: [{ name: "probe_activity_tool", description: "probe", input: "{}" }],
	});
	const announced: Array<string | undefined> = [];
	record.onActivity = () => announced.push(record.calls[0]?.status);

	const collected = await collect(record, 9_000);
	session.reset();

	expect(collected.outcome?.error).toBeUndefined();
	expect(collected.outcome?.output).toBe("first line");
	expect(record.calls).toHaveLength(1);
	expect(record.calls[0]).toMatchObject({ name: "probe_activity_tool", status: "completed" });
	expect(record.calls[0]?.preview).toBe("first line · 2 lines");
	expect(record.calls[0]?.resultTokens).toBeGreaterThan(0);
	expect(announced).toEqual(["running", "completed"]);
});
