import type { AgentToolResult, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent } from "pi-libtui/mouse";

export const NESTED_TOOL_ADAPTER_PROTOCOL = "pi-code-mode/nested-tool-adapters/v2" as const;
export const NESTED_TOOL_ADAPTERS = Symbol.for(NESTED_TOOL_ADAPTER_PROTOCOL);

// type-boundary: Pi tool inputs and details are heterogeneous; each owning tool validates its input and result.
export type NestedToolInput = unknown;
export type NestedToolDetails = unknown;

export type NestedToolKind = "function" | "freeform";

export interface NestedToolScopeEntry {
	name: string;
	description: string;
	parameters?: NestedToolInput;
}

/** Mutable availability inside one hierarchy selected by Code Mode. */
export interface NestedToolScope {
	tools(): readonly NestedToolScopeEntry[];
	active(): readonly string[];
	setActive(names: readonly string[]): void;
}

export interface NestedToolInvocationContext {
	cwd: string;
	toolCallId: string;
	extensionContext: ExtensionContext;
	onUpdate?(result: AgentToolResult<NestedToolDetails>): void;
}

/** Serializable nested state available to the tool that owns its presentation. */
export interface NestedToolPresentationTrace {
	readonly id: string;
	readonly input: NestedToolInput;
	readonly status: "running" | "done" | "error";
	readonly durationMs?: number;
	readonly result?: { readonly content: readonly NestedToolDetails[]; readonly details?: NestedToolDetails };
	readonly error?: string;
}

/** Structural Pi component returned by an owning tool's presentation hook. */
export interface NestedToolPresentationComponent {
	render(width: number): string[];
	invalidate(): void;
	handleInput?(data: string): void;
	handleViewportInput?(data: string): boolean;
	onMouse?(event: TuiMouseEvent): boolean;
	dispose?(): void;
}

export interface NestedToolPresentationContext {
	readonly theme: Theme;
	readonly requestRender: () => void;
	/** False only while restoring transcript history; omission preserves the v2 live-rendering default. */
	readonly executionStarted?: boolean;
	/** Working directory inherited from the outer Code Mode execution. */
	readonly cwd: string;
	/** Stable renderer state shared across updates for this nested call. */
	readonly state: object;
	/** Previous component for this trace, allowing streamed renderers to update in place. */
	readonly lastComponent: NestedToolPresentationComponent | undefined;
}

/** Execution bridge only. pi-code-mode settings own whether this tool is lifted out of Pi's direct tool set. */
export interface NestedToolAdapter {
	name: string;
	kind: NestedToolKind;
	/** Stable capability whose Pi session owns this adapter. Omit only for process-global adapters. */
	owner?: object;
	description?: string;
	parameters?: NestedToolInput;
	outputSchema?: NestedToolInput;
	yieldTimeMs?: number;
	prepareInput?(input: NestedToolInput): NestedToolInput;
	/** Convert the owning tool result into the value returned to nested JavaScript. */
	resultValue?(result: AgentToolResult<NestedToolDetails>): NestedToolDetails;
	/** Render this tool semantically when it runs inside Code Mode. */
	renderTrace?(
		trace: NestedToolPresentationTrace,
		context: NestedToolPresentationContext,
	): NestedToolPresentationComponent | undefined;
	/** Stable identity shared by calls that update one transcript presentation. */
	presentationKey?(trace: NestedToolPresentationTrace): string | undefined;
	onScopeChange?(scope: NestedToolScope | undefined): void;
	invoke(
		input: NestedToolInput,
		context: NestedToolInvocationContext,
		signal: AbortSignal,
	): AgentToolResult<NestedToolDetails> | Promise<AgentToolResult<NestedToolDetails>>;
}

interface AdapterMap {
	get(name: string): NestedToolAdapter | undefined;
	set(name: string, adapter: NestedToolAdapter): AdapterMap;
	delete(name: string): boolean;
	values(): IterableIterator<NestedToolAdapter>;
}

export interface NestedToolAdapterRegistry {
	readonly protocol: typeof NESTED_TOOL_ADAPTER_PROTOCOL;
	readonly version: 2;
	readonly adapters: AdapterMap;
	claim(scope: object | symbol): void;
	list(scope?: object | symbol): NestedToolAdapter[];
	register(adapter: NestedToolAdapter): () => void;
}

// type-boundary: Symbol.for can contain a value from another extension realm; this validator narrows the public capability.
type UntrustedRegistryValue = unknown;

function isRegistry(value: UntrustedRegistryValue): value is NestedToolAdapterRegistry {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<NestedToolAdapterRegistry>;
	const adapters = candidate.adapters as Partial<AdapterMap> | undefined;
	return (
		candidate.protocol === NESTED_TOOL_ADAPTER_PROTOCOL &&
		candidate.version === 2 &&
		typeof candidate.register === "function" &&
		typeof candidate.claim === "function" &&
		typeof candidate.list === "function" &&
		typeof adapters?.get === "function" &&
		typeof adapters?.set === "function" &&
		typeof adapters?.delete === "function" &&
		typeof adapters?.values === "function"
	);
}

function validateAdapter(adapter: NestedToolAdapter): void {
	if (!adapter || typeof adapter !== "object") throw new Error("Code Mode tool adapter must be an object");
	if (!adapter.name.trim()) throw new Error("Code Mode tool adapter requires a name");
	if (adapter.kind !== "function" && adapter.kind !== "freeform") {
		throw new Error(`Code Mode tool adapter ${adapter.name} has an invalid kind`);
	}
	if (adapter.kind === "function" && !adapter.parameters) {
		throw new Error(`Code Mode tool adapter ${adapter.name} requires parameters`);
	}
	if (typeof adapter.invoke !== "function") throw new Error(`Code Mode tool adapter ${adapter.name} requires invoke`);
	if (adapter.resultValue !== undefined && typeof adapter.resultValue !== "function") {
		throw new Error(`Code Mode tool adapter ${adapter.name} has an invalid resultValue`);
	}
	if (adapter.renderTrace !== undefined && typeof adapter.renderTrace !== "function") {
		throw new Error(`Code Mode tool adapter ${adapter.name} has an invalid renderTrace`);
	}
	if (adapter.presentationKey !== undefined && typeof adapter.presentationKey !== "function") {
		throw new Error(`Code Mode tool adapter ${adapter.name} has an invalid presentationKey`);
	}
}

function createRegistry(): NestedToolAdapterRegistry {
	const adapters = new Map<string, NestedToolAdapter>();
	const registrations: NestedToolAdapter[] = [];
	const scopes = new WeakMap<object, object | symbol>();
	return {
		protocol: NESTED_TOOL_ADAPTER_PROTOCOL,
		version: 2,
		adapters,
		claim(scope) {
			for (const adapter of registrations) {
				if (adapter.owner && !scopes.has(adapter.owner)) scopes.set(adapter.owner, scope);
			}
		},
		list(scope) {
			if (!scope) return [...adapters.values()];
			const global = new Map<string, NestedToolAdapter>();
			const scoped = new Map<string, NestedToolAdapter>();
			for (const adapter of registrations) {
				if (!adapter.owner) global.set(adapter.name, adapter);
				else if (scopes.get(adapter.owner) === scope) scoped.set(adapter.name, adapter);
			}
			return [...new Set([...global.keys(), ...scoped.keys()])].flatMap((name) => {
				const adapter = scoped.get(name) ?? global.get(name);
				return adapter ? [adapter] : [];
			});
		},
		register(adapter) {
			validateAdapter(adapter);
			registrations.push(adapter);
			adapters.set(adapter.name, adapter);
			return () => {
				const index = registrations.lastIndexOf(adapter);
				if (index >= 0) registrations.splice(index, 1);
				if (adapters.get(adapter.name) !== adapter) return;
				let replacement: NestedToolAdapter | undefined;
				for (let candidate = registrations.length - 1; candidate >= 0; candidate -= 1) {
					if (registrations[candidate]?.name !== adapter.name) continue;
					replacement = registrations[candidate];
					break;
				}
				if (replacement) adapters.set(adapter.name, replacement);
				else adapters.delete(adapter.name);
			};
		},
	};
}

export function getNestedToolAdapterRegistry(scope: typeof globalThis = globalThis): NestedToolAdapterRegistry {
	const slots = scope as Record<PropertyKey, UntrustedRegistryValue>;
	const existing = slots[NESTED_TOOL_ADAPTERS];
	if (isRegistry(existing)) return existing;
	const registry = createRegistry();
	slots[NESTED_TOOL_ADAPTERS] = registry;
	return registry;
}

export function registerNestedToolAdapter(adapter: NestedToolAdapter): () => void {
	return getNestedToolAdapterRegistry().register(adapter);
}

export function claimNestedToolAdapters(scope: object | symbol): void {
	getNestedToolAdapterRegistry().claim(scope);
}

export function listNestedToolAdapters(scope?: object | symbol): NestedToolAdapter[] {
	return getNestedToolAdapterRegistry().list(scope);
}
