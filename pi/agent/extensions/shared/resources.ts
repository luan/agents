import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const RESOURCE_SCHEMES = ["skill", "vault", "history", "artifact", "local", "agent", "pr", "issue"] as const;

export type ResourceScheme = (typeof RESOURCE_SCHEMES)[number];

export type ResourceRef = {
	scheme: ResourceScheme;
	authority: string;
	path: string;
	fragment?: string;
	query: Record<string, string>;
};

export type Resource = {
	uri: string;
	name: string;
	title?: string;
	kind?: string;
	mediaType?: string;
	size?: number;
	path?: string;
	modifiedAt?: string;
	version?: string;
	metadata?: Record<string, unknown>;
};

export type ResourceContext = {
	cwd?: string;
	sessionId?: string;
	sessionFile?: string;
	signal?: AbortSignal;
};

export type ResourceCapabilities = {
	providerVersion: string;
	views: string[];
	fields: string[];
};

export type ReadResult = {
	resource: Resource;
	content: string;
};

export type SearchRequest = {
	query: string;
	scope?: ResourceRef;
	literal?: boolean;
	ignoreCase?: boolean;
	limit?: number;
	context?: ResourceContext;
};

export type SearchHit = Resource & {
	snippet?: string;
	score?: number;
};

export type WriteRequest = {
	content: string;
	expectedContent?: string;
	makeExecutable?: boolean;
	context?: ResourceContext;
};

export type WriteResult = {
	resource: Resource;
	bytes: number;
};

export type ResourceProvider = {
	read(ref: ResourceRef, context?: ResourceContext): Promise<ReadResult>;
	search(request: SearchRequest): Promise<SearchHit[]>;
	find(ref: ResourceRef, context?: ResourceContext): Promise<Resource[]>;
	write?(ref: ResourceRef, request: WriteRequest): Promise<WriteResult>;
	capabilities?(ref: ResourceRef, context?: ResourceContext): Promise<ResourceCapabilities>;
};

export type ResourceErrorCode =
	| "malformed_uri"
	| "unsupported_scheme"
	| "missing_provider"
	| "not_found"
	| "ambiguous"
	| "read_only"
	| "invalid_path"
	| "unsupported_view"
	| "unsupported_action"
	| "permission_denied"
	| "validation_failed";

export class ResourceError extends Error {
	readonly name = "ResourceError";

	constructor(
		readonly code: ResourceErrorCode,
		message: string,
	) {
		super(message);
	}
}

const RESOURCE_PROVIDERS = Symbol.for("agents.resourceProviders");
const globalState = globalThis as typeof globalThis & Record<symbol, Map<ResourceScheme, ResourceProvider> | undefined>;
// Extensions can load this module more than once. Keep providers process-wide.
const providers = globalState[RESOURCE_PROVIDERS] ?? new Map<ResourceScheme, ResourceProvider>();
globalState[RESOURCE_PROVIDERS] = providers;

function decodeResourcePath(pathname: string): string {
	return pathname
		.split("/")
		.map((segment) => decodeURIComponent(segment.replace(/%2f/gi, "%252F")))
		.join("/");
}

function encodeResourcePath(path: string): string {
	return path
		.split("/")
		.map((segment) => encodeURIComponent(segment).replaceAll("%252F", "%2F"))
		.join("/");
}

const IMPLICIT_CURRENT_SCHEMES = new Set<ResourceScheme>(["pr", "issue", "history", "vault", "local"]);

function usesImplicitCurrent(scheme: ResourceScheme): boolean {
	return IMPLICIT_CURRENT_SCHEMES.has(scheme);
}

/**
 * `pr://62946/files` — a numeric authority is the item, not a repository.
 *
 * The check used to require an empty path, so only the bare item resolved:
 * every documented view shorthand parsed the number as the authority and the
 * view as the item, and came back as "collections are listed with find or
 * search". No GitHub owner is a bare number, so the digits decide it.
 */
function isGitHubCurrentShorthand(scheme: ResourceScheme, authority: string): boolean {
	if (!/^\d+$/.test(authority)) return false;
	return scheme === "pr" || scheme === "issue";
}
export function parseResourceUri(value: string): ResourceRef | undefined {
	const match = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value);
	if (!match) return undefined;

	const scheme = match[1]!.toLowerCase();
	if (!RESOURCE_SCHEMES.includes(scheme as ResourceScheme)) {
		throw new ResourceError("unsupported_scheme", `Unsupported resource scheme: ${scheme}`);
	}
	const resourceScheme = scheme as ResourceScheme;
	const remainder = value.slice(match[0].length);
	const missingAuthority = remainder === "" || remainder.startsWith("?") || remainder.startsWith("#");

	let parsed: URL;
	try {
		parsed = new URL(missingAuthority ? value.replace(match[0], `${scheme}://current`) : value);
	} catch (error) {
		throw new ResourceError(
			"malformed_uri",
			`Malformed resource URI: ${value}${error instanceof Error ? ` (${error.message})` : ""}`,
		);
	}
	if (parsed.username || parsed.password || parsed.port) {
		throw new ResourceError("malformed_uri", `Resource URI cannot contain credentials or ports: ${value}`);
	}

	let authority: string;
	let path: string;
	let fragment: string | undefined;
	try {
		authority = decodeURIComponent(parsed.hostname);
		path = decodeResourcePath(parsed.pathname);
		fragment = parsed.hash ? decodeURIComponent(parsed.hash.slice(1)) : undefined;
	} catch (error) {
		throw new ResourceError(
			"malformed_uri",
			`Malformed resource URI: ${value}${error instanceof Error ? ` (${error.message})` : ""}`,
		);
	}
	if (!authority) throw new ResourceError("malformed_uri", `Resource URI needs an authority: ${value}`);
	if (authority !== "current" && (scheme === "history" || scheme === "vault" || scheme === "local")) {
		path = `/${authority}${path}`;
		authority = "current";
	} else if (authority !== "current" && isGitHubCurrentShorthand(resourceScheme, authority)) {
		path = `/${authority}${path}`;
		authority = "current";
	}

	if (/%(?![0-9a-f]{2})/i.test(parsed.search) || /%(?![0-9a-f]{2})/i.test(parsed.hash)) {
		throw new ResourceError("malformed_uri", `Malformed resource URI: ${value}`);
	}
	const query: Record<string, string> = {};
	for (const [key, item] of parsed.searchParams) query[key] = item;
	return {
		scheme: resourceScheme,
		authority,
		path,
		...(fragment ? { fragment } : {}),
		query,
	};
}

export function formatResourceUri(ref: ResourceRef): string {
	const path = encodeResourcePath(ref.path);
	const query = new URLSearchParams(ref.query).toString();
	const fragment = ref.fragment
		? `#${encodeURIComponent(ref.fragment).replaceAll("%3F", "?").replaceAll("%3D", "=").replaceAll("%26", "&")}`
		: "";
	if (ref.authority === "current" && usesImplicitCurrent(ref.scheme)) {
		return `${ref.scheme}://${path.replace(/^\/+/, "")}${query ? `?${query}` : ""}${fragment}`;
	}
	const authority = encodeURIComponent(ref.authority);
	return `${ref.scheme}://${authority}${path}${query ? `?${query}` : ""}${fragment}`;
}

type ResourceOpenContext = Pick<ResourceContext, "cwd" | "sessionId">;

function safeLocalSessionId(sessionId: string): string {
	const safe = sessionId.replace(/[^a-zA-Z0-9_.-]/g, "_");
	return safe || "session";
}

export function localResourceRoot(context: Pick<ResourceContext, "sessionId">): string {
	if (!context.sessionId) throw new ResourceError("validation_failed", "No session - local:// unavailable");
	return join(tmpdir(), "pi-local", safeLocalSessionId(context.sessionId));
}

export function localResourcePath(ref: ResourceRef, context: Pick<ResourceContext, "sessionId">): string {
	if (ref.scheme !== "local" || ref.authority !== "current")
		throw new ResourceError("invalid_path", `Invalid local resource URI: ${formatResourceUri(ref)}`);
	const root = resolve(localResourceRoot(context));
	const path = resolve(root, ref.path.replace(/^\/+/, ""));
	if (path !== root && !path.startsWith(`${root}${sep}`))
		throw new ResourceError("invalid_path", `Local resource escapes its root: ${formatResourceUri(ref)}`);
	return path;
}

function resourceMetadataString(resource: Resource | undefined, key: string): string | undefined {
	const value = resource?.metadata?.[key];
	return typeof value === "string" && value ? value : undefined;
}

/**
 * Where a view opens on github.com.
 *
 * A view is a different page, not the same page with extra data, so the link a
 * card carries has to follow the URI down to the view it actually read.
 */
function githubViewSuffix(variant: string | undefined, selector: string | undefined): string {
	switch (variant) {
		case "files":
			return "/files";
		case "checks":
			return "/checks";
		// Review threads render on the Files changed tab, which is the closest
		// page GitHub has to a thread listing. A single thread carries its own
		// anchor, so it never reaches here.
		case "threads":
			return "/files";
		case "comments":
			return selector ? `#issuecomment-${selector}` : "";
		default:
			return "";
	}
}

function githubOpenUrl(ref: ResourceRef, resource: Resource | undefined): string | undefined {
	const segments = ref.path.replace(/^\/+/, "").split("/").filter(Boolean);
	let repository: string | undefined;
	let number: string | undefined;
	let rest: string[];
	if (ref.authority === "current") {
		repository = resourceMetadataString(resource, "repository");
		number = segments[0];
		rest = segments.slice(1);
	} else if (ref.authority === "github.com") {
		repository = segments.length >= 2 ? `${segments[0]}/${segments[1]}` : undefined;
		number = segments[2];
		rest = segments.slice(3);
	} else {
		repository = segments[0] ? `${ref.authority}/${segments[0]}` : undefined;
		number = segments[1];
		rest = segments.slice(2);
	}
	const selector = rest.slice(1).join("/") || undefined;
	const suffix = githubViewSuffix(rest[0] ?? ref.fragment, selector);
	const directUrl = resourceMetadataString(resource, "url");
	if (directUrl && selector) return directUrl;
	if (directUrl && !suffix) return directUrl;
	if (!repository || !number) return directUrl;
	const route = ref.scheme === "pr" ? "pull" : "issues";
	return `https://github.com/${repository}/${route}/${encodeURIComponent(number)}${suffix}`;
}

function vaultOpenPath(ref: ResourceRef, resource: Resource | undefined): string {
	const sourcePath = resource?.path?.replaceAll("\\", "/");
	const marker = "/blueprints/";
	const markerIndex = sourcePath?.indexOf(marker) ?? -1;
	const path =
		markerIndex >= 0 && sourcePath ? sourcePath.slice(markerIndex + marker.length) : ref.path.replace(/^\/+/, "");
	return path.replace(/\.md$/, "");
}

export function resourceOpenUrl(value: string | Resource, context: ResourceOpenContext = {}): string | undefined {
	const resource = typeof value === "string" ? undefined : value;
	const uri = typeof value === "string" ? value : value.uri;
	let ref: ResourceRef | undefined;
	try {
		ref = parseResourceUri(uri);
	} catch {
		return undefined;
	}
	if (!ref) return undefined;
	if (ref.scheme === "pr" || ref.scheme === "issue") return githubOpenUrl(ref, resource);
	if (ref.scheme === "vault") {
		const file = vaultOpenPath(ref, resource);
		if (!file || file === "context") return undefined;
		const vault = resourceMetadataString(resource, "vaultName") ?? "blueprints";
		return `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(file)}`;
	}
	if (ref.scheme === "local") {
		const path =
			resource?.path && isAbsolute(resource.path)
				? resource.path
				: context.sessionId
					? localResourcePath(ref, context)
					: undefined;
		return path ? pathToFileURL(path).href : undefined;
	}
	if (ref.scheme === "skill") {
		const sourcePath = resourceMetadataString(resource, "sourcePath") ?? resource?.path;
		return sourcePath && isAbsolute(sourcePath) ? pathToFileURL(sourcePath).href : undefined;
	}
	if (ref.scheme === "artifact") {
		const path = resource?.path;
		return path && isAbsolute(path) ? pathToFileURL(path).href : undefined;
	}
	return undefined;
}

export function registerResourceProvider(scheme: ResourceScheme, provider: ResourceProvider): () => void {
	const previous = providers.get(scheme);
	providers.set(scheme, provider);
	return () => {
		if (providers.get(scheme) !== provider) return;
		if (previous) providers.set(scheme, previous);
		else providers.delete(scheme);
	};
}

export function resourceProvider(scheme: ResourceScheme): ResourceProvider | undefined {
	return providers.get(scheme);
}

function refFor(value: string | ResourceRef): ResourceRef {
	if (typeof value !== "string") return value;
	const ref = parseResourceUri(value);
	if (!ref) throw new ResourceError("malformed_uri", `Not a resource URI: ${value}`);
	return ref;
}

function providerFor(ref: ResourceRef): ResourceProvider {
	const provider = providers.get(ref.scheme);
	if (!provider) throw new ResourceError("missing_provider", `No provider registered for ${formatResourceUri(ref)}`);
	return provider;
}

export function isResourceUri(value: string): boolean {
	return /^([a-z][a-z0-9+.-]*):\/\//i.test(value);
}

export async function readResource(value: string | ResourceRef, context?: ResourceContext): Promise<ReadResult> {
	const ref = refFor(value);
	return providerFor(ref).read(ref, context);
}

export async function searchResources(request: SearchRequest): Promise<SearchHit[]> {
	if (request.scope) providerFor(request.scope);
	const providersToSearch = request.scope ? [providerFor(request.scope)] : [...providers.values()];
	const limit = Math.max(1, Math.min(100, Math.floor(request.limit ?? 50)));
	const hits = (await Promise.all(providersToSearch.map((provider) => provider.search({ ...request, limit })))).flat();
	return hits
		.sort((left, right) => (right.score ?? 0) - (left.score ?? 0) || left.uri.localeCompare(right.uri))
		.slice(0, limit);
}

export async function findResources(value: string | ResourceRef, context?: ResourceContext): Promise<Resource[]> {
	const ref = refFor(value);
	return providerFor(ref).find(ref, context);
}

export async function writeResource(value: string | ResourceRef, request: WriteRequest): Promise<WriteResult> {
	const ref = refFor(value);
	const provider = providerFor(ref);
	if (!provider.write) throw new ResourceError("read_only", `Resource is read-only: ${formatResourceUri(ref)}`);
	return provider.write(ref, request);
}
export async function resourceCapabilities(
	value: string | ResourceRef,
	context?: ResourceContext,
): Promise<ResourceCapabilities> {
	const ref = refFor(value);
	const provider = providerFor(ref);
	if (!provider.capabilities)
		throw new ResourceError("unsupported_action", `Capabilities are not supported: ${formatResourceUri(ref)}`);
	return provider.capabilities(ref, context);
}
