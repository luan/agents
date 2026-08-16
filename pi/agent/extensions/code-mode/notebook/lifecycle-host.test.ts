import { afterAll, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NestedToolResult } from "../nested-dispatch.ts";
import type { CellOutcome, HostBridge } from "../rust-kernel.ts";
import { NotebookCellKernel } from "./index.ts";
import { createNotebookLifecycle, type NotebookLifecycleOptions, NotebookSessionHost } from "./lifecycle-host.ts";

const MARKER = /__PI_NOTEBOOK_[A-Z_]+_[0-9a-f-]{36}__/;
const directories: string[] = [];
afterAll(() => {
	for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function options(): NotebookLifecycleOptions {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-notebook-host-"));
	directories.push(agentDir);
	return { agentDir, cwd: agentDir, session: "test-session", denoPath: "/bin/false" };
}

interface Stub {
	kernel: NotebookCellKernel;
	sources: string[];
	names: Set<string>;
	resets: number;
	running: boolean;
	error: string | undefined;
}

/** Answers the injected sources the host generates. Nothing here starts a process. */
function stubKernel(baseline: string[]): Stub {
	const state = {
		sources: [] as string[],
		names: new Set(baseline),
		lexical: new Set<string>(),
		resets: 0,
		running: false,
		error: undefined as string | undefined,
	};
	const kernel = {
		get running(): boolean {
			return state.running;
		},
		execute: (_localId: number, source: string): Promise<CellOutcome> => {
			state.sources.push(source);
			if (state.error) return Promise.resolve({ output: "", error: state.error });
			const marker = MARKER.exec(source)?.[0] ?? "";
			if (source.includes("getOwnPropertyNames(globalThis)")) {
				return Promise.resolve({ output: `${marker}${JSON.stringify([...state.names])}` });
			}
			if (source.includes("__piNotebook.projectBindings")) return Promise.resolve({ output: `${marker}[]` });
			if (source.includes("Deno.memoryUsage()")) {
				const names = [
					...new Set(
						[...source.matchAll(/name: (".*?")/g)].map(([, quoted]) => JSON.parse(quoted ?? '""') as string),
					),
				];
				return Promise.resolve({
					output: `${marker}${JSON.stringify({
						memory: { heapUsedBytes: 1, heapTotalBytes: 2, heapLimitBytes: 4, rssBytes: 8, externalBytes: 0 },
						bindings: names.map((name) => ({ name, type: "object", kind: "value", globalProperty: true })),
					})}`,
				});
			}
			return Promise.resolve({ output: "" });
		},
		// `liveBindings` also asks the kernel to complete an empty prefix, because a top-level `let` or
		// `const` never appears in `getOwnPropertyNames(globalThis)`.
		complete: (): Promise<string[]> => Promise.resolve([...state.lexical]),
		reset: (): void => {
			state.resets += 1;
		},
	};
	// The stub's getter closes over `state`, so the harness must be that same object, never a copy.
	return Object.assign(state, { kernel: kernel as unknown as NotebookCellKernel });
}

it("starts one kernel and subtracts the baseline from the live bindings", async () => {
	const stub = stubKernel(["tools", "text"]);
	const host = new NotebookSessionHost(stub.kernel, options());
	await host.prepare();
	const afterFirst = stub.sources.length;
	stub.names.add("alpha");
	// A top-level `let` or `const` never reaches `getOwnPropertyNames`, so completion is the only
	// source for it. `liveBindings` must merge both.
	stub.lexical.add("lexicalOne");
	expect([...(await host.liveBindings())].sort()).toEqual(["alpha", "lexicalOne"]);
	await host.prepare();
	// The second prepare adds nothing: one `liveBindings` source and no second start.
	expect(stub.sources.length).toBe(afterFirst + 1);
	expect(host.kernel()).toBeDefined();
});

it("retries the start after a failed one", async () => {
	const stub = stubKernel(["tools"]);
	const host = new NotebookSessionHost(stub.kernel, options());
	stub.error = "kernel is unreachable";
	await expect(host.prepare()).rejects.toThrow("kernel is unreachable");
	expect(host.kernel()).toBeUndefined();
	stub.error = undefined;
	await host.prepare();
	expect(host.kernel()).toBeDefined();
});

it("reports idle status with the live bindings", async () => {
	const stub = stubKernel(["tools", "text"]);
	const control = createNotebookLifecycle(stub.kernel, options());
	await control.control({ action: "status" });
	stub.names.add("alpha");
	const result = await control.control({ action: "status", query: "al*" });
	expect(result.details["state"]).toBe("idle");
	expect(result.details["userBindings"]).toBe(1);
	expect(result.details["matches"]).toEqual([{ name: "alpha", type: "object", kind: "value", globalProperty: true }]);
});

it("reports a running cell without inspecting the kernel", async () => {
	const stub = stubKernel(["tools"]);
	const control = createNotebookLifecycle(stub.kernel, options());
	await control.control({ action: "status" });
	stub.running = true;
	const sources = stub.sources.length;
	const result = await control.control({ action: "status" });
	expect(result.details["state"]).toBe("running");
	expect(result.details["activeCell"]).toBe("cell");
	expect(stub.sources.length).toBe(sources);
});

it("drops the kernel when it stops an active cell", async () => {
	const stub = stubKernel(["tools"]);
	const host = new NotebookSessionHost(stub.kernel, options());
	await host.prepare();
	expect(await host.stopActive()).toBeUndefined();
	expect(stub.resets).toBe(0);
	stub.running = true;
	expect(await host.stopActive()).toBe("cell");
	expect(stub.resets).toBe(1);
	expect(host.kernel()).toBeUndefined();
});

it("undoes a promotion by restoring the tracked selection", async () => {
	const stub = stubKernel(["tools"]);
	const host = new NotebookSessionHost(stub.kernel, options());
	await host.prepare();
	const undo = await host.promoteBindings(["alpha"]);
	expect(stub.sources.some((source) => source.includes('promote(["alpha"])'))).toBe(true);
	await undo();
	expect(stub.sources.some((source) => source.includes("syncProjectBindings([])"))).toBe(true);
});

it("restarts the kernel and reports no notice when nothing was checkpointed", async () => {
	const stub = stubKernel(["tools"]);
	const host = new NotebookSessionHost(stub.kernel, options());
	await host.prepare();
	expect(await host.restart()).toBeUndefined();
	expect(stub.resets).toBe(1);
	expect(host.kernel()).toBeDefined();
});

/**
 * The whole seam against a real kernel. Skipped unless `PI_NOTEBOOK_E2E_DENO` names a Deno 2.9.5
 * binary, for the reason kernel-e2e.test.ts:5 gives.
 */
const deno = process.env["PI_NOTEBOOK_E2E_DENO"];

it.skipIf(!deno)(
	"checkpoints a real binding and restores it across a restart",
	async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-notebook-e2e-"));
		directories.push(agentDir);
		const bridge: HostBridge = {
			callTool: (): Promise<NestedToolResult> => Promise.resolve({ text: "ok" }),
			notify: () => {},
		};
		const kernel = new NotebookCellKernel(bridge, { denoPath: deno, cwd: agentDir });
		const control = createNotebookLifecycle(kernel, {
			denoPath: deno,
			cwd: agentDir,
			agentDir,
			session: "e2e-session",
		});
		try {
			// Before the cell, so the baseline holds only what the bootstrap bound.
			expect((await control.control({ action: "status" })).details["state"]).toBe("idle");
			const cell = await kernel.execute(1, "globalThis.alpha = 41 + 1;", []);
			expect(cell.error).toBeUndefined();

			const status = await control.control({ action: "status", query: "alpha" });
			expect(status.details["userBindings"]).toBe(1);
			expect(status.message).toContain("alpha");

			expect((await control.control({ action: "checkpoint" })).message).toBe("Notebook checkpoint complete");
			const sessions = join(agentDir, "notebook", "sessions");
			const written = readdirSync(sessions).map((entry) => join(sessions, entry, "checkpoint.json"));
			expect(written.some((path) => existsSync(path))).toBe(true);

			expect((await control.control({ action: "restart" })).message).toContain("restarted");
			const restored = await kernel.execute(2, "text(typeof alpha + ':' + alpha);", []);
			expect(restored.output).toContain("number:42");
		} finally {
			kernel.dispose();
		}
	},
	180_000,
);
