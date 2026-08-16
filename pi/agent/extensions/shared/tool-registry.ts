import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { activeSessionId, runInSession, sessionIdFromContext } from "./session-context.ts";

export interface NestedRecordedEntry {
	customType: string;
	data?: unknown;
}

export interface NestedResultDefinition {
	details?: unknown;
	projectDetails?: (input: { details: unknown; text: string; args: unknown }) => unknown;
	recordEntry?: (input: { details: unknown; text: string; args: unknown }) => NestedRecordedEntry | undefined;
}

export interface RegisteredToolDefinition {
	name: string;
	description?: string;
	parameters?: unknown;
	/** Model-facing result metadata for calls made from a code-mode cell. */
	nestedResult?: NestedResultDefinition;
	/** pi's compatibility shim for raw arguments, applied before schema validation (agent-loop.js:380). */
	prepareArguments?: (args: unknown) => unknown;
	execute: (...args: never[]) => unknown;
	[key: string | symbol]: unknown;
}

export interface ToolPresentationDefinition {
	renderShell?: unknown;
	renderCall?: (...args: never[]) => unknown;
	renderResult?: (...args: never[]) => unknown;
	/** A renderer that draws nothing means no row. */
	emptyRenderIsFinal?: boolean;
	/** A card that states its own failure, so Code Mode does not repeat it. */
	rendersOwnFailure?: boolean;
}

export interface ToolRegistrar {
	registerTool(definition: never): void;
}

/** Nested calls have no pi row, so code-mode drives `renderCall` (render.ts:356) and `renderResult` (render.ts:372) itself on a fabricated context. */
export interface NestedRenderContext {
	nestedDetails?: Record<string, unknown>;
	nestedError?: string;
}

export function nestedRenderDetails(context: unknown): Record<string, unknown> | undefined {
	const details = (context as NestedRenderContext | undefined)?.nestedDetails;
	return details && typeof details === "object" ? details : undefined;
}

export function nestedRenderError(context: unknown): string | undefined {
	const error = (context as NestedRenderContext | undefined)?.nestedError;
	return typeof error === "string" && error ? error : undefined;
}

// Each extension has a separate jiti cache, so registries live on globalThis.
const TOOL_EXECUTION_REGISTRY = Symbol.for("agents.toolRegistry.execution");
const TOOL_PRESENTATION_REGISTRY = Symbol.for("agents.toolRegistry.presentation");
const TOOL_TRACKED_EXECUTION_REGISTRY = Symbol.for("agents.toolRegistry.trackedExecutions");
const TOOL_TRACKED_PRESENTATION_REGISTRY = Symbol.for("agents.toolRegistry.trackedPresentations");
const TOOL_SESSION_REGISTRIES = Symbol.for("agents.toolRegistry.sessionRegistries");
const TOOL_API_REGISTRIES = Symbol.for("agents.toolRegistry.apiRegistries");

type ApiRegistry = {
	executions: Map<string, RegisteredToolDefinition>;
	presentations: Map<string, ToolPresentationDefinition>;
	sessionId?: string;
};

type SessionRegistry = {
	executions: Map<string, RegisteredToolDefinition>;
	presentations: Map<string, ToolPresentationDefinition>;
	contributors: Map<ApiRegistry, true>;
};

const globalState = globalThis as typeof globalThis & {
	[TOOL_EXECUTION_REGISTRY]?: Map<string, RegisteredToolDefinition>;
	[TOOL_PRESENTATION_REGISTRY]?: Map<string, ToolPresentationDefinition>;
	[TOOL_TRACKED_EXECUTION_REGISTRY]?: Map<string, RegisteredToolDefinition>;
	[TOOL_TRACKED_PRESENTATION_REGISTRY]?: Map<string, ToolPresentationDefinition>;
	[TOOL_SESSION_REGISTRIES]?: Map<string, SessionRegistry>;
	[TOOL_API_REGISTRIES]?: WeakMap<object, ApiRegistry>;
};
const EXECUTIONS = globalState[TOOL_EXECUTION_REGISTRY] ?? new Map<string, RegisteredToolDefinition>();
const PRESENTATIONS = globalState[TOOL_PRESENTATION_REGISTRY] ?? new Map<string, ToolPresentationDefinition>();
const TRACKED_EXECUTIONS = globalState[TOOL_TRACKED_EXECUTION_REGISTRY] ?? new Map<string, RegisteredToolDefinition>();
const TRACKED_PRESENTATIONS =
	globalState[TOOL_TRACKED_PRESENTATION_REGISTRY] ?? new Map<string, ToolPresentationDefinition>();
const SESSION_REGISTRIES = globalState[TOOL_SESSION_REGISTRIES] ?? new Map<string, SessionRegistry>();
const API_REGISTRIES = globalState[TOOL_API_REGISTRIES] ?? new WeakMap<object, ApiRegistry>();
globalState[TOOL_EXECUTION_REGISTRY] = EXECUTIONS;
globalState[TOOL_PRESENTATION_REGISTRY] = PRESENTATIONS;
globalState[TOOL_TRACKED_EXECUTION_REGISTRY] = TRACKED_EXECUTIONS;
globalState[TOOL_TRACKED_PRESENTATION_REGISTRY] = TRACKED_PRESENTATIONS;
globalState[TOOL_SESSION_REGISTRIES] = SESSION_REGISTRIES;
globalState[TOOL_API_REGISTRIES] = API_REGISTRIES;

const EMPTY_REGISTRY = new Map<string, RegisteredToolDefinition>();
function rebuildSession(sessionId: string): void {
	const session = SESSION_REGISTRIES.get(sessionId);
	if (!session) return;
	session.executions.clear();
	session.presentations.clear();
	for (const [name, definition] of TRACKED_EXECUTIONS) session.executions.set(name, definition);
	for (const [name, presentation] of TRACKED_PRESENTATIONS) session.presentations.set(name, presentation);
	for (const registry of session.contributors.keys()) {
		for (const [name, definition] of registry.executions) session.executions.set(name, definition);
		for (const [name, presentation] of registry.presentations) session.presentations.set(name, presentation);
	}
}

function bindRegistry(registry: ApiRegistry, sessionId: string): void {
	if (registry.sessionId && registry.sessionId !== sessionId) unbindRegistry(registry, registry.sessionId);
	registry.sessionId = sessionId;
	let session = SESSION_REGISTRIES.get(sessionId);
	if (!session) {
		session = { executions: new Map(), presentations: new Map(), contributors: new Map() };
		SESSION_REGISTRIES.set(sessionId, session);
	}
	session.contributors.set(registry, true);
	rebuildSession(sessionId);
}

function unbindRegistry(registry: ApiRegistry, sessionId: string): void {
	const session = SESSION_REGISTRIES.get(sessionId);
	if (!session) {
		if (registry.sessionId === sessionId) registry.sessionId = undefined;
		return;
	}
	session.contributors.delete(registry);
	if (session.contributors.size === 0) SESSION_REGISTRIES.delete(sessionId);
	else rebuildSession(sessionId);
	if (registry.sessionId === sessionId) registry.sessionId = undefined;
}

function apiRegistry(api: ToolRegistrar): ApiRegistry | undefined {
	if (!api || typeof api !== "object") return undefined;
	const key = api as object;
	const existing = API_REGISTRIES.get(key);
	if (existing) return existing;
	const registry: ApiRegistry = { executions: new Map(), presentations: new Map() };
	const on = (api as { on?: (event: string, handler: (...args: any[]) => void) => void }).on;
	if (typeof on !== "function") return undefined;
	API_REGISTRIES.set(key, registry);
	on.call(api, "session_start", (_event: unknown, ctx: unknown) => {
		const sessionId = sessionIdFromContext(ctx);
		if (sessionId) bindRegistry(registry, sessionId);
	});
	on.call(api, "session_shutdown", (_event: unknown, ctx: unknown) => {
		const sessionId = sessionIdFromContext(ctx) ?? registry.sessionId;
		if (sessionId) unbindRegistry(registry, sessionId);
	});
	return registry;
}

function splitTool(
	definition: RegisteredToolDefinition & ToolPresentationDefinition,
	registry?: ApiRegistry,
): RegisteredToolDefinition {
	const { renderShell, renderCall, renderResult, emptyRenderIsFinal, rendersOwnFailure, ...execution } = definition;
	const presentation = { renderShell, renderCall, renderResult, emptyRenderIsFinal, rendersOwnFailure };
	const hasPresentation = Object.values(presentation).some((value) => value !== undefined);
	if (hasPresentation) PRESENTATIONS.set(definition.name, presentation);
	else PRESENTATIONS.delete(definition.name);
	EXECUTIONS.set(definition.name, execution as RegisteredToolDefinition);
	if (registry) {
		registry.executions.set(definition.name, execution as RegisteredToolDefinition);
		if (hasPresentation) registry.presentations.set(definition.name, presentation);
		else registry.presentations.delete(definition.name);
		if (registry.sessionId) rebuildSession(registry.sessionId);
	}
	return execution as RegisteredToolDefinition;
}

function piTool(
	definition: RegisteredToolDefinition & ToolPresentationDefinition,
	registry?: ApiRegistry,
): RegisteredToolDefinition {
	const execution = splitTool(definition, registry);
	const execute = execution.execute;
	const presentation = PRESENTATIONS.get(definition.name);
	return {
		...execution,
		...presentation,
		execute: ((...args: never[]) =>
			runInSession(args[4], () => execute(...args))) as RegisteredToolDefinition["execute"],
	};
}

function rememberTracked(definition: RegisteredToolDefinition & ToolPresentationDefinition): void {
	const execution = splitTool(definition);
	TRACKED_EXECUTIONS.set(definition.name, execution);
	const presentation = PRESENTATIONS.get(definition.name);
	if (presentation) TRACKED_PRESENTATIONS.set(definition.name, presentation);
	else TRACKED_PRESENTATIONS.delete(definition.name);
	for (const sessionId of SESSION_REGISTRIES.keys()) rebuildSession(sessionId);
}

export function registerTool<T extends RegisteredToolDefinition & ToolPresentationDefinition>(
	api: ToolRegistrar,
	definition: T,
): T {
	const registry = apiRegistry(api);
	const registered = piTool(definition, registry);
	if (!registry) rememberTracked(definition);
	(api.registerTool as (d: RegisteredToolDefinition) => void)(registered);
	return definition;
}

export function trackTool<T extends RegisteredToolDefinition & ToolPresentationDefinition>(definition: T): T {
	rememberTracked(definition);
	return definition;
}

export function getRegisteredTool(name: string, sessionId = activeSessionId()): RegisteredToolDefinition | undefined {
	if (sessionId) return SESSION_REGISTRIES.get(sessionId)?.executions.get(name);
	return EXECUTIONS.get(name);
}

export function getRegisteredTools(sessionId = activeSessionId()): ReadonlyMap<string, RegisteredToolDefinition> {
	if (sessionId) return SESSION_REGISTRIES.get(sessionId)?.executions ?? EMPTY_REGISTRY;
	return EXECUTIONS;
}

export function getToolPresentation(
	name: string,
	sessionId = activeSessionId(),
): ToolPresentationDefinition | undefined {
	if (sessionId) return SESSION_REGISTRIES.get(sessionId)?.presentations.get(name);
	return PRESENTATIONS.get(name);
}

export function listRegisteredToolNames(sessionId = activeSessionId()): string[] {
	return [...getRegisteredTools(sessionId).keys()].sort();
}

/** Drop everything. Tests only — a live session never unregisters. */
export function resetToolRegistry(): void {
	EXECUTIONS.clear();
	PRESENTATIONS.clear();
	TRACKED_EXECUTIONS.clear();
	TRACKED_PRESENTATIONS.clear();
	SESSION_REGISTRIES.clear();
}

export function toolRegistrarFor(pi: ExtensionAPI): ExtensionAPI["registerTool"] {
	const registry = apiRegistry(pi);
	return ((definition: RegisteredToolDefinition & ToolPresentationDefinition) => {
		if (!registry) rememberTracked(definition);
		pi.registerTool(piTool(definition, registry) as never);
	}) as unknown as ExtensionAPI["registerTool"];
}

export type ToolDecorator = (tool: RegisteredToolDefinition) => RegisteredToolDefinition;

export function trackingApi(pi: ExtensionAPI, decorate?: ToolDecorator): ExtensionAPI {
	const registry = apiRegistry(pi);
	return new Proxy(pi, {
		get(target, property, receiver) {
			if (property !== "registerTool") return Reflect.get(target, property, receiver);
			return (tool: RegisteredToolDefinition & ToolPresentationDefinition) => {
				const definition = decorate ? decorate(tool) : tool;
				if (!registry) rememberTracked(definition);
				(target.registerTool as (d: never) => void)(piTool(definition, registry) as never);
			};
		},
	});
}

// `getAllTools()` carries no `execute` (pi-coding-agent types.d.ts:1137), so a tool pi alone holds is unreachable from a cell.
// The package's own entry needs `"extensions": []` in settings.json, or it loads twice.
export async function loadPackageExtension(
	pi: ExtensionAPI,
	entryPath: string,
	decorate?: ToolDecorator,
): Promise<void> {
	const { createJiti } = await import("jiti");
	const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
	const loaded = (await jiti.import(entryPath)) as { default?: (api: ExtensionAPI) => void | Promise<void> };
	if (typeof loaded.default !== "function") throw new Error(`${entryPath} exports no extension factory`);
	await loaded.default(trackingApi(pi, decorate));
}
