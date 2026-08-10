import { expect, test } from "bun:test";
import {
	cycleRuntimeHubFilter,
	cycleRuntimeHubScope,
	filterRuntimeHubEntries,
	openRuntimeHub,
	projectRuntimeTree,
	type RuntimeHubEntry,
	registerRuntimeHubSource,
	runtimeAttachmentEnv,
} from "./runtime-hub";

test("terminal attachment clears nested multiplexer state", () => {
	const env = runtimeAttachmentEnv({
		PATH: "/bin",
		TMUX: "/tmp/tmux",
		TMUX_PANE: "%1",
		RMUX: "/tmp/rmux",
		RMUX_PANE: "%2",
	});

	expect(env).toEqual({
		PATH: "/bin",
		TMUX: undefined,
		TMUX_PANE: undefined,
		RMUX: undefined,
		RMUX_PANE: undefined,
	});
});

test("Hub cycles scope and filters", () => {
	expect(cycleRuntimeHubScope("current")).toBe("global");
	expect(cycleRuntimeHubScope("global")).toBe("project");
	expect(cycleRuntimeHubScope("project")).toBe("current");
	expect(cycleRuntimeHubFilter("all")).toBe("agents");
	expect(cycleRuntimeHubFilter("agents")).toBe("subagents");
	expect(cycleRuntimeHubFilter("subagents")).toBe("ttys");
	expect(cycleRuntimeHubFilter("ttys")).toBe("all");

	const entries = [
		{ kind: "session", key: "session", label: "root" },
		{ kind: "agent", key: "agent", label: "child" },
		{ kind: "terminal", key: "terminal", label: "shell" },
		{ kind: "job", key: "job", label: "build" },
	].map((entry) => ({
		...entry,
		status: "running",
		lastActivity: 0,
		open() {},
	})) as RuntimeHubEntry[];
	expect(filterRuntimeHubEntries(entries, "agents").map((entry) => entry.key)).toEqual(["session"]);
	expect(filterRuntimeHubEntries(entries, "subagents").map((entry) => entry.key)).toEqual(["agent"]);
	expect(filterRuntimeHubEntries(entries, "ttys").map((entry) => entry.key)).toEqual(["terminal"]);
});

test("parent view uses stable parent keys", () => {
	const entry = (key: string, parentKey?: string): RuntimeHubEntry => ({
		key,
		parentKey,
		kind: "agent",
		label: key.includes("parent") ? "parent" : "child",
		status: "running",
		lastActivity: 0,
		open() {},
	});
	const projected = projectRuntimeTree([
		entry("agent:root-a:child", "agent:root-a:parent"),
		entry("agent:root-b:parent"),
		entry("agent:root-a:parent"),
	]);

	expect(projected.rows.map((row) => row.key)).toEqual([
		"agent:root-b:parent",
		"agent:root-a:parent",
		"agent:root-a:child",
	]);
	expect(projected.branches.get("agent:root-a:child")).toBe("└── ");
});

test("Alt+A closes the Hub", async () => {
	let closed = 0;
	await openRuntimeHub({
		hasUI: true,
		ui: {
			custom: async (factory: any) => {
				const view = factory(
					{ terminal: { rows: 24, columns: 80 }, requestRender() {} },
					{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
					{},
					() => {
						closed++;
					},
				);
				view.handleInput("\u001ba");
				view.dispose();
			},
		},
	} as never);

	expect(closed).toBe(1);
});

test("Enter attaches an attachable Hub entry", async () => {
	let attached = 0;
	let opened = 0;
	const unregister = registerRuntimeHubSource("test", {
		list: () => [
			{
				key: "terminal:1",
				kind: "terminal",
				label: "shell",
				status: "running",
				lastActivity: Date.now(),
				open: () => {
					opened++;
				},
				attach: async () => {
					attached++;
					return true;
				},
			},
		],
	});
	try {
		await openRuntimeHub({
			hasUI: true,
			ui: {
				custom: async (factory: any) => {
					const view = factory(
						{ terminal: { rows: 24, columns: 80 }, requestRender() {} },
						{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
						{},
						() => {},
					);
					view.handleInput("\r");
					await Bun.sleep(0);
					view.dispose();
				},
			},
		} as never);
	} finally {
		unregister();
	}

	expect(attached).toBe(1);
	expect(opened).toBe(0);
});

test("Hub sources cross cache-busted extension modules", async () => {
	let attached = 0;
	const sibling = await import(`./runtime-hub.ts?source=${Date.now()}`);
	const unregister = sibling.registerRuntimeHubSource("cache-busted-test", {
		list: () => [
			{
				key: "terminal:cache-busted",
				kind: "terminal",
				label: "vim",
				status: "running",
				lastActivity: Date.now(),
				open() {},
				attach: async () => {
					attached++;
					return true;
				},
			},
		],
	});
	try {
		await openRuntimeHub({
			hasUI: true,
			ui: {
				custom: async (factory: any) => {
					const view = factory(
						{ terminal: { rows: 24, columns: 80 }, requestRender() {} },
						{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
						{},
						() => {},
					);
					view.handleInput("\r");
					await Bun.sleep(0);
					view.dispose();
				},
			},
		} as never);
	} finally {
		unregister();
	}

	expect(attached).toBe(1);
});

test("Hub sources receive the active session context", async () => {
	const unregister = registerRuntimeHubSource("context-test", {
		list: ((ctx: { cwd: string }) => [
			{
				key: `job:${ctx.cwd}`,
				kind: "job",
				label: ctx.cwd,
				status: "running",
				lastActivity: Date.now(),
				open() {},
			},
		]) as never,
	});
	try {
		await openRuntimeHub({
			cwd: "/current-project",
			hasUI: true,
			ui: {
				custom: async (factory: any) => {
					const view = factory(
						{ terminal: { rows: 24, columns: 80 }, requestRender() {} },
						{
							fg: (_color: string, text: string) => text,
							bg: (_color: string, text: string) => text,
							bold: (text: string) => text,
						},
						{},
						() => {},
					);
					expect(view.render(80).join("\n")).toContain("/current-project");
					view.dispose();
				},
			},
		} as never);
	} finally {
		unregister();
	}
});
