import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fixtureScript, fixtureScriptDir } from "./fixture-script.ts";
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
const originalPath = process.env.PATH;
const originalRtkDisabled = process.env.RTK_DISABLED;

afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
	if (originalPath === undefined) delete process.env.PATH;
	else process.env.PATH = originalPath;
	if (originalRtkDisabled === undefined) delete process.env.RTK_DISABLED;
	else process.env.RTK_DISABLED = originalRtkDisabled;
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
		expect(parseResourceUri("pr://16/checks")).toEqual({
			scheme: "pr",
			authority: "current",
			path: "/16/checks",
			query: {},
		});
		expect(formatResourceUri(parseResourceUri("pr://current/16/checks")!)).toBe("pr://16/checks");
		expect(formatResourceUri(parseResourceUri("pr://?state=open")!)).toBe("pr://?state=open");
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
		expect(resourceOpenUrl("pr://owner/repo/16/checks")).toBe("https://github.com/owner/repo/pull/16/checks");
		expect(
			resourceOpenUrl({
				uri: "pr://owner/repo/16/comments/IC_node",
				name: "IC_node",
				metadata: { url: "https://github.com/owner/repo/pull/16#issuecomment-123" },
			}),
		).toBe("https://github.com/owner/repo/pull/16#issuecomment-123");
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
	it("rejects removed collection filters", async () => {
		const ref = parseResourceUri("pr://?blocked=true");
		await expect(githubResourceProvider(process.cwd()).find(ref!)).rejects.toThrow(
			"Unsupported GitHub query parameter: blocked",
		);
	});
	it("passes collection filters to GitHub CLI", async () => {
		const gh = fixtureScript(
			"gh",
			`#!/bin/sh
if [ "$*" = "pr list --json number,title,state,url,author,updatedAt --limit 100 --state all --author philip-bcny" ]; then
	printf '[{"number":7,"title":"Match","state":"OPEN","url":"https://github.com/owner/repo/pull/7","author":{"login":"philip-bcny"}}]'
else
	printf 'unexpected gh call: %s\n' "$*" >&2
	exit 99
fi
`,
		);
		process.env.PATH = fixtureScriptDir(gh);
		process.env.RTK_DISABLED = "1";

		const ref = parseResourceUri("pr://?author=philip-bcny&state=all&limit=100");
		const resources = await githubResourceProvider(process.cwd()).find(ref!);

		expect(resources.map((resource) => resource.uri)).toEqual(["pr://7"]);
	});
	it("reads a pull request without enrichment calls", async () => {
		const gh = fixtureScript(
			"gh",
			`#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
	printf '{"number":7,"title":"Small read","state":"OPEN","url":"https://github.com/owner/repo/pull/7","author":{"login":"philip"},"body":"Body","baseRefName":"main","headRefName":"feature","headRefOid":"abc"}'
else
	printf 'unexpected gh call: %s\n' "$*" >&2
	exit 99
fi
`,
		);
		process.env.PATH = fixtureScriptDir(gh);
		process.env.RTK_DISABLED = "1";

		const result = await githubResourceProvider(process.cwd()).read(parseResourceUri("pr://7")!);

		expect(result.resource.metadata?.repository).toBe("owner/repo");
		expect(result.resource.metadata?.number).toBe(7);
	});
	it("includes an exact GitHub item URL in model-visible content", async () => {
		const gh = fixtureScript(
			"gh",
			`#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
	printf '{"number":7,"title":"Small read","state":"OPEN","url":"https://github.com/owner/repo/pull/7","comments":[{"id":"IC_test","author":{"login":"philip"},"body":"Comment body","createdAt":"2026-08-11T00:00:00Z","url":"https://github.com/owner/repo/pull/7#issuecomment-1"}]}'
else
	printf 'unexpected gh call: %s\\n' "$*" >&2
	exit 99
fi
`,
		);
		process.env.PATH = fixtureScriptDir(gh);
		process.env.RTK_DISABLED = "1";

		const result = await githubResourceProvider(process.cwd()).read(
			parseResourceUri("pr://owner/repo/7/comments/IC_test")!,
		);

		expect(result.content).toContain("**URL:** https://github.com/owner/repo/pull/7#issuecomment-1");
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
