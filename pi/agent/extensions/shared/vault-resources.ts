import { writeFile } from "node:fs/promises";
import { runCommand } from "./command-runner.ts";
import {
	formatResourceUri,
	type Resource,
	type ResourceContext,
	type ResourceProvider,
	type ResourceRef,
	type WriteRequest,
} from "./resources.ts";

type VaultArtifact = {
	name?: unknown;
	path?: unknown;
	stem?: unknown;
	title?: unknown;
	type?: unknown;
	kind?: unknown;
	size?: unknown;
	project?: unknown;
	modified?: unknown;
	score?: unknown;
	from?: unknown;
	to?: unknown;
	target_path?: unknown;
	link_type?: unknown;
	annotation?: unknown;
};

type ContextRecord = {
	name?: unknown;
	path?: unknown;
	kind?: unknown;
};

type VaultView = {
	name: string;
	value?: string;
	query: Record<string, string>;
};

function projectCwd(context: ResourceContext | undefined, baseCwd: string): string {
	return context?.cwd ?? baseCwd;
}

function resourcePath(ref: ResourceRef): string {
	if (ref.authority !== "current") throw new Error(`Unknown vault project: ${ref.authority}`);
	return ref.path.replace(/^\/+|\/+$/g, "");
}

function isContextRef(ref: ResourceRef): boolean {
	const path = resourcePath(ref);
	return path === "context" || path === "context/";
}

function artifactPath(ref: ResourceRef): string {
	const path = resourcePath(ref);
	if (!path || isContextRef(ref)) throw new Error("Vault context has no artifact path");
	return path;
}

function contextName(ref: ResourceRef): string | undefined {
	return isContextRef(ref) ? ref.query.name || undefined : undefined;
}

function relativeVaultPath(path: string): string {
	const normalized = path.replaceAll("\\", "/");
	const marker = "/blueprints/";
	const markerIndex = normalized.indexOf(marker);
	const projectPath =
		markerIndex === -1
			? normalized.replace(/^\/+/, "")
			: normalized
					.slice(markerIndex + marker.length)
					.split("/")
					.slice(1)
					.join("/");
	return projectPath.replace(/\.md$/, "");
}

export function vaultArtifactName(artifact: VaultArtifact): string {
	let raw = "artifact";
	if (typeof artifact.name === "string") raw = artifact.name;
	else if (typeof artifact.path === "string") raw = artifact.path;
	else if (typeof artifact.stem === "string") raw = artifact.stem;
	const name = raw.startsWith("/") ? relativeVaultPath(raw) : raw.replace(/\.md$/, "");
	const project = typeof artifact.project === "string" ? artifact.project : undefined;
	if (project && (name === project || name.startsWith(`${project}/`))) return name.slice(project.length + 1);
	return name;
}

function parseJson<T>(text: string): T {
	try {
		return JSON.parse(text) as T;
	} catch (error) {
		throw new Error(`Vault returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function jsonText(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function outputResource(uri: string, artifact: VaultArtifact): Resource {
	const path = typeof artifact.path === "string" ? artifact.path : uri;
	const name = typeof artifact.name === "string" ? artifact.name : path;
	return {
		uri,
		name,
		title: typeof artifact.title === "string" ? artifact.title : undefined,
		kind:
			typeof artifact.type === "string"
				? artifact.type
				: typeof artifact.kind === "string"
					? artifact.kind
					: "vault-artifact",
		mediaType: "text/markdown",
		path,
		size: typeof artifact.size === "number" ? artifact.size : undefined,
		modifiedAt: typeof artifact.modified === "string" ? artifact.modified : undefined,
	};
}

function artifactUri(name: string): string {
	return formatResourceUri({ scheme: "vault", authority: "current", path: `/${name}`, query: {} });
}

function contextUri(name: string): string {
	return formatResourceUri(
		name === "root"
			? { scheme: "vault", authority: "current", path: "/context", query: {} }
			: { scheme: "vault", authority: "current", path: "/context", query: { name } },
	);
}

function queryValue(query: Record<string, string>, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = query[key];
		if (value !== undefined) return value;
	}
	return undefined;
}

function queryEnabled(query: Record<string, string>, ...keys: string[]): boolean {
	return ["true", "1", "yes"].includes(queryValue(query, ...keys) ?? "");
}

function queryInteger(query: Record<string, string>, key: string, minimum = 0): number | undefined {
	const raw = query[key];
	if (raw === undefined) return undefined;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < minimum)
		throw new Error(`Vault query ${key} must be an integer >= ${minimum}`);
	return value;
}

function parseVaultView(ref: ResourceRef): VaultView | undefined {
	const fragment = ref.fragment?.trim();
	if (!fragment) return undefined;
	const [expression, fragmentQuery] = fragment.split("?", 2);
	const equals = expression.indexOf("=");
	const name = equals === -1 ? expression : expression.slice(0, equals);
	if (!name) throw new Error(`Vault resource has an empty view: ${formatResourceUri(ref)}`);
	const query = { ...ref.query };
	if (fragmentQuery) {
		for (const [key, value] of new URLSearchParams(fragmentQuery)) query[key] = value;
	}
	return {
		name,
		value: equals === -1 ? undefined : expression.slice(equals + 1),
		query,
	};
}

function viewResource(
	ref: ResourceRef,
	name: string,
	kind: string,
	content: string,
	mediaType = "application/json",
	path?: string,
) {
	return {
		resource: {
			uri: formatResourceUri(ref),
			name: `${name}#${ref.fragment ?? "view"}`,
			kind,
			mediaType,
			...(path ? { path } : {}),
			size: Buffer.byteLength(content, "utf8"),
		},
		content,
	};
}

async function artifactFilePath(
	namePath: string,
	context: ResourceContext | undefined,
	baseCwd: string,
): Promise<string | undefined> {
	try {
		const data = await vltJson<{ path?: unknown }>(["read", namePath], context, baseCwd);
		return typeof data.path === "string" ? data.path : undefined;
	} catch {
		return undefined;
	}
}

function contextResource(record: ContextRecord): Resource {
	const name = typeof record.name === "string" ? record.name : "context";
	return {
		uri: contextUri(name),
		name: name === "root" ? "CONTEXT.md" : name,
		kind: typeof record.kind === "string" ? `context-${record.kind}` : "context",
		mediaType: "text/markdown",
	};
}

function appendListFilters(args: string[], query: Record<string, string>): void {
	const kind = queryValue(query, "kind", "type");
	if (kind) args.push("--type", kind);
	if (queryEnabled(query, "all")) args.push("--all");
	if (query.project) args.push("--project", query.project);
	if (queryEnabled(query, "archived", "archive")) args.push("--archived");
	if (queryEnabled(query, "includeDives", "include-dives")) args.push("--include-dives");
}

function appendSearchFilters(args: string[], query: Record<string, string>): void {
	const kind = queryValue(query, "kind", "type");
	if (kind) args.push("--type", kind);
	if (query.project) args.push("--project", query.project);
	if (queryEnabled(query, "archived", "archive")) args.push("--archive");
}

function appendSimilarityFilters(args: string[], query: Record<string, string>): void {
	const kind = queryValue(query, "kind", "type");
	if (kind) args.push("--type", kind);
	if (query.project) args.push("--project", query.project);
	if (queryEnabled(query, "archived", "archive")) args.push("--archive");
	const limit = queryInteger(query, "limit", 1);
	if (limit !== undefined) args.push("--limit", String(limit));
}

function appendLinkFilters(args: string[], query: Record<string, string>): void {
	const kind = queryValue(query, "kind", "type");
	if (kind) args.push("--type", kind);
}

async function vlt(args: string[], context: ResourceContext | undefined, baseCwd: string): Promise<string> {
	const result = await runCommand("vlt", args, projectCwd(context, baseCwd), {
		signal: context?.signal,
		allowNonZero: false,
	});
	return result.stdout;
}

async function vltJson<T>(args: string[], context: ResourceContext | undefined, baseCwd: string): Promise<T> {
	return parseJson<T>(await vlt([...args, "--json"], context, baseCwd));
}

async function listedContexts(
	ref: ResourceRef,
	context: ResourceContext | undefined,
	baseCwd: string,
): Promise<ContextRecord[]> {
	const args = ["context", "list"];
	if (ref.query.project) args.push("--project", ref.query.project);
	const value = await vltJson<unknown>(args, context, baseCwd);
	if (Array.isArray(value)) return value as ContextRecord[];
	if (value && typeof value === "object" && Array.isArray((value as { contexts?: unknown }).contexts)) {
		return (value as { contexts: ContextRecord[] }).contexts;
	}
	return [];
}

function missingContextResult(ref: ResourceRef) {
	const name = contextName(ref);
	const content = name ? `Vault context "${name}" is not configured.\n` : "No vault context is configured.\n";
	return {
		resource: {
			uri: formatResourceUri(ref),
			name: name || "CONTEXT.md",
			kind: "context",
			mediaType: "text/markdown",
			size: Buffer.byteLength(content, "utf8"),
		},
		content,
	};
}

async function readContext(ref: ResourceRef, context: ResourceContext | undefined, baseCwd: string) {
	const args = ["context", "show"];
	const name = contextName(ref);
	if (name) args.push(name);
	if (ref.query.project) args.push("--project", ref.query.project);
	args.push("--json");
	return parseJson<{ content?: unknown; path?: unknown }>(await vlt(args, context, baseCwd));
}

async function readContextView(ref: ResourceRef, context: ResourceContext | undefined, baseCwd: string) {
	const view = parseVaultView(ref);
	if (!view) {
		const contexts = await listedContexts(ref, context, baseCwd);
		const requested = contextName(ref) ?? "root";
		if (!contexts.some((record) => record.name === requested)) return missingContextResult(ref);
		const data = await readContext(ref, context, baseCwd);
		const content = typeof data.content === "string" ? data.content : "";
		const name = contextName(ref);
		return {
			resource: {
				uri: formatResourceUri(ref),
				name: name || "CONTEXT.md",
				kind: "context",
				mediaType: "text/markdown",
				...(typeof data.path === "string" ? { path: data.path } : {}),
				size: Buffer.byteLength(content, "utf8"),
			},
			content,
		};
	}

	const name = contextName(ref) || "context";
	if (view.name === "list") {
		const args = ["context", "list"];
		if (view.query.project) args.push("--project", view.query.project);
		return viewResource(ref, name, "context-list", jsonText(await vltJson<unknown>(args, context, baseCwd)));
	}
	if (view.name === "check") {
		const args = ["context", "check"];
		if (view.query.project) args.push("--project", view.query.project);
		return viewResource(ref, name, "context-check", jsonText(await vltJson<unknown>(args, context, baseCwd)));
	}
	throw new Error(`Unknown vault context view: #${ref.fragment}`);
}

async function readArtifactView(ref: ResourceRef, context: ResourceContext | undefined, baseCwd: string) {
	const namePath = artifactPath(ref);
	const view = parseVaultView(ref);
	if (!view || view.name === "body") {
		const data = await vltJson<{ body?: unknown; path?: unknown; title?: unknown; frontmatter?: unknown }>(
			["read", namePath],
			context,
			baseCwd,
		);
		const content = typeof data.body === "string" ? data.body : "";
		return {
			resource: {
				uri: formatResourceUri(ref),
				name: namePath,
				title: typeof data.title === "string" ? data.title : undefined,
				kind: "vault-artifact",
				mediaType: "text/markdown",
				...(typeof data.path === "string" ? { path: data.path } : {}),
				size: Buffer.byteLength(content, "utf8"),
			},
			content,
		};
	}
	const filePath = await artifactFilePath(namePath, context, baseCwd);

	if (view.name === "frontmatter") {
		const data = await vltJson<{ frontmatter?: unknown }>(["read", namePath, "--frontmatter"], context, baseCwd);
		return viewResource(
			ref,
			namePath,
			"vault-frontmatter",
			jsonText(data.frontmatter ?? data),
			"application/json",
			filePath,
		);
	}
	if (view.name === "depth") {
		const depth = view.value ?? view.query.depth;
		if (depth === undefined) throw new Error(`Vault depth view needs a value: ${formatResourceUri(ref)}`);
		const parsedDepth = Number(depth);
		if (!Number.isInteger(parsedDepth) || parsedDepth < 0)
			throw new Error(`Vault depth view needs a non-negative integer: ${formatResourceUri(ref)}`);
		const data = await vltJson<unknown>(["read", namePath, "--depth", String(parsedDepth)], context, baseCwd);
		return viewResource(ref, namePath, "vault-depth", jsonText(data), "application/json", filePath);
	}
	if (view.name === "links" || view.name === "backlinks") {
		const args = [view.name, namePath];
		appendLinkFilters(args, view.query);
		const data = await vltJson<unknown>(args, context, baseCwd);
		return viewResource(ref, namePath, `vault-${view.name}`, jsonText(data), "application/json", filePath);
	}
	if (view.name === "similar") {
		const args = ["similar", namePath];
		appendSimilarityFilters(args, view.query);
		const data = await vltJson<unknown>(args, context, baseCwd);
		return viewResource(ref, namePath, "vault-similar", jsonText(data), "application/json", filePath);
	}
	if (view.name === "related") {
		const args = ["related", namePath];
		if (view.query.project) args.push("--project", view.query.project);
		if (queryEnabled(view.query, "archived", "archive")) args.push("--archive");
		const data = await vltJson<unknown>(args, context, baseCwd);
		return viewResource(ref, namePath, "vault-related", jsonText(data), "application/json", filePath);
	}
	throw new Error(`Unknown vault artifact view: #${ref.fragment}`);
}

async function readList(ref: ResourceRef, context: ResourceContext | undefined, baseCwd: string) {
	const args = ["list"];
	appendListFilters(args, ref.query);
	return viewResource(ref, "vault", "vault-list", jsonText(await vltJson<unknown>(args, context, baseCwd)));
}

async function readPseudo(ref: ResourceRef, context: ResourceContext | undefined, baseCwd: string) {
	const path = resourcePath(ref);
	if (ref.fragment) throw new Error(`Vault pseudo-resource views are not supported: ${formatResourceUri(ref)}`);
	if (path === "_list") return readList(ref, context, baseCwd);
	if (path === "_search") {
		const query = queryValue(ref.query, "query", "q");
		if (!query) throw new Error(`Vault search resource needs ?query=: ${formatResourceUri(ref)}`);
		const args = ["search", query];
		appendSearchFilters(args, ref.query);
		return viewResource(ref, "_search", "vault-search", jsonText(await vltJson<unknown>(args, context, baseCwd)));
	}
	if (path === "_related") {
		const topic = ref.query.topic;
		if (!topic) throw new Error(`Vault related resource needs ?topic=: ${formatResourceUri(ref)}`);
		const args = ["related", topic];
		if (ref.query.project) args.push("--project", ref.query.project);
		if (queryEnabled(ref.query, "archived", "archive")) args.push("--archive");
		return viewResource(ref, "_related", "vault-related", jsonText(await vltJson<unknown>(args, context, baseCwd)));
	}
	if (path === "_similar") {
		const file = ref.query.file;
		if (!file) throw new Error(`Vault similar resource needs ?file=: ${formatResourceUri(ref)}`);
		const args = ["similar", file];
		appendSimilarityFilters(args, ref.query);
		return viewResource(ref, "_similar", "vault-similar", jsonText(await vltJson<unknown>(args, context, baseCwd)));
	}
	if (path === "_links" || path === "_backlinks") {
		const file = ref.query.file;
		if (!file) throw new Error(`Vault ${path.slice(1)} resource needs ?file=: ${formatResourceUri(ref)}`);
		const args = [path.slice(1), file];
		appendLinkFilters(args, ref.query);
		return viewResource(
			ref,
			path,
			`vault-${path.slice(1)}`,
			jsonText(await vltJson<unknown>(args, context, baseCwd)),
		);
	}
	if (path === "_graph") {
		return viewResource(ref, path, "vault-graph", jsonText(await vltJson<unknown>(["graph"], context, baseCwd)));
	}
	if (path === "_review") {
		const args = ["review"];
		const threshold = queryInteger(ref.query, "longThreshold", 0);
		if (threshold !== undefined) args.push("--long-threshold", String(threshold));
		return viewResource(ref, path, "vault-review", jsonText(await vltJson<unknown>(args, context, baseCwd)));
	}
	if (path === "_check") {
		const args = ["check"];
		if (queryEnabled(ref.query, "archived", "archive")) args.push("--archive");
		return viewResource(ref, path, "vault-check", jsonText(await vltJson<unknown>(args, context, baseCwd)));
	}
	if (path === "_status") {
		return viewResource(ref, path, "vault-status", jsonText(await vltJson<unknown>(["status"], context, baseCwd)));
	}
	if (path === "_types") {
		return viewResource(
			ref,
			path,
			"vault-types",
			jsonText(await vltJson<unknown>(["list", "--type"], context, baseCwd)),
		);
	}
	if (path === "_contexts") {
		const args = ["context", "list"];
		if (ref.query.project) args.push("--project", ref.query.project);
		return viewResource(ref, path, "context-list", jsonText(await vltJson<unknown>(args, context, baseCwd)));
	}
	throw new Error(`Unknown vault pseudo-resource: ${formatResourceUri(ref)}`);
}

async function readVault(ref: ResourceRef, context: ResourceContext | undefined, baseCwd: string) {
	const path = resourcePath(ref);
	if (isContextRef(ref)) return readContextView(ref, context, baseCwd);
	if (!path || path === "_list") return readList(ref, context, baseCwd);
	if (path.startsWith("_")) return readPseudo(ref, context, baseCwd);
	return readArtifactView(ref, context, baseCwd);
}

async function writeContext(
	ref: ResourceRef,
	request: WriteRequest,
	context: ResourceContext | undefined,
	baseCwd: string,
) {
	const current = await readVault(ref, context, baseCwd);
	if (request.expectedContent !== undefined && current.content !== request.expectedContent)
		throw new Error(`Vault resource changed: ${formatResourceUri(ref)}`);
	if (current.content === request.content)
		return { resource: current.resource, bytes: Buffer.byteLength(request.content, "utf8") };

	const data = await readContext(ref, context, baseCwd);
	const path = typeof data.path === "string" ? data.path : undefined;
	if (!path) throw new Error(`Vault context has no file path: ${formatResourceUri(ref)}`);
	await writeFile(path, request.content, "utf8");
	await vlt(["commit", path, "--json"], context, baseCwd);
	return {
		resource: { ...current.resource, size: Buffer.byteLength(request.content, "utf8") },
		bytes: Buffer.byteLength(request.content, "utf8"),
	};
}

function resourceFromArtifact(record: VaultArtifact): Resource {
	const name = vaultArtifactName(record);
	return outputResource(artifactUri(name), { ...record, name, path: name });
}

async function findContexts(
	ref: ResourceRef,
	context: ResourceContext | undefined,
	baseCwd: string,
): Promise<Resource[]> {
	const args = ["context", "list"];
	if (ref.query.project) args.push("--project", ref.query.project);
	const records = await vltJson<ContextRecord[]>(args, context, baseCwd);
	return records.map(contextResource);
}

async function findPseudo(
	ref: ResourceRef,
	context: ResourceContext | undefined,
	baseCwd: string,
): Promise<Resource[]> {
	const path = resourcePath(ref);
	if (path === "_search") {
		const query = queryValue(ref.query, "query", "q");
		if (!query) return [];
		const args = ["search", query];
		appendSearchFilters(args, ref.query);
		return (await vltJson<VaultArtifact[]>(args, context, baseCwd)).map(resourceFromArtifact);
	}
	if (path === "_related") {
		const topic = ref.query.topic;
		if (!topic) return [];
		const args = ["related", topic];
		if (ref.query.project) args.push("--project", ref.query.project);
		if (queryEnabled(ref.query, "archived", "archive")) args.push("--archive");
		return (await vltJson<VaultArtifact[]>(args, context, baseCwd)).map(resourceFromArtifact);
	}
	if (path === "_similar") {
		const file = ref.query.file;
		if (!file) return [];
		const args = ["similar", file];
		appendSimilarityFilters(args, ref.query);
		return (await vltJson<VaultArtifact[]>(args, context, baseCwd)).map(resourceFromArtifact);
	}
	if (path === "_links" || path === "_backlinks") {
		const file = ref.query.file;
		if (!file) return [];
		const args = [path.slice(1), file];
		appendLinkFilters(args, ref.query);
		return (await vltJson<VaultArtifact[]>(args, context, baseCwd))
			.map((record) => (typeof record.path === "string" ? resourceFromArtifact(record) : undefined))
			.filter((resource): resource is Resource => resource !== undefined);
	}
	if (path === "_contexts") return findContexts(ref, context, baseCwd);
	return [];
}

export function vaultResourceProvider(baseCwd: string): ResourceProvider {
	return {
		read: (ref, context) => readVault(ref, context, baseCwd),
		async search(request) {
			const query = request.query.trim();
			if (!query) return [];
			const scope = request.scope;
			if (scope && scope.authority !== "current") throw new Error(`Unknown vault project: ${scope.authority}`);
			const args = ["search", query];
			appendSearchFilters(args, scope?.query ?? {});
			const records = await vltJson<VaultArtifact[]>(args, request.context, baseCwd);
			return records.slice(0, request.limit ?? 50).map((record) => ({
				...resourceFromArtifact(record),
				score: typeof record.score === "number" ? -record.score : 0,
			}));
		},
		async find(ref, context) {
			if (ref.fragment) {
				return [
					{
						uri: formatResourceUri(ref),
						name: `${resourcePath(ref)}#${ref.fragment}`,
						kind: "vault-view",
						mediaType: "application/json",
					},
				];
			}
			if (isContextRef(ref)) return findContexts(ref, context, baseCwd);
			const path = resourcePath(ref);
			if (path.startsWith("_")) return findPseudo(ref, context, baseCwd);
			const args = ["list"];
			appendListFilters(args, ref.query);
			const records = await vltJson<VaultArtifact[]>(args, context, baseCwd);
			return records
				.filter((record) => {
					const rawName = typeof record.name === "string" ? record.name : "";
					const name = vaultArtifactName(record);
					return (
						!path ||
						name === path ||
						name.startsWith(`${path}/`) ||
						rawName === path ||
						rawName.startsWith(`${path}/`)
					);
				})
				.map(resourceFromArtifact);
		},
		async write(ref, request: WriteRequest) {
			if (ref.fragment) throw new Error(`Vault views are read-only: ${formatResourceUri(ref)}`);
			const path = resourcePath(ref);
			if (path.startsWith("_")) throw new Error(`Vault pseudo-resources are read-only: ${formatResourceUri(ref)}`);
			if (isContextRef(ref)) return writeContext(ref, request, request.context, baseCwd);

			const name = artifactPath(ref);
			if (request.expectedContent !== undefined) {
				const current = await readVault(ref, request.context, baseCwd);
				if (current.content !== request.expectedContent)
					throw new Error(`Vault resource changed: ${formatResourceUri(ref)}`);
			}
			const data = parseJson<{ path?: unknown; name?: unknown; title?: unknown }>(
				await vlt(["update", name, "--content", request.content, "--json"], request.context, baseCwd),
			);
			const resource = outputResource(formatResourceUri(ref), {
				name: typeof data.name === "string" ? data.name : name,
				path: typeof data.path === "string" ? data.path : name,
			});
			return { resource, bytes: Buffer.byteLength(request.content, "utf8") };
		},
	};
}
