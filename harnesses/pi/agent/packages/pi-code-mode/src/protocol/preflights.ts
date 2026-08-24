import type { NestedToolPreflight, NestedToolPreflightCall } from "./types.ts";

export const NESTED_TOOL_PREFLIGHT_PROTOCOL = "pi-code-mode/nested-tool-preflights/v1" as const;
export const NESTED_TOOL_PREFLIGHTS = Symbol.for(NESTED_TOOL_PREFLIGHT_PROTOCOL);

export interface NestedToolPreflightRegistry {
	protocol: typeof NESTED_TOOL_PREFLIGHT_PROTOCOL;
	version: 1;
	guards: NestedToolPreflight[];
	register(guard: NestedToolPreflight): () => void;
}

type RegistryGlobal = typeof globalThis & { [NESTED_TOOL_PREFLIGHTS]?: unknown };

function isRegistry(value: unknown): value is NestedToolPreflightRegistry {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<NestedToolPreflightRegistry>;
	return (
		candidate.protocol === NESTED_TOOL_PREFLIGHT_PROTOCOL &&
		candidate.version === 1 &&
		Array.isArray(candidate.guards) &&
		typeof candidate.register === "function"
	);
}

function createRegistry(): NestedToolPreflightRegistry {
	const guards: NestedToolPreflight[] = [];
	return {
		protocol: NESTED_TOOL_PREFLIGHT_PROTOCOL,
		version: 1,
		guards,
		register(guard) {
			if (typeof guard !== "function") throw new Error("Nested tool preflight must be a function");
			guards.push(guard);
			return () => {
				const index = guards.indexOf(guard);
				if (index >= 0 && guards[index] === guard) guards.splice(index, 1);
			};
		},
	};
}

export function getNestedToolPreflightRegistry(): NestedToolPreflightRegistry {
	const root = globalThis as RegistryGlobal;
	if (isRegistry(root[NESTED_TOOL_PREFLIGHTS])) return root[NESTED_TOOL_PREFLIGHTS];
	const registry = createRegistry();
	root[NESTED_TOOL_PREFLIGHTS] = registry;
	return registry;
}

export function registerNestedToolPreflight(guard: NestedToolPreflight): () => void {
	return getNestedToolPreflightRegistry().register(guard);
}

export async function runNestedToolPreflights(call: NestedToolPreflightCall): Promise<void> {
	for (const guard of [...getNestedToolPreflightRegistry().guards]) {
		call.signal.throwIfAborted();
		const snapshot = Object.freeze({
			...call,
			input: freezeInput(structuredClone(call.input)),
		});
		const pending = Promise.resolve().then(() => guard(snapshot));
		void pending.catch(() => undefined);
		const result = await raceAbort(pending, call.signal);
		call.signal.throwIfAborted();
		if (result?.block === true) throw new Error(result.reason.trim() || `Nested tool blocked: ${call.toolName}`);
	}
}

async function raceAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
	let abort = () => {};
	const aborted = new Promise<never>((_resolve, reject) => {
		abort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("Nested tool aborted"));
		signal.addEventListener("abort", abort, { once: true });
	});
	try {
		return await Promise.race([pending, aborted]);
	} finally {
		signal.removeEventListener("abort", abort);
	}
}

function freezeInput(value: unknown): unknown {
	if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
	for (const item of Array.isArray(value) ? value : Object.values(value)) freezeInput(item);
	return Object.freeze(value);
}
