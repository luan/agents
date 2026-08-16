/**
 * The whole notebook path against a real kernel: Node sidecar, ZMQ, `deno jupyter --kernel`, and the
 * loopback bridge.
 *
 * It is skipped unless `PI_NOTEBOOK_E2E_DENO` names a Deno 2.9.5 binary, because a download and a
 * kernel launch do not belong in the default suite.
 */

import { expect, it } from "bun:test";
import type { NestedToolResult, ToolCatalogEntry } from "../nested-dispatch.ts";
import type { HostBridge, HostToolCall } from "../rust-kernel.ts";
import { NotebookCellKernel } from "./index.ts";

const deno = process.env.PI_NOTEBOOK_E2E_DENO;
const CATALOG: ToolCatalogEntry[] = [{ name: "read", description: "Read a file", input: "path: string" }];

it.skipIf(!deno)(
	"runs real cells, keeps state, and calls tools",
	async () => {
		const calls: HostToolCall[] = [];
		const notices: string[] = [];
		const bridge: HostBridge = {
			callTool: (call): Promise<NestedToolResult> => {
				calls.push(call);
				return Promise.resolve({ text: `read ${JSON.stringify(call.args)}` });
			},
			notify: (text) => notices.push(text),
		};
		const kernel = new NotebookCellKernel(bridge, { denoPath: deno, cwd: process.cwd() });
		try {
			const first = await kernel.execute(1, 'console.log("hi"); const answer = 6 * 7; text(answer);', CATALOG);
			expect(first.error).toBeUndefined();
			expect(first.output).toContain("hi");
			expect(first.output).toContain("42");

			// The same kernel runs cell 2, so `answer` is still bound.
			const second = await kernel.execute(2, 'text("answer is still " + answer);', CATALOG);
			expect(second.error).toBeUndefined();
			expect(second.output).toContain("answer is still 42");

			const third = await kernel.execute(
				3,
				'const result = await tools.read({ path: "README.md" }); text(result.text); notify("done");',
				CATALOG,
			);
			expect(third.error).toBeUndefined();
			expect(third.output).toContain('read {"path":"README.md"}');
			expect(calls.map((call) => call.name)).toEqual(["read"]);
			expect(calls[0]?.cellId).toBe(3);
			expect(notices).toEqual(["done"]);

			const fourth = await kernel.execute(4, 'throw new Error("boom");', CATALOG);
			expect(fourth.error).toContain("boom");

			// A failed cell does not take the kernel down.
			const fifth = await kernel.execute(5, "text(answer + 1);", CATALOG);
			expect(fifth.output).toContain("43");
		} finally {
			kernel.dispose();
		}
	},
	120_000,
);
