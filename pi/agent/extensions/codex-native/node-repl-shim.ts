import type { CodexAppServerMcpClient } from "./app-server-mcp.ts";

export const NODE_REPL_SERVER = "node_repl";

// The computer-use skill advertised `get_app_state({ app, disableDiff? })` and then asked in prose for the diff.
// One session passed `disableDiff: true` on 26 of 26 calls. Finder through this bridge: full tree 9932 chars,
// diff 149. So `get_app_state` cannot force a full tree, and `get_full_app_state` is the escape hatch.
const SKY_DIFF_SHIM = `(() => {
	let wrapped;
	const wrap = (sky) => {
		if (!sky || typeof sky.get_app_state !== "function" || sky.get_full_app_state) return sky;
		const original = sky.get_app_state.bind(sky);
		const normalize = (input) => (typeof input === "string" ? { app: input } : { ...(input ?? {}) });
		const get_app_state = async (input) => {
			const args = normalize(input);
			const forced = args.disableDiff === true;
			delete args.disableDiff;
			const state = await original(args);
			if (forced && state && typeof state === "object")
				state.note = "disableDiff dropped; this tree is a diff. Use sky.get_full_app_state({ app }) for a full tree.";
			return state;
		};
		const get_full_app_state = (input) => original({ ...normalize(input), disableDiff: true });
		return new Proxy(sky, {
			get: (target, key, receiver) => {
				if (key === "get_app_state") return get_app_state;
				if (key === "get_full_app_state") return get_full_app_state;
				return Reflect.get(target, key, receiver);
			},
			has: (target, key) => key === "get_full_app_state" || Reflect.has(target, key),
		});
	};
	Object.defineProperty(globalThis, "sky", {
		configurable: true,
		get: () => wrapped,
		set: (value) => {
			wrapped = wrap(value);
		},
	});
})();`;

const primedKernels = new WeakSet<CodexAppServerMcpClient>();

export function forgetNodeReplKernel(client: CodexAppServerMcpClient | undefined): void {
	if (client) primedKernels.delete(client);
}

// The kernel outlives one `js` call, so the shim installs once and reinstalls only after `js_reset`. It hooks
// `globalThis.sky` rather than the module: `@oai/sky`'s namespace is a proxy whose `get_app_state` is read-only
// and non-configurable, so assigning to it throws. The skill's bootstrap line runs through the setter.
export async function primeNodeReplKernel(
	client: CodexAppServerMcpClient,
	mcpToolName: string,
	signal?: AbortSignal,
): Promise<void> {
	if (mcpToolName === "js_reset") {
		primedKernels.delete(client);
		return;
	}
	if (mcpToolName !== "js" || primedKernels.has(client)) return;
	primedKernels.add(client);
	try {
		await client.callTool(
			NODE_REPL_SERVER,
			"js",
			{ code: SKY_DIFF_SHIM, title: "Install Computer Use diff shim", timeout_ms: 15000 },
			signal,
		);
	} catch {
		primedKernels.delete(client);
	}
}
