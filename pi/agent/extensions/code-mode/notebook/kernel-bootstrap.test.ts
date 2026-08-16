import { expect, it } from "bun:test";
import type { NestedToolResult } from "../nested-dispatch.ts";
import type { NotebookContentItem, NotebookMemoryUsage } from "./bridge-protocol.ts";
import { type NotebookBridgeHandlers, startNotebookBridge } from "./bridge-server.ts";
import { NOTEBOOK_EXIT_NAME, notebookBootstrapSource } from "./kernel-bootstrap.ts";

const PNG_1X1 =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

// The bootstrap runs as one silent Jupyter cell, where top-level `await` is legal. `new Function`
// would reject `await import("node:v8")`, so the parse check uses the async function constructor.
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (body: string) => () => Promise<void>;

const kernel = globalThis as unknown as {
	Deno?: { memoryUsage(): { heapUsed: number; heapTotal: number; rss: number; external: number } };
	tools: Record<string, (input: unknown) => Promise<unknown>>;
	ALL_TOOLS: unknown[];
	text(value: unknown): void;
	image(value: unknown, detail?: unknown): void;
	audio(value: unknown): void;
	exit(): void;
	store(key: string, value: unknown): void;
	load(key: string): unknown;
	__pi_runtime: {
		begin(cellId: string, tools: unknown[], toolNames: Record<string, unknown>): Promise<void>;
		flush(cellId: string): Promise<void>;
	};
};

it("emits parseable kernel source", () => {
	expect(() => new AsyncFunction(notebookBootstrapSource("http://127.0.0.1:1", "token"))).not.toThrow();
});

// One test owns the run: the bootstrap defines `__pi_runtime` with `configurable: false`, so a second
// evaluation in the same process throws.
it("drives tools, emitters and flush against a live bridge", async () => {
	const emitted: NotebookContentItem[] = [];
	const notified: string[] = [];
	const cancelled: string[] = [];
	const memory: NotebookMemoryUsage[] = [];
	const calls: unknown[] = [];
	const result: NestedToolResult = { text: "ok", details: { count: 7n, bytes: new Uint8Array([1, 2, 3]) } };
	const handlers: NotebookBridgeHandlers = {
		callTool: (request) => {
			calls.push({ ...request.toolName, input: request.input });
			return Promise.resolve(result);
		},
		cancelTools: (cellId) => cancelled.push(cellId),
		emit: (_cellId, items) => emitted.push(...items),
		notify: (_cellId, text) => notified.push(text),
		yield: () => undefined,
		memory: (_cellId, usage) => memory.push(usage),
	};
	const bridge = await startNotebookBridge(handlers);
	// The kernel is Deno. Bun has no `Deno.memoryUsage`, which `begin` reports through.
	kernel.Deno = { memoryUsage: () => ({ heapUsed: 1, heapTotal: 2, rss: 3, external: 4 }) };

	try {
		await new AsyncFunction(notebookBootstrapSource(bridge.origin, bridge.token))();

		// The Rust host takes data URIs only, so a remote fetch never happens on the model's behalf.
		expect(() => kernel.image("http://example.com/cat.png")).toThrow(/remote image URLs are not supported/);
		expect(() => kernel.audio("https://example.com/cat.wav")).toThrow(/remote audio URLs are not supported/);
		expect(() => kernel.image("/tmp/cat.png")).toThrow(/pass a base64 data URI/);
		// Helpers refuse to run outside a cell: their output has nowhere to go.
		expect(() => kernel.text("stray")).toThrow(/outside an active exec cell/);

		await kernel.__pi_runtime.begin("cell-1", [{ name: "read" }], { read: { name: "read", namespace: "core" } });
		expect(memory).toMatchObject([{ heapUsedBytes: 1, heapTotalBytes: 2, rssBytes: 3, externalBytes: 4 }]);
		expect(typeof memory[0]?.heapLimitBytes).toBe("number");
		expect(kernel.ALL_TOOLS).toEqual([{ name: "read" }]);

		// A Proxy answers any name, so `toolNames` supplies the namespace the catalog knows.
		const toolResult = (await kernel.tools.read?.({ path: "a.txt" })) as NestedToolResult;
		expect(calls).toEqual([{ name: "read", namespace: "core", input: { path: "a.txt" } }]);
		expect(toolResult).toEqual({ text: "ok", details: { count: 7n, bytes: new Uint8Array([1, 2, 3]) } });

		kernel.store("k", { a: 1 });
		expect(kernel.load("k")).toEqual({ a: 1 });
		expect(kernel.load("missing")).toBeUndefined();

		kernel.text("done");
		kernel.image(PNG_1X1);
		await kernel.__pi_runtime.flush("cell-1");

		expect(emitted).toEqual([
			{ type: "input_text", text: "done" },
			{ type: "input_image", image_url: PNG_1X1, detail: "high" },
		]);
		expect(cancelled).toEqual(["cell-1"]);
		expect(memory.length).toBe(2);
		// `flush` closes the cell, so a late helper call fails instead of leaking into the next cell.
		expect(() => kernel.text("late")).toThrow(/outside an active exec cell/);

		// `exit()` ends the cell successfully. Jupyter reports the name as `ename`, which is how the
		// host tells it from a real throw.
		const exitError = ((): unknown => {
			try {
				kernel.exit();
			} catch (error) {
				return error;
			}
		})();
		expect((exitError as Error).name).toBe(NOTEBOOK_EXIT_NAME);
	} finally {
		kernel.Deno = undefined;
		await bridge.close();
	}
});
