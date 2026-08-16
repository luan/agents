import { afterEach, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildToolCatalog } from "../code-mode/nested-dispatch.ts";
import {
	getRegisteredTool,
	getRegisteredTools,
	getToolPresentation,
	registerTool,
	resetToolRegistry,
	toolRegistrarFor,
	trackingApi,
	trackTool,
} from "./tool-registry.ts";

const EXTENSIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

afterEach(resetToolRegistry);

// context7-renderer.ts registered through pi alone, so its 3 tools sat outside `buildToolCatalog()` and no cell could call them.
it("keeps a package extension's own pi.registerTool inside the catalog", async () => {
	const seenByPi: string[] = [];
	const pi = { registerTool: (tool: { name: string }) => seenByPi.push(tool.name) } as never;

	const packageFactory = (api: { registerTool: (tool: unknown) => void }) => {
		api.registerTool({ name: "probe_package_tool", description: "probe", execute: () => ({ content: [] }) });
	};
	packageFactory(trackingApi(pi));

	expect(seenByPi).toEqual(["probe_package_tool"]);
	expect(buildToolCatalog().map((entry) => entry.name)).toContain("probe_package_tool");
});

it("keeps execution and presentation separate while direct calls stay session-bound", async () => {
	let direct: any;
	registerTool(
		{
			registerTool(definition: never) {
				direct = definition;
			},
		},
		{
			name: "probe_split_tool",
			execute: async () => "first",
			renderShell: "self",
			renderCall: () => "card",
			emptyRenderIsFinal: true,
		},
	);

	const execution = getRegisteredTool("probe_split_tool");
	const presentation = getToolPresentation("probe_split_tool");
	expect(execution?.renderCall).toBeUndefined();
	expect(presentation?.renderCall).toBeFunction();
	expect(presentation?.emptyRenderIsFinal).toBeTrue();

	if (!execution) throw new Error("missing execution");
	execution.execute = async () => "second";
	expect(await direct.execute()).toBe("first");
});

it("keeps direct executors bound to their session registration", async () => {
	let rootTool: any;
	let childTool: any;
	registerTool(
		{ registerTool: (definition: never) => (rootTool = definition) },
		{ name: "probe_session_tool", execute: async () => "root" },
	);
	registerTool(
		{ registerTool: (definition: never) => (childTool = definition) },
		{ name: "probe_session_tool", execute: async () => "child" },
	);

	expect(await rootTool.execute()).toBe("root");
	expect(await childTool.execute()).toBe("child");
	expect(await getRegisteredTool("probe_session_tool")?.execute()).toBe("child");
});

it("keeps nested registry lookup bound to the calling session", async () => {
	const fakePi = () => {
		const hooks = new Map<string, (...args: any[]) => void>();
		const tools = new Map<string, any>();
		return {
			hooks,
			tools,
			on: (name: string, handler: (...args: any[]) => void) => hooks.set(name, handler),
			registerTool: (definition: any) => tools.set(definition.name, definition),
		};
	};
	const root = fakePi();
	const child = fakePi();
	const rootRegister = toolRegistrarFor(root as never);
	const childRegister = toolRegistrarFor(child as never);
	rootRegister({ name: "probe_nested_target", execute: async () => "root" } as never);
	rootRegister({
		name: "probe_nested_caller",
		execute: async () => await getRegisteredTool("probe_nested_target")?.execute(),
	} as never);
	childRegister({ name: "probe_nested_target", execute: async () => "child" } as never);
	childRegister({
		name: "probe_child_only",
		execute: async () => "child-only",
		renderCall: () => "child-card",
	} as never);
	rootRegister({
		name: "probe_missing_caller",
		execute: async () => ({
			execution: getRegisteredTool("probe_child_only"),
			presentation: getToolPresentation("probe_child_only"),
		}),
	} as never);
	root.hooks.get("session_start")?.({}, { sessionManager: { getSessionId: () => "root-session" } });
	child.hooks.get("session_start")?.({}, { sessionManager: { getSessionId: () => "child-session" } });

	const rootCaller = root.tools.get("probe_nested_caller");
	expect(
		await rootCaller.execute("call", {}, new AbortController().signal, undefined, {
			sessionManager: { getSessionId: () => "root-session" },
		}),
	).toBe("root");
	const rootMissingCaller = root.tools.get("probe_missing_caller");
	expect(
		await rootMissingCaller.execute("call", {}, new AbortController().signal, undefined, {
			sessionManager: { getSessionId: () => "root-session" },
		}),
	).toEqual({ execution: undefined, presentation: undefined });
});

it("merges every extension contribution for one session and removes only the stopped extension", () => {
	const makePi = () => {
		const hooks = new Map<string, (...args: any[]) => void>();
		return {
			on: (name: string, handler: (...args: any[]) => void) => hooks.set(name, handler),
			registerTool() {},
			hooks,
		};
	};
	const first = makePi();
	const second = makePi();
	toolRegistrarFor(first as never)({ name: "probe_first", execute: async () => "first" } as never);
	toolRegistrarFor(second as never)({ name: "probe_second", execute: async () => "second" } as never);
	first.hooks.get("session_start")?.({}, { sessionManager: { getSessionId: () => "shared-session" } });
	second.hooks.get("session_start")?.({}, { sessionManager: { getSessionId: () => "shared-session" } });

	expect([...getRegisteredTools("shared-session").keys()].sort()).toEqual(["probe_first", "probe_second"]);
	second.hooks.get("session_shutdown")?.({}, { sessionManager: { getSessionId: () => "shared-session" } });
	expect(getRegisteredTool("probe_first", "shared-session")).toBeDefined();
	expect(getRegisteredTool("probe_second", "shared-session")).toBeUndefined();
});

it("includes tracked built-ins in every active session without using them as a cross-session fallback", () => {
	trackTool({ name: "probe_tracked", execute: async () => "tracked" } as never);
	const hooks = new Map<string, (...args: any[]) => void>();
	const pi = {
		on: (name: string, handler: (...args: any[]) => void) => hooks.set(name, handler),
		registerTool() {},
	};
	toolRegistrarFor(pi as never)({ name: "probe_session", execute: async () => "session" } as never);
	hooks.get("session_start")?.({}, { sessionManager: { getSessionId: () => "tracked-session" } });

	expect(getRegisteredTool("probe_tracked", "tracked-session")).toBeDefined();
	expect(buildToolCatalog("tracked-session").map((entry) => entry.name)).toContain("probe_tracked");
	hooks.get("session_shutdown")?.({}, { sessionManager: { getSessionId: () => "tracked-session" } });
	expect(getRegisteredTool("probe_tracked", "tracked-session")).toBeUndefined();
});

// A registration that skips shared/tool-registry.ts is invisible until a model needs the tool, so the sweep is static.
it("routes every registration site through the shared registry", () => {
	const bypassing: string[] = [];
	for (const entry of readdirSync(EXTENSIONS_DIR, { recursive: true })) {
		const relativePath = String(entry);
		if (!relativePath.endsWith(".ts") || relativePath.endsWith(".test.ts")) continue;
		const source = readFileSync(join(EXTENSIONS_DIR, relativePath), "utf8");
		if (!/\w+\.registerTool\(/.test(source)) continue;
		if (/trackTool|trackingApi|toolRegistrarFor|loadPackageExtension/.test(source)) continue;
		bypassing.push(relativePath);
	}

	expect(bypassing).toEqual([]);
});
