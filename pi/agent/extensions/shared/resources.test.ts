import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { githubResourceProvider } from "./github-resources.ts";
import {
	formatResourceUri,
	localResourceRoot,
	parseResourceUri,
	RESOURCE_SCHEMES,
	type ResourceProvider,
	registerResourceProvider,
	resourceOpenUrl,
	resourceProvider,
	searchResources,
} from "./resources.ts";
import { vaultArtifactName } from "./vault-resources.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

describe("resource URIs", () => {
	it("parses every supported scheme and preserves path and query", () => {
		for (const scheme of RESOURCE_SCHEMES.filter(
			(item) => item !== "history" && item !== "vault" && item !== "local",
		)) {
			const uri = `${scheme}://authority/path%20with%20spaces?mode=full`;
			const ref = parseResourceUri(uri);
			expect(ref).toEqual({
				scheme,
				authority: "authority",
				path: "/path with spaces",
				query: { mode: "full" },
			});
			expect(formatResourceUri(ref!)).toBe(`${scheme}://authority/path%20with%20spaces?mode=full`);
		}
	});

	it("makes ambient resource scopes implicit", () => {
		expect(parseResourceUri("pr://16#checks")).toEqual({
			scheme: "pr",
			authority: "current",
			path: "/16",
			fragment: "checks",
			query: {},
		});
		expect(formatResourceUri(parseResourceUri("pr://current/16#checks")!)).toBe("pr://16#checks");
		expect(formatResourceUri(parseResourceUri("pr://?state=open")!)).toBe("pr://?state=open");
		expect(formatResourceUri(parseResourceUri("action://31233002690/log")!)).toBe("action://31233002690/log");
		expect(formatResourceUri(parseResourceUri("history://")!)).toBe("history://");
		expect(formatResourceUri(parseResourceUri("history://message-id")!)).toBe("history://message-id");
		expect(formatResourceUri(parseResourceUri("local://attachment-1.png")!)).toBe("local://attachment-1.png");
	});

	it("parses and formats ambient vault fragments", () => {
		const ref = parseResourceUri("vault://docs/0003-workflow?limit=10#backlinks");
		expect(ref).toEqual({
			scheme: "vault",
			authority: "current",
			path: "/docs/0003-workflow",
			fragment: "backlinks",
			query: { limit: "10" },
		});
		expect(formatResourceUri(ref!)).toBe("vault://docs/0003-workflow?limit=10#backlinks");
		const view = parseResourceUri("vault://docs/0003-workflow#similar?limit=10&kind=plan");
		expect(view?.fragment).toBe("similar?limit=10&kind=plan");
		expect(formatResourceUri(view!)).toBe("vault://docs/0003-workflow#similar?limit=10&kind=plan");
	});

	it("maps resource URIs to native open targets", () => {
		expect(resourceOpenUrl("pr://owner/repo/16")).toBe("https://github.com/owner/repo/pull/16");
		expect(resourceOpenUrl("issue://owner/repo/2")).toBe("https://github.com/owner/repo/issues/2");
		expect(resourceOpenUrl("action://owner/repo/31233002690/log")).toBe(
			"https://github.com/owner/repo/actions/runs/31233002690",
		);
		expect(resourceOpenUrl("vault://boo/ticket/0013-make-settings-contributions-ecs-owned")).toBe(
			"obsidian://open?vault=blueprints&file=boo%2Fticket%2F0013-make-settings-contributions-ecs-owned",
		);
		expect(
			resourceOpenUrl({
				uri: "vault://ticket/0013-make-settings-contributions-ecs-owned",
				name: "ticket/0013-make-settings-contributions-ecs-owned",
				path: "/Users/example/blueprints/boo/ticket/0013-make-settings-contributions-ecs-owned.md",
			}),
		).toBe("obsidian://open?vault=blueprints&file=boo%2Fticket%2F0013-make-settings-contributions-ecs-owned");
		const localRoot = localResourceRoot({ sessionId: "session-test" });
		expect(resourceOpenUrl("local://demo.md", { sessionId: "session-test" })).toBe(
			pathToFileURL(join(localRoot, "demo.md")).href,
		);
	});
	it("rejects unknown schemes instead of treating them as local paths", () => {
		expect(() => parseResourceUri("file://tmp/example.txt")).toThrow("Unsupported resource scheme: file");
	});

	it("rejects malformed percent escapes", () => {
		expect(() => parseResourceUri("skill://demo/%")).toThrow("Malformed resource URI");
	});
	it("makes current vault artifact names project-relative", () => {
		expect(vaultArtifactName({ name: "agents/docs/0003-workflow", project: "agents" })).toBe("docs/0003-workflow");
		expect(vaultArtifactName({ name: "shared/docs/0003-workflow", project: "agents" })).toBe(
			"shared/docs/0003-workflow",
		);
		expect(vaultArtifactName({ path: "/Users/luan/blueprints/agents/plan/0004-workflow.md" })).toBe(
			"plan/0004-workflow",
		);
	});
});

describe("GitHub resources", () => {
	it("routes collection reads to find or search", async () => {
		const ref = parseResourceUri("pr://owner/repo?state=open");
		expect(ref).toBeDefined();

		await expect(githubResourceProvider(process.cwd()).read(ref!)).rejects.toThrow(
			"GitHub collections are listed with find or search, not read",
		);
	});
});

describe("resource registry", () => {
	it("dispatches scoped search to registered provider", async () => {
		const provider: ResourceProvider = {
			read: async () => ({ resource: { uri: "skill://demo", name: "SKILL.md" }, content: "demo" }),
			search: async (request) => [
				{
					uri: `skill://${request.scope?.authority ?? "demo"}`,
					name: "SKILL.md",
					score: 1,
				},
			],
			find: async () => [],
		};
		cleanups.push(registerResourceProvider("skill", provider));

		expect(await searchResources({ query: "demo", scope: parseResourceUri("skill://demo") })).toEqual([
			{ uri: "skill://demo", name: "SKILL.md", score: 1 },
		]);
	});
	it("shares providers across cache-busted extension modules", async () => {
		const sibling = await import(`./resources.ts?source=${Date.now()}`);
		const provider: ResourceProvider = {
			read: async () => ({ resource: { uri: "skill://demo", name: "SKILL.md" }, content: "demo" }),
			search: async () => [],
			find: async () => [],
		};
		const unregister = sibling.registerResourceProvider("skill", provider);
		try {
			expect(resourceProvider("skill")).toBe(provider);
		} finally {
			unregister();
		}
	});
});
