/**
 * The Deno source the lifecycle actions inject, and the parser for what comes back.
 *
 * Every generated block prints one line: a marker, then JSON. The marker exists because a cell may
 * print anything else, so a bare JSON line is not identifiable. `parseNotebookRuntimeResult` takes
 * the first line after the marker.
 *
 * A name reaches these builders as raw source text. `assertIdentifiers` is the trust boundary.
 */

import type { NotebookExecutionResult } from "./project-state-format.ts";

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export interface NotebookMemoryUsage {
	heapUsedBytes: number;
	heapTotalBytes: number;
	heapLimitBytes: number;
	rssBytes: number;
	externalBytes: number;
}

export interface NotebookBindingStatus {
	name: string;
	type: string;
	/** Not named `constructor`: that key resolves through `Object.prototype` even when absent. */
	constructorName?: string | undefined;
	/** `runtime-only` bindings cannot be serialized, so a checkpoint cannot carry them. */
	kind: "value" | "definition" | "runtime-only";
	disposable?: "sync" | "async" | undefined;
	/** `false` means the binding is lexical, so `delete globalThis[name]` cannot remove it. */
	globalProperty: boolean;
}

export interface NotebookKernelStatus {
	memory: NotebookMemoryUsage;
	bindings: NotebookBindingStatus[];
}

export interface NotebookReleaseResult {
	released: string[];
	disposed: string[];
	failures: Array<{ name: string; reason: string }>;
}

export function isIdentifier(name: string): boolean {
	return IDENTIFIER.test(name);
}

export function assertIdentifiers(names: readonly string[]): void {
	const invalid = names.filter((name) => !IDENTIFIER.test(name));
	if (invalid.length > 0) throw new Error(`Notebook binding name is not an identifier: ${invalid.join(", ")}`);
}

/**
 * Every top-level `globalThis` property.
 *
 * A cell's `let` and `const` bind in the kernel's global lexical scope, which no JavaScript API
 * enumerates; only Jupyter's `complete_request` reports them, and the host client that speaks it
 * sits behind `NotebookCellKernel`.
 */
export function notebookTopLevelNamesSource(marker: string): string {
	return `console.log(${JSON.stringify(marker)} + JSON.stringify(Object.getOwnPropertyNames(globalThis))); undefined;`;
}

export function notebookStatusSource(names: readonly string[], marker: string): string {
	assertIdentifiers(names);
	const inspections = names
		.map(
			(name) => `
	try {
		const __value = ${name};
		let __kind = "value";
		let __disposable;
		if (__value !== null && (typeof __value === "object" || typeof __value === "function")) {
			if (typeof __descriptorValue(__value, Symbol.asyncDispose) === "function") __disposable = "async";
			else if (typeof __descriptorValue(__value, Symbol.dispose) === "function") __disposable = "sync";
		}
		if (__disposable || __value instanceof Promise || __value instanceof WeakMap || __value instanceof WeakSet) {
			__kind = "runtime-only";
		} else if (typeof __value === "function") {
			__kind = Function.prototype.toString.call(__value).includes("[native code]") ? "runtime-only" : "definition";
		} else if (__value && __descriptorValue(__value, Symbol.toStringTag) === "Module") {
			__kind = "runtime-only";
		}
		__bindings.push({
			name: ${JSON.stringify(name)},
			type: typeof __value,
			kind: __kind,
			globalProperty: Object.prototype.hasOwnProperty.call(globalThis, ${JSON.stringify(name)}),
			...(__value === null || __value === undefined ? {} : { constructorName: __value.constructor?.name }),
			...(__disposable ? { disposable: __disposable } : {}),
		});
	} catch (__error) {
		__bindings.push({ name: ${JSON.stringify(name)}, type: "unavailable", kind: "runtime-only", globalProperty: false });
	}`,
		)
		.join("");
	return `{
	const { getHeapStatistics } = await import("node:v8");
	const __descriptorValue = (__value, __key) => {
		let __current = __value;
		while (__current !== null && __current !== undefined) {
			const __descriptor = Object.getOwnPropertyDescriptor(__current, __key);
			if (__descriptor) return __descriptor.value;
			__current = Object.getPrototypeOf(__current);
		}
		return undefined;
	};
	const __bindings = [];${inspections}
	const __memory = Deno.memoryUsage();
	console.log(${JSON.stringify(marker)} + JSON.stringify({
		memory: {
			heapUsedBytes: __memory.heapUsed,
			heapTotalBytes: __memory.heapTotal,
			heapLimitBytes: getHeapStatistics().heap_size_limit,
			rssBytes: __memory.rss,
			externalBytes: __memory.external,
		},
		bindings: __bindings,
	}));
	undefined;
}`;
}

/** Disposes and then deletes each name. Release is what the `release` and `prune` actions run. */
export function notebookReleaseSource(names: readonly string[], marker: string): string {
	return notebookDisposalSource(names, marker, true);
}

/** Disposes each name and keeps it bound. Restart runs this, because the kernel dies anyway. */
export function notebookDisposeSource(names: readonly string[], marker: string): string {
	return notebookDisposalSource(names, marker, false);
}

function notebookDisposalSource(names: readonly string[], marker: string, remove: boolean): string {
	assertIdentifiers(names);
	const releases = names
		.map(
			(name) => `
	try {
		const __value = ${name};
		if (__value !== null && (typeof __value === "object" || typeof __value === "function") && !__seen.has(__value)) {
			__seen.add(__value);
			if (typeof __value[Symbol.asyncDispose] === "function") {
				await __value[Symbol.asyncDispose]();
				__disposed.push(${JSON.stringify(name)});
			} else if (typeof __value[Symbol.dispose] === "function") {
				__value[Symbol.dispose]();
				__disposed.push(${JSON.stringify(name)});
			}
		}${
			remove
				? `
		if (!delete globalThis[${JSON.stringify(name)}]) throw new Error("binding is not configurable");
		__released.push(${JSON.stringify(name)});`
				: ""
		}
	} catch (__error) {
		__failures.push({ name: ${JSON.stringify(name)}, reason: String(__error instanceof Error ? __error.message : __error).slice(0, 240) });
	}`,
		)
		.join("");
	return `{
	const __seen = new WeakSet();
	const __released = [];
	const __disposed = [];
	const __failures = [];${releases}
	console.log(${JSON.stringify(marker)} + JSON.stringify({ released: __released, disposed: __disposed, failures: __failures }));
	undefined;
}`;
}

export function parseNotebookRuntimeResult<T>(result: NotebookExecutionResult, marker: string): T {
	if (result.status !== "ok") throw new Error(result.errorText ?? "Notebook lifecycle operation failed");
	const output = result.output ?? "";
	const start = output.indexOf(marker);
	if (start === -1) throw new Error("Notebook lifecycle operation returned no result");
	const line = output.slice(start + marker.length).split("\n", 1)[0] ?? "";
	try {
		return JSON.parse(line) as T;
	} catch {
		throw new Error("Notebook lifecycle operation returned an invalid result");
	}
}
