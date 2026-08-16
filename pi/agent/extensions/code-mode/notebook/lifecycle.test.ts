import { expect, it } from "bun:test";

import { type NotebookControlResult, NotebookLifecycleController, type NotebookLifecycleHost } from "./lifecycle.ts";
import type { NotebookProfileController } from "./profile-lifecycle.ts";
import type { NotebookExecutionResult, NotebookKernelExecutor } from "./project-state-format.ts";
import type { ProjectStatePinUpdate } from "./project-state-merge.ts";
import type { RetainedProjectBinding } from "./project-state-metadata.ts";
import type { NotebookRecoveryController } from "./recovery.ts";

const MARKER = /__PI_NOTEBOOK_LIFECYCLE_[0-9a-f-]+__/;

interface Harness {
	calls: string[];
	sources: string[];
	live: Set<string>;
	retained: RetainedProjectBinding[];
	activeCell: string | undefined;
	/** Names the generated status block reports as lexical, so a release must restart the kernel. */
	lexical: Set<string>;
	commitError: Error | undefined;
	kernelPresent: boolean;
	controller: NotebookLifecycleController;
}

function retained(name: string, bytes: number, pinned: boolean): RetainedProjectBinding {
	return { name, kind: "value", bytes, updatedAt: new Date().toISOString(), pinned };
}

function harness(): Harness {
	const state = {
		calls: [] as string[],
		sources: [] as string[],
		live: new Set<string>(),
		retained: [] as RetainedProjectBinding[],
		activeCell: undefined as string | undefined,
		lexical: new Set<string>(),
		commitError: undefined as Error | undefined,
		kernelPresent: true,
	};

	const respond = (source: string): NotebookExecutionResult => {
		state.sources.push(source);
		const marker = MARKER.exec(source)?.[0] ?? "";
		// The status block names each binding twice: once on the success push, once in its catch.
		const names = [
			...new Set([...source.matchAll(/name: (".*?")/g)].map(([, quoted]) => JSON.parse(quoted!) as string)),
		];
		if (source.includes("Deno.memoryUsage()")) {
			return {
				status: "ok",
				output: `${marker}${JSON.stringify({
					memory: {
						heapUsedBytes: 2048,
						heapTotalBytes: 4096,
						heapLimitBytes: 8192,
						rssBytes: 16_384,
						externalBytes: 0,
					},
					bindings: names.map((name) => ({
						name,
						type: "object",
						kind: "value",
						globalProperty: !state.lexical.has(name),
					})),
				})}`,
			};
		}
		const removes = source.includes("delete globalThis");
		if (removes) for (const name of names) state.live.delete(name);
		return {
			status: "ok",
			output: `${marker}${JSON.stringify({ released: removes ? names : [], disposed: names, failures: [] })}`,
		};
	};

	const kernel: NotebookKernelExecutor = {
		execute: async (source) => respond(source),
		complete: async () => [...state.live],
	};

	const host: NotebookLifecycleHost = {
		prepare: async () => void state.calls.push("prepare"),
		kernel: () => (state.kernelPresent ? kernel : undefined),
		activeCellId: () => state.activeCell,
		stopActive: async () => {
			const cell = state.activeCell;
			state.activeCell = undefined;
			state.calls.push(`stopActive:${cell ?? "none"}`);
			return cell;
		},
		liveBindings: async () => new Set(state.live),
		checkpoint: async (excludeNames?: ReadonlySet<string>, pins?: ProjectStatePinUpdate) => {
			state.calls.push(
				`checkpoint:${[...(excludeNames ?? [])].sort().join("|")}:${pins ? `${pins.pinned}:${pins.names.join("|")}` : ""}`,
			);
			if (pins && state.commitError) throw state.commitError;
		},
		retainedBindings: () => state.retained,
		promoteBindings: async (names) => {
			state.calls.push(`promote:${names.join("|")}`);
			return async () => void state.calls.push(`undoPromote:${names.join("|")}`);
		},
		markChanged: () => void state.calls.push("markChanged"),
		restart: async () => {
			state.calls.push("restart");
			return "Project notebook restored 1 value";
		},
		metadata: () => ({
			userCells: 3,
			startedAt: Date.parse("2026-08-16T00:00:00.000Z"),
			checkpoint: { dirty: false, projectGeneration: "gen-1", projectBindings: state.retained.length },
		}),
	};

	const profiles = {
		list: (query?: string) => ({ message: `list:${query ?? ""}`, details: { query } }),
		save: async (name: string) => ({ message: `save:${name}`, details: {} }),
		load: async (name: string) => ({ message: `load:${name}`, details: {} }),
	} as unknown as NotebookProfileController;
	const recovery = {
		diagnostics: async () => ({ message: "diagnostics", details: {} }),
		reset: async () => ({ message: "reset", details: {} }),
	} as unknown as NotebookRecoveryController;

	// The host closes over `state`, so the harness must be that same object, never a copy of it.
	return Object.assign(state, { controller: new NotebookLifecycleController(host, profiles, recovery) });
}

function details(result: NotebookControlResult): Record<string, unknown> {
	return result.details;
}

it("routes list, diagnostics, and reset without starting a kernel", async () => {
	const state = harness();
	expect((await state.controller.control({ action: "list", query: "a*" })).message).toBe("list:a*");
	expect((await state.controller.control({ action: "diagnostics" })).message).toBe("diagnostics");
	expect((await state.controller.control({ action: "reset" })).message).toBe("reset");
	expect(state.calls).toEqual([]);
});

it("prepares the kernel before save and load and passes the name through", async () => {
	const state = harness();
	expect((await state.controller.control({ action: "save", name: "work" })).message).toBe("save:work");
	expect((await state.controller.control({ action: "load", name: "work" })).message).toBe("load:work");
	expect(state.calls).toEqual(["prepare", "prepare"]);
});

it("reports idle status with runtime memory and the retained summary", async () => {
	const state = harness();
	state.live.add("alpha");
	state.retained.push(retained("alpha", 4096, true), retained("beta", 8192, false));
	const result = await state.controller.control({ action: "status" });
	expect(details(result)["state"]).toBe("idle");
	expect(details(result)["userBindings"]).toBe(1);
	expect(details(result)["retainedBytes"]).toBe(12_288);
	expect(details(result)["pinnedBindings"]).toBe(1);
	expect(result.message).toContain("Memory 2.0 KiB heap used / 8.0 KiB limit");
	expect(result.message).toContain("Checkpoint current · project generation gen-1");
	expect(result.message).toContain("Pinned project bindings:");
	expect(result.message).toContain("Largest unpinned retained bindings:");
});

it("reports running status without touching the kernel", async () => {
	const state = harness();
	state.activeCell = "cell-7";
	state.live.add("alpha");
	const result = await state.controller.control({ action: "status" });
	expect(details(result)["state"]).toBe("running");
	expect(details(result)["activeCell"]).toBe("cell-7");
	expect(details(result)["userBindings"]).toBeUndefined();
	expect(state.sources).toEqual([]);
});

it("merges retained metadata into the bindings a status query matched", async () => {
	const state = harness();
	state.live.add("alpha");
	state.live.add("other");
	state.retained.push(retained("alpha", 1024, true));
	const result = await state.controller.control({ action: "status", query: "al*" });
	expect(details(result)["query"]).toBe("al*");
	expect(details(result)["matches"]).toEqual([
		{
			name: "alpha",
			type: "object",
			kind: "value",
			globalProperty: true,
			bytes: 1024,
			updatedAt: expect.any(String),
			pinned: true,
		},
	]);
	expect(result.message).toContain("alpha: value object · 1.0 KiB");
	expect(result.message).toContain("· pinned");
});

it("checkpoints on request and returns the checkpoint metadata", async () => {
	const state = harness();
	const result = await state.controller.control({ action: "checkpoint" });
	expect(result.message).toBe("Notebook checkpoint complete");
	expect(details(result)["projectGeneration"]).toBe("gen-1");
	expect(state.calls).toEqual(["prepare", "checkpoint::"]);
});

it("promotes bindings before it commits a pin", async () => {
	const state = harness();
	state.live.add("alpha");
	state.retained.push(retained("alpha", 512, true));
	const result = await state.controller.control({ action: "pin", names: ["alpha"] });
	expect(result.message).toBe("Pinned durable notebook bindings: alpha");
	expect(state.calls).toEqual(["prepare", "promote:alpha", "checkpoint::true:alpha"]);
	expect(details(result)["bindings"]).toEqual([state.retained[0]]);
});

it("undoes the promotion when the pin commit fails", async () => {
	const state = harness();
	state.live.add("alpha");
	state.commitError = new Error("lock unavailable");
	await expect(state.controller.control({ action: "pin", names: ["alpha"] })).rejects.toThrow("lock unavailable");
	expect(state.calls).toEqual(["prepare", "promote:alpha", "checkpoint::true:alpha", "undoPromote:alpha"]);
});

it("unpins without promoting", async () => {
	const state = harness();
	state.live.add("alpha");
	const result = await state.controller.control({ action: "unpin", names: ["alpha"] });
	expect(result.message).toBe("Unpinned durable notebook bindings: alpha");
	expect(state.calls).toEqual(["prepare", "checkpoint::false:alpha"]);
});

it("refuses to pin a name the kernel does not bind", async () => {
	const state = harness();
	await expect(state.controller.control({ action: "pin", names: ["ghost"] })).rejects.toThrow(
		"Notebook bindings not found or not pinnable: ghost",
	);
	expect(state.calls).toEqual(["prepare"]);
});

it("refuses to pin or release while a cell is running", async () => {
	const state = harness();
	state.activeCell = "cell-7";
	state.live.add("alpha");
	await expect(state.controller.control({ action: "pin", names: ["alpha"] })).rejects.toThrow(
		'Cannot change notebook pins while exec cell "cell-7" is running',
	);
	await expect(state.controller.control({ action: "release", names: ["alpha"] })).rejects.toThrow(
		'Cannot release notebook state while exec cell "cell-7" is running',
	);
});

it("releases a global binding in place and checkpoints the removal", async () => {
	const state = harness();
	state.live.add("alpha");
	const result = await state.controller.control({ action: "release", names: ["alpha"] });
	expect(result.message).toContain("Released notebook bindings: alpha");
	expect(details(result)["restarted"]).toBe(false);
	expect(details(result)["releasedCount"]).toBe(1);
	expect(state.calls).toEqual(["prepare", "markChanged", "checkpoint:alpha:"]);
});

it("restarts the kernel when a released binding is lexical", async () => {
	const state = harness();
	state.live.add("alpha");
	state.lexical.add("alpha");
	const result = await state.controller.control({ action: "release", names: ["alpha"] });
	expect(details(result)["restarted"]).toBe(true);
	expect(result.message).toContain("Kernel restarted to clear lexical bindings");
	expect(state.calls).toEqual(["prepare", "markChanged", "checkpoint:alpha:", "restart"]);
});

it("refuses to release a pinned binding", async () => {
	const state = harness();
	state.live.add("alpha");
	state.retained.push(retained("alpha", 512, true));
	await expect(state.controller.control({ action: "release", names: ["alpha"] })).rejects.toThrow(
		"Pinned notebook bindings cannot be released: alpha; unpin them first",
	);
});

it("reports a binding another session retained as a failure, not a release", async () => {
	const state = harness();
	state.live.add("alpha");
	state.lexical.add("alpha");
	// The restart path never deletes from the fake kernel, so `alpha` is still live afterwards.
	const result = await state.controller.control({ action: "release", names: ["alpha"] });
	expect(details(result)["released"]).toEqual([]);
	expect(details(result)["failures"]).toEqual([
		{ name: "alpha", reason: "concurrent project state retained this binding" },
	]);
});

it("prunes unpinned matches and preserves pinned ones", async () => {
	const state = harness();
	for (const name of ["tmpOne", "tmpTwo", "keep"]) state.live.add(name);
	state.retained.push(retained("tmpTwo", 512, true));
	const result = await state.controller.control({ action: "prune", query: "tmp*" });
	expect(details(result)["query"]).toBe("tmp*");
	expect(details(result)["released"]).toEqual(["tmpOne"]);
	expect(details(result)["protected"]).toEqual(["tmpTwo"]);
	expect(result.message).toContain("Pinned matches preserved: tmpTwo");
	expect(state.live).toEqual(new Set(["tmpTwo", "keep"]));
});

it("reports a prune that matched only pinned bindings without releasing anything", async () => {
	const state = harness();
	state.live.add("tmpOne");
	state.retained.push(retained("tmpOne", 512, true));
	const result = await state.controller.control({ action: "prune", query: "tmp*" });
	expect(result.message).toBe('No unpinned notebook bindings matched "tmp*"; protected: tmpOne');
	expect(details(result)["releasedCount"]).toBe(0);
	expect(state.calls).toEqual(["prepare"]);
});

it("refuses a prune with an empty glob", async () => {
	const state = harness();
	await expect(state.controller.control({ action: "prune", query: "" })).rejects.toThrow(
		"Notebook glob is required; prune never matches everything by default",
	);
});

it("checkpoints before a restart and reports the restore notice", async () => {
	const state = harness();
	state.live.add("alpha");
	const result = await state.controller.control({ action: "restart" });
	expect(result.message).toContain("Notebook kernel restarted from the last completed checkpoint");
	expect(result.message).toContain("Project notebook restored 1 value");
	expect(details(result)["disposed"]).toEqual(["alpha"]);
	expect(state.calls).toEqual(["prepare", "stopActive:none", "checkpoint::", "restart"]);
});

it("skips the checkpoint when a restart terminated a running cell", async () => {
	const state = harness();
	state.activeCell = "cell-7";
	const result = await state.controller.control({ action: "restart" });
	expect(details(result)["terminatedCell"]).toBe("cell-7");
	expect(result.message).toContain("terminated cell-7");
	expect(state.calls).toEqual(["prepare", "stopActive:cell-7", "restart"]);
});

it("disposes nothing when no kernel is running", async () => {
	const state = harness();
	state.kernelPresent = false;
	expect(await state.controller.disposeAll()).toBeUndefined();
});
