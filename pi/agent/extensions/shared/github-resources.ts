import { createHash } from "node:crypto";
import { runCommand } from "./command-runner.ts";
import {
	formatResourceUri,
	type Resource,
	type ResourceCapabilities,
	type ResourceContext,
	ResourceError,
	type ResourceProvider,
	type ResourceRef,
	type SearchHit,
} from "./resources.ts";

type GhRecord = Record<string, unknown>;

type GitHubTarget = {
	repo?: string;
	number?: string;
	variant?: string;
};

type RepositoryInfo = {
	owner: string;
	name: string;
	defaultBranch: string;
};
const PULL_REQUEST_THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!,$first:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:$first,after:$after){totalCount pageInfo{hasNextPage,endCursor} nodes{id,isResolved comments(first:100){nodes{author{login} bodyText path line diffHunk url createdAt}}}}}}}`;
const PULL_REQUEST_CLOSING_ISSUES_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){closingIssuesReferences(first:100){nodes{number,title,state,url}}}}}`;

const PULL_REQUEST_STACK_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){stack{size entries(first:50){nodes{position pullRequest{number title state isDraft mergedAt mergeable mergeStateStatus url headRefName baseRefName}}}}}}}`;
const PULL_REQUEST_REVIEW_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){totalCount nodes{isResolved comments(first:100){nodes{author{login} bodyText}}}}}}}`;

function target(ref: ResourceRef): GitHubTarget {
	const segments = ref.path.replace(/^\/+/, "").split("/").filter(Boolean);
	if (ref.authority === "current") return { number: segments[0], variant: segments[1] };
	if (ref.authority === "github.com" && segments.length >= 3) {
		return { repo: `${segments[0]}/${segments[1]}`, number: segments[2], variant: segments[3] };
	}
	const repo = segments.shift();
	return { repo: repo ? `${ref.authority}/${repo}` : undefined, number: segments[0], variant: segments[1] };
}

function ghArgs(args: string[], targetValue: GitHubTarget): string[] {
	return targetValue.repo ? [...args, "--repo", targetValue.repo] : args;
}

async function gh(
	args: string[],
	targetValue: GitHubTarget,
	context: ResourceContext | undefined,
	baseCwd: string,
): Promise<string> {
	const result = await runCommand("gh", ghArgs(args, targetValue), context?.cwd ?? baseCwd, {
		signal: context?.signal,
		allowNonZero: false,
	});
	return result.stdout;
}

async function ghApi(
	args: string[],
	context: ResourceContext | undefined,
	baseCwd: string,
	input?: string,
): Promise<string> {
	const result = await runCommand("gh", args, context?.cwd ?? baseCwd, {
		signal: context?.signal,
		allowNonZero: false,
		input,
	});
	return result.stdout;
}

async function optionalGh(
	args: string[],
	targetValue: GitHubTarget,
	context: ResourceContext | undefined,
	baseCwd: string,
): Promise<string | undefined> {
	try {
		return await gh(args, targetValue, context, baseCwd);
	} catch {
		return undefined;
	}
}

async function optionalGhApi(
	args: string[],
	context: ResourceContext | undefined,
	baseCwd: string,
): Promise<string | undefined> {
	try {
		return await ghApi(args, context, baseCwd);
	} catch {
		return undefined;
	}
}

function resourceFor(ref: ResourceRef, record: GhRecord, kind: string, content?: string): Resource {
	const repository = stringValue(record.repository) ?? target(ref).repo;
	return {
		uri: formatResourceUri(ref),
		name: String(record.number ?? record.databaseId ?? record.id ?? ref.path),
		title:
			typeof record.title === "string"
				? record.title
				: typeof record.displayTitle === "string"
					? record.displayTitle
					: typeof record.name === "string"
						? record.name
						: undefined,
		kind,
		mediaType: "text/plain",
		size: content === undefined ? undefined : Buffer.byteLength(content, "utf8"),
		modifiedAt:
			typeof record.updatedAt === "string"
				? record.updatedAt
				: typeof record.updated_at === "string"
					? record.updated_at
					: undefined,
		version:
			stringValue(record.version) ??
			stringValue(record.resourceVersion) ??
			stringValue(record.headSha) ??
			stringValue(record.updatedAt) ??
			stringValue(record.updated_at),
		metadata: repository ? { ...record, repository } : record,
	};
}

function parseRecords(text: string): GhRecord[] {
	const value = JSON.parse(text) as unknown;
	if (!Array.isArray(value)) throw new Error("GitHub CLI returned a non-array result");
	return value.filter((item): item is GhRecord => !!item && typeof item === "object");
}

function parseRecord(text: string): GhRecord {
	const value = JSON.parse(text) as unknown;
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("GitHub CLI returned a non-object result");
	return value as GhRecord;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function jsonContent(record: GhRecord): string {
	return JSON.stringify(record, null, 2);
}

const ACTION_VIEW_FIELDS =
	"attempt,conclusion,createdAt,databaseId,displayTitle,event,headBranch,headSha,jobs,name,number,startedAt,status,updatedAt,url,workflowDatabaseId,workflowName";

function actionLogTail(content: string, limit = 8): string[] {
	return content
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.slice(-limit);
}

function matchesQuery(record: GhRecord, query: string): boolean {
	if (!query.trim()) return true;
	const haystack = JSON.stringify(record).toLowerCase();
	return query
		.toLowerCase()
		.trim()
		.split(/\s+/)
		.every((token) => haystack.includes(token));
}

function commandForScheme(scheme: ResourceRef["scheme"]): "pr" | "issue" | "action" {
	if (scheme === "pr" || scheme === "issue" || scheme === "action") return scheme;
	throw new Error(`Unsupported GitHub resource scheme: ${scheme}`);
}

function listArgs(scheme: "pr" | "issue" | "action", limit: number, query: string): string[] {
	if (scheme === "pr")
		return [
			"pr",
			"list",
			"--json",
			"number,title,state,url,author,updatedAt",
			"--limit",
			String(limit),
			...(query ? ["--search", query] : []),
		];
	if (scheme === "issue")
		return [
			"issue",
			"list",
			"--json",
			"number,title,state,url,author,updatedAt",
			"--limit",
			String(limit),
			...(query ? ["--search", query] : []),
		];
	return [
		"run",
		"list",
		"--json",
		"databaseId,displayTitle,name,status,conclusion,url,createdAt,updatedAt,headBranch,headSha,event,workflowName",
		"--limit",
		String(limit),
	];
}

function repositoryParts(value: string | undefined): { owner: string; name: string } | undefined {
	if (!value) return undefined;
	const [owner, name] = value.split("/", 2);
	return owner && name ? { owner, name } : undefined;
}

async function repositoryInfo(
	targetValue: GitHubTarget,
	context: ResourceContext | undefined,
	baseCwd: string,
): Promise<RepositoryInfo> {
	const args = [
		"repo",
		"view",
		...(targetValue.repo ? [targetValue.repo] : []),
		"--json",
		"nameWithOwner,defaultBranchRef",
	];
	const record = parseRecord(await ghApi(args, context, baseCwd));
	const nameWithOwner = typeof record.nameWithOwner === "string" ? record.nameWithOwner : undefined;
	const parts = repositoryParts(nameWithOwner ?? targetValue.repo);
	const defaultBranchRef = record.defaultBranchRef;
	const defaultBranch =
		defaultBranchRef &&
		typeof defaultBranchRef === "object" &&
		typeof (defaultBranchRef as GhRecord).name === "string"
			? ((defaultBranchRef as GhRecord).name as string)
			: "main";
	if (!parts) throw new Error("GitHub repository has no owner/name");
	return { ...parts, defaultBranch };
}

async function requiredCheckContexts(
	info: RepositoryInfo,
	branch: string,
	context: ResourceContext | undefined,
	baseCwd: string,
): Promise<string[]> {
	const response = await optionalGhApi(
		[
			"api",
			`repos/${info.owner}/${info.name}/branches/${encodeURIComponent(branch)}/protection/required_status_checks/contexts`,
		],
		context,
		baseCwd,
	);
	if (!response) return [];
	try {
		const value = JSON.parse(response) as unknown;
		return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
	} catch {
		return [];
	}
}

async function enrichRequiredChecks(
	record: GhRecord,
	scheme: "pr" | "action",
	targetValue: GitHubTarget,
	context: ResourceContext | undefined,
	baseCwd: string,
): Promise<void> {
	let branch = stringValue(record.baseRefName);
	if (!branch && scheme === "action") {
		const head = stringValue(record.headBranch);
		if (head) {
			const pullRequests = await optionalGh(
				["pr", "list", "--head", head, "--state", "open", "--limit", "10", "--json", "baseRefName"],
				targetValue,
				context,
				baseCwd,
			);
			if (pullRequests) {
				const records = parseRecords(pullRequests);
				branch = stringValue(records[0]?.baseRefName);
			}
		}
	}
	if (!branch) return;
	const info = await repositoryInfo(targetValue, context, baseCwd).catch(() => undefined);
	if (!info) return;
	const required = await requiredCheckContexts(info, branch, context, baseCwd);
	if (required.length > 0) record.requiredChecks = required;
}

function stackEntries(value: unknown): GhRecord[] {
	if (!value || typeof value !== "object") return [];
	const stack = value as GhRecord;
	const entries = stack.entries;
	if (!entries || typeof entries !== "object") return [];
	const nodes = (entries as GhRecord).nodes;
	if (!Array.isArray(nodes)) return [];
	return nodes
		.filter((node): node is GhRecord => !!node && typeof node === "object")
		.map((node) => {
			const pullRequest = node.pullRequest;
			if (!pullRequest || typeof pullRequest !== "object") return undefined;
			return {
				...(pullRequest as GhRecord),
				stackPosition: node.position,
			};
		})
		.filter((entry): entry is GhRecord => Boolean(entry));
}

async function nativePullRequestStack(
	targetValue: GitHubTarget,
	number: string,
	context: ResourceContext | undefined,
	baseCwd: string,
): Promise<GhRecord[] | undefined> {
	const info = await repositoryInfo(targetValue, context, baseCwd);
	const response = await optionalGhApi(
		[
			"api",
			"graphql",
			"-f",
			`query=${PULL_REQUEST_STACK_QUERY}`,
			"-F",
			`owner=${info.owner}`,
			"-F",
			`name=${info.name}`,
			"-F",
			`number=${number}`,
		],
		context,
		baseCwd,
	);
	if (!response) return undefined;
	const root = parseRecord(response).data;
	if (!root || typeof root !== "object") return undefined;
	const repository = (root as GhRecord).repository;
	if (!repository || typeof repository !== "object") return undefined;
	const pullRequest = (repository as GhRecord).pullRequest;
	if (!pullRequest || typeof pullRequest !== "object") return undefined;
	const entries = stackEntries((pullRequest as GhRecord).stack);
	return entries.length > 1 ? entries : undefined;
}
async function unresolvedPullRequestComments(
	targetValue: GitHubTarget,
	number: string,
	context: ResourceContext | undefined,
	baseCwd: string,
): Promise<
	| {
			total: number;
			unresolved: number;
			unresolvedAuthors: string[];
			unresolvedCommentPreviews: Array<{ author?: string; firstLine?: string }>;
	  }
	| undefined
> {
	const info = await repositoryInfo(targetValue, context, baseCwd);
	const response = await optionalGhApi(
		[
			"api",
			"graphql",
			"-f",
			`query=${PULL_REQUEST_REVIEW_QUERY}`,
			"-F",
			`owner=${info.owner}`,
			"-F",
			`name=${info.name}`,
			"-F",
			`number=${number}`,
		],
		context,
		baseCwd,
	);
	if (!response) return undefined;
	const root = parseRecord(response).data;
	if (!root || typeof root !== "object") return undefined;
	const repository = (root as GhRecord).repository;
	if (!repository || typeof repository !== "object") return undefined;
	const pullRequest = (repository as GhRecord).pullRequest;
	if (!pullRequest || typeof pullRequest !== "object") return undefined;
	const reviewThreads = (pullRequest as GhRecord).reviewThreads;
	if (!reviewThreads || typeof reviewThreads !== "object") return undefined;
	const nodes = (reviewThreads as GhRecord).nodes;
	if (!Array.isArray(nodes)) return undefined;
	const unresolvedAuthors = new Set<string>();
	const unresolvedCommentPreviews: Array<{ author?: string; firstLine?: string }> = [];
	let unresolved = 0;
	for (const node of nodes) {
		if (!node || typeof node !== "object" || (node as GhRecord).isResolved === true) continue;
		unresolved++;
		const comments = (node as GhRecord).comments;
		if (!comments || typeof comments !== "object") continue;
		const commentNodes = (comments as GhRecord).nodes;
		if (!Array.isArray(commentNodes)) continue;
		const firstComment = commentNodes.find(
			(comment): comment is GhRecord => Boolean(comment) && typeof comment === "object",
		);
		const firstAuthor = firstComment?.author;
		const firstLogin =
			firstAuthor && typeof firstAuthor === "object" ? stringValue((firstAuthor as GhRecord).login) : undefined;
		const firstLine = stringValue(firstComment?.bodyText)?.split(/\r?\n/, 1)[0]?.trim() || undefined;
		if (firstLogin) unresolvedAuthors.add(firstLogin);
		if (firstLogin || firstLine) unresolvedCommentPreviews.push({ author: firstLogin, firstLine });
		for (const comment of commentNodes) {
			if (!comment || typeof comment !== "object") continue;
			const author = (comment as GhRecord).author;
			const login = author && typeof author === "object" ? stringValue((author as GhRecord).login) : undefined;
			if (login) unresolvedAuthors.add(login);
		}
	}
	const totalCount = (reviewThreads as GhRecord).totalCount;
	const total = typeof totalCount === "number" ? totalCount : nodes.length;
	return { total, unresolved, unresolvedAuthors: [...unresolvedAuthors], unresolvedCommentPreviews };
}

function stackListFields(): string {
	return "number,title,state,isDraft,mergedAt,mergeable,mergeStateStatus,url,headRefName,baseRefName";
}

async function branchPullRequestStack(
	record: GhRecord,
	targetValue: GitHubTarget,
	context: ResourceContext | undefined,
	baseCwd: string,
): Promise<GhRecord[] | undefined> {
	const head = typeof record.headRefName === "string" ? record.headRefName : undefined;
	const base = typeof record.baseRefName === "string" ? record.baseRefName : undefined;
	if (!head || !base) return undefined;

	const info = await repositoryInfo(targetValue, context, baseCwd);
	if (base === info.defaultBranch) return undefined;
	const records = parseRecords(
		await gh(
			["pr", "list", "--state", "all", "--limit", "100", "--json", stackListFields()],
			targetValue,
			context,
			baseCwd,
		),
	);
	const currentNumber = String(record.number ?? "");
	const byHead = new Map<string, GhRecord>();
	const byBase = new Map<string, GhRecord>();
	for (const candidate of records) {
		const candidateHead = typeof candidate.headRefName === "string" ? candidate.headRefName : undefined;
		const candidateBase = typeof candidate.baseRefName === "string" ? candidate.baseRefName : undefined;
		if (candidateHead && !byHead.has(candidateHead)) byHead.set(candidateHead, candidate);
		if (candidateBase && !byBase.has(candidateBase)) byBase.set(candidateBase, candidate);
	}

	const ancestors: GhRecord[] = [];
	const seenBranches = new Set<string>([head]);
	let cursor = record;
	for (let depth = 0; depth < 25; depth++) {
		const cursorBase = typeof cursor.baseRefName === "string" ? cursor.baseRefName : undefined;
		if (!cursorBase || cursorBase === info.defaultBranch || seenBranches.has(cursorBase)) break;
		const parent = byHead.get(cursorBase);
		if (!parent || String(parent.number ?? "") === currentNumber) break;
		ancestors.push(parent);
		seenBranches.add(cursorBase);
		cursor = parent;
	}

	const descendants: GhRecord[] = [];
	seenBranches.add(base);
	cursor = record;
	for (let depth = 0; depth < 25; depth++) {
		const cursorHead = typeof cursor.headRefName === "string" ? cursor.headRefName : undefined;
		if (!cursorHead) break;
		const child = byBase.get(cursorHead);
		if (!child || String(child.number ?? "") === currentNumber) break;
		const childHead = typeof child.headRefName === "string" ? child.headRefName : undefined;
		if (!childHead || seenBranches.has(childHead)) break;
		descendants.push(child);
		seenBranches.add(childHead);
		cursor = child;
	}

	const entries = [...ancestors.reverse(), record, ...descendants];
	return entries.length > 1 ? entries.map((entry, index) => ({ ...entry, stackPosition: index + 1 })) : undefined;
}

async function enrichPullRequest(
	record: GhRecord,
	targetValue: GitHubTarget,
	context: ResourceContext | undefined,
	baseCwd: string,
): Promise<void> {
	const number = String(record.number ?? "");
	if (!number) return;
	const stack = await nativePullRequestStack(targetValue, number, context, baseCwd).catch(() => undefined);
	if (stack) record.stack = stack;
	else {
		const fallback = await branchPullRequestStack(record, targetValue, context, baseCwd).catch(() => undefined);
		if (fallback) record.stack = fallback;
	}
	await enrichRequiredChecks(record, "pr", targetValue, context, baseCwd);
	const reviewThreads = await unresolvedPullRequestComments(targetValue, number, context, baseCwd).catch(
		() => undefined,
	);
	if (reviewThreads) {
		record.reviewCommentCount = reviewThreads.total;
		record.unresolvedReviewComments = reviewThreads.unresolved;
		record.resolvedReviewComments = Math.max(0, reviewThreads.total - reviewThreads.unresolved);
		record.unresolvedReviewCommentAuthors = reviewThreads.unresolvedAuthors;
		record.unresolvedReviewCommentPreviews = reviewThreads.unresolvedCommentPreviews;
	}
}

const GITHUB_ACCEPT = "Accept: application/vnd.github+json";
const BLOCKED_DEPENDENCY_BATCH_SIZE = 50;

type GitHubPageWindow = {
	page: number;
	perPage: number;
	limit: number;
	offset: number;
	skip: number;
};

function viewParts(ref: ResourceRef): { view?: string; query: Record<string, string> } {
	const query = { ...ref.query };
	if (!ref.fragment) return { query };
	const [view, fragmentQuery] = ref.fragment.split("?", 2);
	if (fragmentQuery) {
		for (const [key, value] of new URLSearchParams(fragmentQuery)) query[key] = value;
	}
	return { view: view || undefined, query };
}

function queryInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
	const parsed = value === undefined ? NaN : Number(value);
	return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, Math.floor(parsed))) : fallback;
}

function pageWindow(query: Record<string, string>, defaultLimit = 100): GitHubPageWindow {
	const perPage = queryInteger(query.per_page ?? query.page_size, Math.min(100, defaultLimit), 1, 100);
	const limit = queryInteger(query.limit, defaultLimit, 1, 1000);
	const requestedPage = query.page ? queryInteger(query.page, 1, 1, Number.MAX_SAFE_INTEGER) : undefined;
	const requestedOffset =
		query.offset === undefined
			? ((requestedPage ?? 1) - 1) * perPage
			: queryInteger(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
	const page = query.offset === undefined ? (requestedPage ?? 1) : Math.floor(requestedOffset / perPage) + 1;
	const offset = requestedOffset;
	const skip = offset % perPage;
	return { page, perPage, limit, offset, skip };
}

function pageQuery(query: Record<string, string>, page: number, perPage: number): string {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(query)) {
		if (!["offset", "limit", "page", "per_page", "page_size"].includes(key)) params.set(key, value);
	}
	params.set("page", String(page));
	params.set("per_page", String(perPage));
	return params.toString();
}

function endpoint(info: RepositoryInfo, path: string, query?: string): string {
	const base = `repos/${info.owner}/${info.name}/${path}`;
	return query ? `${base}?${query}` : base;
}

async function githubApi(
	endpointValue: string,
	context: ResourceContext | undefined,
	baseCwd: string,
	options: { method?: string; input?: unknown; accept?: string } = {},
): Promise<unknown> {
	const args = ["api", endpointValue, "-H", options.accept ?? GITHUB_ACCEPT];
	if (options.method && options.method !== "GET") args.push("-X", options.method);
	if (options.input !== undefined) args.push("--input", "-");
	const text = await ghApi(
		args,
		context,
		baseCwd,
		options.input === undefined ? undefined : JSON.stringify(options.input),
	);
	if (!text.trim()) return undefined;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return text;
	}
}

function githubUser(value: unknown): GhRecord | undefined {
	if (!value || typeof value !== "object") return undefined;
	const login = stringValue((value as GhRecord).login);
	return login ? { login } : undefined;
}

function normalizeGitHubRecord(value: GhRecord, scheme: "pr" | "issue"): GhRecord {
	const user = githubUser(value.user);
	const mergedAt = stringValue(value.merged_at);
	const base = value.base;
	const head = value.head;
	const isPullRequest = scheme === "pr";
	return {
		...value,
		state: isPullRequest && mergedAt ? "MERGED" : String(value.state ?? "").toUpperCase(),
		author: user ?? value.author,
		url: stringValue(value.html_url) ?? value.url,
		createdAt: value.created_at ?? value.createdAt,
		updatedAt: value.updated_at ?? value.updatedAt,
		mergedAt: mergedAt ?? value.mergedAt,
		isDraft: value.draft ?? value.isDraft,
		nodeId: stringValue(value.node_id) ?? stringValue(value.nodeId),
		baseRefName: base && typeof base === "object" ? ((base as GhRecord).ref ?? value.baseRefName) : value.baseRefName,
		headRefName: head && typeof head === "object" ? ((head as GhRecord).ref ?? value.headRefName) : value.headRefName,
		headSha:
			head && typeof head === "object"
				? ((head as GhRecord).sha ?? value.headSha ?? value.headRefOid)
				: (value.headSha ?? value.headRefOid),
		mergeable: value.mergeable === true ? "MERGEABLE" : value.mergeable === false ? "CONFLICTING" : value.mergeable,
		mergeStateStatus:
			typeof value.mergeable_state === "string" ? value.mergeable_state.toUpperCase() : value.mergeStateStatus,
	};
}

function resourceVersion(record: GhRecord): string | undefined {
	const headSha = stringValue(record.headSha) ?? stringValue(record.headRefOid);
	const updatedAt = stringValue(record.updatedAt) ?? stringValue(record.updated_at);
	const mutableState = JSON.stringify({
		title: record.title,
		body: record.body,
		state: record.state,
		stateReason: record.stateReason ?? record.state_reason,
		labels: listValue(record.labels)
			.map((label) => stringValue(label.name) ?? JSON.stringify(label))
			.sort(),
		assignees: assigneeLogins(record).sort(),
		milestone:
			record.milestone && typeof record.milestone === "object"
				? {
						id: (record.milestone as GhRecord).id,
						number: (record.milestone as GhRecord).number,
					}
				: record.milestone,
		baseRefName: record.baseRefName,
		isDraft: record.isDraft,
	});
	const digest = createHash("sha256").update(mutableState).digest("hex").slice(0, 16);
	const base = headSha ?? updatedAt ?? (typeof record.id === "number" ? String(record.id) : stringValue(record.id));
	return base ? `${base}@${digest}` : digest;
}

function collectionItemRef(ref: ResourceRef, id: string): ResourceRef {
	const basePath = ref.path.replace(/\/+$/, "");
	return { ...ref, path: `${basePath}/${id}`, fragment: undefined, query: {} };
}
function collectionScopeRef(ref: ResourceRef): ResourceRef {
	const segments = ref.path.replace(/^\/+/, "").split("/").filter(Boolean);
	if (segments.length === 0 || !target(ref).number) return { ...ref, fragment: undefined, query: {} };
	return {
		...ref,
		path: `/${segments.slice(0, -1).join("/")}`,
		fragment: undefined,
		query: {},
	};
}
function workflowItemRef(ref: ResourceRef, id: string): ResourceRef {
	const item = collectionItemRef(ref, id);
	return { ...item, path: `${item.path}/log` };
}
function formatViewUri(ref: ResourceRef, query: Record<string, string>): string {
	const view = ref.fragment?.split("?", 2)[0];
	return formatResourceUri({ ...ref, fragment: view || undefined, query });
}

function nextPageUri(ref: ResourceRef, offset: number, perPage: number): string {
	const { query } = viewParts(ref);
	const nextQuery = Object.fromEntries(Object.entries(query).filter(([key]) => key !== "page" && key !== "offset"));
	return formatViewUri(ref, { ...nextQuery, offset: String(offset), per_page: String(perPage) });
}

function pagedPayload(
	ref: ResourceRef,
	items: unknown[],
	window: GitHubPageWindow,
	hasMoreOverride?: boolean,
): Record<string, unknown> {
	const selected = items.slice(window.skip, window.skip + window.limit);
	const hasMore = (hasMoreOverride ?? items.length >= window.perPage) || items.length > window.skip + window.limit;
	return {
		items: selected,
		page: window.page,
		perPage: window.perPage,
		offset: window.offset,
		limit: window.limit,
		hasMore,
		...(hasMore ? { next: nextPageUri(ref, window.offset + window.limit, window.perPage) } : {}),
	};
}

function sortGitHubRecords(records: GhRecord[]): GhRecord[] {
	return [...records].sort(
		(left, right) =>
			Number(left.number ?? left.databaseId ?? 0) - Number(right.number ?? right.databaseId ?? 0) ||
			String(left.title ?? left.name ?? "").localeCompare(String(right.title ?? right.name ?? "")),
	);
}

async function blockedDependencyFlags(
	info: RepositoryInfo,
	numbers: string[],
	context: ResourceContext | undefined,
	baseCwd: string,
): Promise<Map<string, boolean>> {
	const uniqueNumbers = [...new Set(numbers)].filter((number) => Number.isSafeInteger(Number(number)));
	if (uniqueNumbers.length === 0) return new Map();
	const aliases = uniqueNumbers.map(
		(number, index) => `i${index}:issue(number:${Number(number)}){issueDependenciesSummary{blockedBy}}`,
	);
	const data = await githubGraphql(
		`query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${aliases.join("")}}}`,
		{ owner: info.owner, name: info.name },
		context,
		baseCwd,
	);
	const repository = data.repository;
	const flags = new Map<string, boolean>();
	for (const [index, number] of uniqueNumbers.entries()) {
		const issue = repository && typeof repository === "object" ? (repository as GhRecord)[`i${index}`] : undefined;
		const summary = issue && typeof issue === "object" ? (issue as GhRecord).issueDependenciesSummary : undefined;
		const blockedBy = summary && typeof summary === "object" ? Number((summary as GhRecord).blockedBy) : 0;
		flags.set(number, Number.isFinite(blockedBy) && blockedBy > 0);
	}
	return flags;
}
function normalizeGraphqlIssue(value: GhRecord): GhRecord {
	const labels = value.labels && typeof value.labels === "object" ? listValue((value.labels as GhRecord).nodes) : [];
	const assignees =
		value.assignees && typeof value.assignees === "object" ? listValue((value.assignees as GhRecord).nodes) : [];
	return normalizeGitHubRecord({ ...value, user: value.author, labels, assignees }, "issue");
}

function matchesBlockedIssue(record: GhRecord, query: Record<string, string>): boolean {
	if (query.author && resourceLogin(record.author)?.toLowerCase() !== query.author.replace(/^@/, "").toLowerCase())
		return false;
	if (query.draft && query.draft !== "false") return false;
	if (query.labels) {
		const labels = new Set(listValue(record.labels).map((label) => stringValue(label.name)?.toLowerCase()));
		if (
			query.labels
				.split(",")
				.map((label) => label.trim().toLowerCase())
				.filter(Boolean)
				.some((label) => !labels.has(label))
		)
			return false;
	}
	if (query.assignee) {
		const assignee = query.assignee.replace(/^@/, "").toLowerCase();
		const assignees = assigneeLogins(record).map((login) => login.toLowerCase());
		if (assignee === "none" ? assignees.length > 0 : !assignees.includes(assignee)) return false;
	}
	if (query.milestone) {
		const milestone = record.milestone && typeof record.milestone === "object" ? (record.milestone as GhRecord) : {};
		const value = query.milestone.toLowerCase();
		if (value === "none") return !record.milestone;
		if (
			String(milestone.number ?? "").toLowerCase() !== value &&
			String(milestone.title ?? "").toLowerCase() !== value
		)
			return false;
	}
	return true;
}

async function listBlockedGitHubIssues(
	info: RepositoryInfo,
	context: ResourceContext | undefined,
	baseCwd: string,
	query: Record<string, string>,
	window: GitHubPageWindow,
	scanAll: boolean,
): Promise<{ records: GhRecord[]; window: GitHubPageWindow; info: RepositoryInfo; hasMore: boolean }> {
	const requestedState = (query.state ?? "all").toLowerCase();
	if (requestedState === "merged") return { records: [], window, info, hasMore: false };
	const states = requestedState === "open" ? "[OPEN]" : requestedState === "closed" ? "[CLOSED]" : "[OPEN,CLOSED]";
	const orderField = query.sort === "updated" ? "UPDATED_AT" : query.sort === "comments" ? "COMMENTS" : "CREATED_AT";
	const direction = query.direction?.toLowerCase() === "asc" ? "ASC" : "DESC";
	const graphqlQuery = `query($owner:String!,$name:String!,$first:Int!,$after:String){repository(owner:$owner,name:$name){issues(first:$first,after:$after,states:${states},orderBy:{field:${orderField},direction:${direction}}){nodes{number,title,state,stateReason,url,author{login},body,createdAt,updatedAt,labels(first:100){nodes{name,color}},assignees(first:100){nodes{login}},milestone{number,title},issueDependenciesSummary{blockedBy}}pageInfo{hasNextPage,endCursor}}}}`;
	const targetCount = scanAll ? Number.MAX_SAFE_INTEGER : window.offset + window.limit;
	const records: GhRecord[] = [];
	let after: string | null = null;
	let hasNext = false;
	while (true) {
		const data = await githubGraphql(
			graphqlQuery,
			{ owner: info.owner, name: info.name, first: Math.min(100, window.perPage), after },
			context,
			baseCwd,
		);
		const issues =
			data.repository && typeof data.repository === "object" ? (data.repository as GhRecord).issues : undefined;
		const nodes = issues && typeof issues === "object" ? listValue((issues as GhRecord).nodes) : [];
		for (const node of nodes) {
			const summary =
				node.issueDependenciesSummary && typeof node.issueDependenciesSummary === "object"
					? (node.issueDependenciesSummary as GhRecord)
					: undefined;
			if (Number(summary?.blockedBy ?? 0) > 0) {
				const record = normalizeGraphqlIssue(node);
				if (matchesBlockedIssue(record, query)) records.push(record);
			}
		}
		const pageInfo = issues && typeof issues === "object" ? (issues as GhRecord).pageInfo : undefined;
		hasNext = Boolean(pageInfo && typeof pageInfo === "object" && (pageInfo as GhRecord).hasNextPage);
		const endCursor =
			pageInfo && typeof pageInfo === "object" ? stringValue((pageInfo as GhRecord).endCursor) : undefined;
		if (!hasNext || records.length >= targetCount || !endCursor) break;
		after = endCursor;
	}
	const selected = scanAll ? sortGitHubRecords(records) : records.slice(window.offset, window.offset + window.limit);
	return { records: selected, window: { ...window, skip: 0 }, info, hasMore: !scanAll && hasNext };
}

function pullRequestFilter(query: Record<string, string>): {
	reviewer?: string;
	checkState?: string;
} {
	const reviewer = query["review-requested"] ?? query.review_requested;
	const checkState = query["check-state"] ?? query.check_state;
	if (checkState && !["success", "failure", "pending", "none"].includes(checkState.toLowerCase()))
		throw new ResourceError("validation_failed", `Unsupported pull request check-state filter: ${checkState}`);
	return {
		reviewer,
		checkState,
	};
}

async function pullRequestMatchesFilters(
	record: GhRecord,
	query: Record<string, string>,
	info: RepositoryInfo,
	context: ResourceContext | undefined,
	baseCwd: string,
): Promise<boolean> {
	const { reviewer, checkState } = pullRequestFilter(query);
	if (!reviewer && !checkState) return true;
	const number = record.number === undefined ? undefined : String(record.number);
	if (!number) return false;
	if (reviewer) {
		const requested = await githubApi(endpoint(info, `pulls/${number}/requested_reviewers`), context, baseCwd);
		const users = listValue(requested && typeof requested === "object" ? (requested as GhRecord).users : undefined)
			.map((user) => stringValue(user.login)?.toLowerCase())
			.filter((login): login is string => Boolean(login));
		const teams = listValue(requested && typeof requested === "object" ? (requested as GhRecord).teams : undefined)
			.map((team) => stringValue(team.slug) ?? stringValue(team.name))
			.filter((name): name is string => Boolean(name))
			.map((name) => name.toLowerCase());
		const wanted =
			reviewer.replace(/^@/, "").toLowerCase() === "me"
				? stringValue(((await githubApi("user", context, baseCwd)) as GhRecord | undefined)?.login)?.toLowerCase()
				: reviewer.replace(/^@/, "").toLowerCase();
		if (!wanted || (!users.includes(wanted) && !teams.includes(wanted))) return false;
	}
	if (checkState) {
		const sha = stringValue(record.headSha);
		if (!sha) return false;
		const [checkRuns, statuses] = await Promise.all([
			githubApi(endpoint(info, `commits/${sha}/check-runs`), context, baseCwd),
			githubApi(endpoint(info, `commits/${sha}/status`), context, baseCwd),
		]);
		const checks = [
			...listValue(checkRuns && typeof checkRuns === "object" ? (checkRuns as GhRecord).check_runs : undefined),
			...listValue(statuses && typeof statuses === "object" ? (statuses as GhRecord).statuses : undefined),
		];
		const wanted = checkState.toLowerCase();
		const states = checks.map((check) => String(check.conclusion ?? check.state ?? check.status ?? "").toLowerCase());
		const passed = (state: string) => ["success", "neutral", "skipped"].includes(state);
		const failed = (state: string) =>
			["failure", "error", "cancelled", "timed_out", "action_required"].includes(state);
		if (
			(wanted === "success" && (states.length === 0 || !states.every(passed))) ||
			(wanted === "failure" && !states.some(failed)) ||
			(wanted === "pending" &&
				!states.some((state) => !state || state === "pending" || state === "queued" || state === "in_progress")) ||
			(wanted === "none" && states.length > 0)
		)
			return false;
	}
	return true;
}

async function filterGitHubRecords(
	records: GhRecord[],
	scheme: "pr" | "issue",
	requestedState: string,
	query: Record<string, string>,
	info: RepositoryInfo,
	context: ResourceContext | undefined,
	baseCwd: string,
): Promise<GhRecord[]> {
	const filtered = records
		.filter((record) => scheme !== "issue" || !record.pull_request)
		.map((record) => normalizeGitHubRecord(record, scheme))
		.filter((record) => requestedState !== "merged" || Boolean(record.mergedAt))
		.filter(
			(record) =>
				!query.author ||
				resourceLogin(record.author)?.toLowerCase() === query.author.replace(/^@/, "").toLowerCase(),
		)
		.filter((record) => !query.draft || String(Boolean(record.isDraft)) === query.draft);
	if (scheme !== "pr") return filtered;
	const result: GhRecord[] = [];
	for (const record of filtered) {
		if (await pullRequestMatchesFilters(record, query, info, context, baseCwd)) result.push(record);
	}
	return result;
}

async function listGitHubRecords(
	_ref: ResourceRef,
	scheme: "pr" | "issue",
	targetValue: GitHubTarget,
	context: ResourceContext | undefined,
	baseCwd: string,
	query: Record<string, string>,
	scanAll = false,
): Promise<{ records: GhRecord[]; window: GitHubPageWindow; info: RepositoryInfo; hasMore: boolean }> {
	const info = await repositoryInfo(targetValue, context, baseCwd);
	const window = pageWindow(query);
	if (scheme === "issue" && query.blocked?.toLowerCase() === "true")
		return listBlockedGitHubIssues(info, context, baseCwd, query, window, scanAll);
	const requestedState = (query.state ?? "all").toLowerCase();
	const filters = pullRequestFilter(query);
	const clientFilter =
		scheme === "issue" ||
		requestedState === "merged" ||
		Boolean(
			query.author ||
				query.draft ||
				query.blocked?.toLowerCase() === "true" ||
				filters.reviewer ||
				filters.checkState,
		);
	const firstPage = clientFilter ? 1 : window.page;
	const lastPage = clientFilter
		? Number.MAX_SAFE_INTEGER
		: Math.max(window.page, Math.ceil((window.skip + window.limit) / window.perPage) + window.page - 1);
	const rawRecords: GhRecord[] = [];
	const blockedCache = new Map<string, boolean>();
	const cacheBlockedFlags = async (records: GhRecord[], stopAfter = Number.MAX_SAFE_INTEGER): Promise<number> => {
		let matches = 0;
		for (let index = 0; index < records.length && matches < stopAfter; index += BLOCKED_DEPENDENCY_BATCH_SIZE) {
			const chunk = records.slice(index, index + BLOCKED_DEPENDENCY_BATCH_SIZE);
			const numbers = [
				...new Set(
					chunk
						.map((record) => String(record.number ?? ""))
						.filter((number) => number && !blockedCache.has(number)),
				),
			];
			if (numbers.length > 0) {
				const flags = await blockedDependencyFlags(info, numbers, context, baseCwd);
				for (const [number, blocked] of flags) blockedCache.set(number, blocked);
			}
			matches += chunk.filter((record) => blockedCache.get(String(record.number ?? "")) === true).length;
		}
		return matches;
	};
	let remoteHasMore = false;
	for (let page = firstPage; page <= lastPage; page++) {
		const params = new URLSearchParams();
		params.set("state", requestedState === "merged" ? "all" : requestedState);
		params.set("per_page", String(window.perPage));
		params.set("page", String(page));
		if (query.labels) params.set("labels", query.labels);
		if (query.assignee) params.set("assignee", query.assignee.replace(/^@/, ""));
		if (query.milestone) params.set("milestone", query.milestone);
		if (query.sort) params.set("sort", query.sort);
		if (query.direction) params.set("direction", query.direction);
		if (scheme === "pr") {
			if (query.base) params.set("base", query.base);
			if (query.head) params.set("head", query.head);
		}
		const path = scheme === "pr" ? "pulls" : "issues";
		const value = await githubApi(endpoint(info, path, params.toString()), context, baseCwd);
		const pageRecords = Array.isArray(value)
			? value.filter((item): item is GhRecord => Boolean(item) && typeof item === "object")
			: [];
		rawRecords.push(...pageRecords);
		remoteHasMore = pageRecords.length >= window.perPage;
		if (!scanAll && clientFilter) {
			const candidates = await filterGitHubRecords(
				rawRecords,
				scheme,
				requestedState,
				query,
				info,
				context,
				baseCwd,
			);
			const candidateCount =
				query.blocked?.toLowerCase() === "true"
					? await cacheBlockedFlags(candidates, window.offset + window.limit)
					: candidates.length;
			if (candidateCount >= window.offset + window.limit) break;
		}
		if (pageRecords.length < window.perPage) break;
	}
	let records = await filterGitHubRecords(rawRecords, scheme, requestedState, query, info, context, baseCwd);
	if (query.blocked?.toLowerCase() === "true") {
		if (scanAll) await cacheBlockedFlags(records);
		records = records.filter((record) => blockedCache.get(String(record.number ?? "")) === true);
	}
	if (scanAll) records = sortGitHubRecords(records);
	if (clientFilter) {
		const selected = records.slice(window.offset, window.offset + window.limit);
		return {
			records: selected,
			window: { ...window, skip: 0 },
			info,
			hasMore: records.length > window.offset + window.limit || remoteHasMore,
		};
	}
	return {
		records,
		window,
		info,
		hasMore: remoteHasMore,
	};
}

function resourceLogin(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	return stringValue((value as GhRecord).login);
}

async function searchGitHubRecords(
	request: { scope: ResourceRef; query: string; limit?: number; context?: ResourceContext },
	scheme: "pr" | "issue",
	targetValue: GitHubTarget,
	baseCwd: string,
): Promise<{ records: GhRecord[]; info: RepositoryInfo }> {
	const info = await repositoryInfo(targetValue, request.context, baseCwd);
	const window = pageWindow({ ...request.scope.query, limit: String(request.limit ?? 50) }, request.limit ?? 50);
	const blocked =
		request.scope.query.blocked?.toLowerCase() === "true" || /\bblocked\s*:\s*true\b/i.test(request.query);
	const textQuery = request.query.replace(/\bblocked\s*:\s*true\b/gi, "").trim();
	const terms = [`repo:${info.owner}/${info.name}`, textQuery, scheme === "pr" ? "is:pr" : "is:issue"];
	const state = request.scope.query.state?.toLowerCase();
	if (state === "merged") terms.push("is:merged");
	else if (state === "open" || state === "closed") terms.push(`is:${state}`);
	const lastPage = blocked
		? Number.MAX_SAFE_INTEGER
		: window.page + Math.ceil((window.skip + window.limit) / window.perPage) - 1;
	const items: GhRecord[] = [];
	for (let page = window.page; page <= lastPage; page++) {
		const params = new URLSearchParams({
			q: terms.filter(Boolean).join(" "),
			per_page: String(window.perPage),
			page: String(page),
		});
		const value = await githubApi(`search/issues?${params.toString()}`, request.context, baseCwd);
		const pageItems = Array.isArray(value && typeof value === "object" ? (value as GhRecord).items : undefined)
			? ((value as GhRecord).items as unknown[]).filter(
					(item): item is GhRecord => Boolean(item) && typeof item === "object",
				)
			: [];
		if (blocked) {
			const flags = await blockedDependencyFlags(
				info,
				pageItems.map((item) => String(item.number ?? "")),
				request.context,
				baseCwd,
			);
			items.push(...pageItems.filter((item) => flags.get(String(item.number ?? "")) === true));
		} else {
			items.push(...pageItems);
		}
		if (pageItems.length < window.perPage) break;
		if (blocked && items.length >= window.offset + window.limit) break;
	}
	const records =
		scheme === "pr"
			? await filterGitHubRecords(items, scheme, state ?? "all", request.scope.query, info, request.context, baseCwd)
			: items.map((item) => normalizeGitHubRecord(item, scheme));
	return {
		records: records.slice(window.skip, window.skip + window.limit),
		info,
	};
}
function githubViewFields(scheme: "pr" | "issue"): string {
	return scheme === "pr"
		? "number,id,title,state,isDraft,url,author,body,baseRefName,headRefName,headRefOid,headRepository,headRepositoryOwner,mergedAt,createdAt,updatedAt,additions,deletions,changedFiles,reviewDecision,statusCheckRollup,mergeable,mergeStateStatus,comments,reviews,reviewRequests,reactionGroups,labels,assignees,milestone"
		: "number,title,state,stateReason,url,author,body,comments,reactionGroups,createdAt,updatedAt,labels,assignees,milestone";
}

async function loadBaseRecord(
	ref: ResourceRef,
	scheme: "pr" | "issue",
	targetValue: GitHubTarget,
	context: ResourceContext | undefined,
	baseCwd: string,
): Promise<{ record: GhRecord; info: RepositoryInfo }> {
	const number = targetValue.number;
	if (!number)
		throw new ResourceError("invalid_path", `GitHub resource needs an item number: ${formatResourceUri(ref)}`);
	const command = scheme === "pr" ? "pr" : "issue";
	const record = parseRecord(
		await gh([command, "view", number, "--json", githubViewFields(scheme)], targetValue, context, baseCwd),
	);
	const info = await repositoryInfo(targetValue, context, baseCwd);
	record.repository = `${info.owner}/${info.name}`;
	const restValue = await githubApi(
		endpoint(info, `${scheme === "pr" ? "pulls" : "issues"}/${number}`),
		context,
		baseCwd,
	);
	if (restValue && typeof restValue === "object" && !Array.isArray(restValue))
		Object.assign(record, normalizeGitHubRecord(restValue as GhRecord, scheme));
	if (typeof record.id === "string") record.nodeId = record.id;
	record.resourceVersion = resourceVersion(record);
	return { record, info };
}

function viewResource(ref: ResourceRef, value: unknown, kind: string, record: GhRecord = {}): ReadResult {
	const content = typeof value === "string" ? value : JSON.stringify(value, null, 2);
	return { resource: resourceFor(ref, record, kind, content), content };
}
function assigneeLogins(record: GhRecord): string[] {
	return listValue(record.assignees)
		.map((assignee) => stringValue(assignee.login))
		.filter((login): login is string => Boolean(login));
}

function listValue(value: unknown): GhRecord[] {
	return Array.isArray(value)
		? value.filter((item): item is GhRecord => Boolean(item) && typeof item === "object")
		: [];
}

function relatedResourceUri(ref: ResourceRef, record: GhRecord, scheme: "pr" | "issue"): string | undefined {
	const number = record.number === undefined ? undefined : String(record.number);
	if (!number) return undefined;
	if (ref.authority === "current")
		return formatResourceUri({ scheme, authority: "current", path: `/${number}`, query: {} });
	const repository = target(ref).repo;
	if (!repository) return undefined;
	const [owner, name] = repository.split("/", 2);
	if (!owner || !name) return undefined;
	return formatResourceUri({ scheme, authority: "github.com", path: `/${owner}/${name}/${number}`, query: {} });
}

function relationshipItems(ref: ResourceRef, path: string, items: GhRecord[]): GhRecord[] {
	const scheme = path.endsWith("/pulls") ? "pr" : path.includes("/dependencies/") ? "issue" : undefined;
	return scheme ? items.map((item) => ({ ...item, uri: relatedResourceUri(ref, item, scheme) ?? item.url })) : items;
}

async function readPagedView(
	ref: ResourceRef,
	info: RepositoryInfo,
	path: string,
	query: Record<string, string>,
	kind: string,
	context: ResourceContext | undefined,
	baseCwd: string,
): Promise<ReadResult> {
	const window = pageWindow(query);
	const lastPage = window.page + Math.ceil((window.skip + window.limit) / window.perPage) - 1;
	const items: GhRecord[] = [];
	let remoteHasMore = false;
	for (let page = window.page; page <= lastPage; page++) {
		const value = await githubApi(endpoint(info, path, pageQuery(query, page, window.perPage)), context, baseCwd);
		const pageItems = listValue(value);
		items.push(...relationshipItems(ref, path, pageItems));
		remoteHasMore = pageItems.length >= window.perPage;
		if (pageItems.length < window.perPage) break;
	}
	const payload = pagedPayload(ref, items, window, remoteHasMore);
	return viewResource(ref, payload, kind, { title: kind });
}

async function githubGraphql(
	query: string,
	variables: Record<string, unknown>,
	context: ResourceContext | undefined,
	baseCwd: string,
): Promise<GhRecord> {
	const value = await githubApi("graphql", context, baseCwd, { input: { query, variables } });
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("GitHub GraphQL returned no data");
	const errors = (value as GhRecord).errors;
	if (Array.isArray(errors) && errors.length > 0) {
		const message = errors.find((error): error is GhRecord => Boolean(error) && typeof error === "object");
		throw new Error(`GitHub GraphQL error: ${stringValue(message?.message) ?? "unknown error"}`);
	}
	const data = (value as GhRecord).data;
	if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("GitHub GraphQL returned no data");
	return data as GhRecord;
}
async function readPagedGitHubObject(
	ref: ResourceRef,
	info: RepositoryInfo,
	path: string,
	field: string,
	query: Record<string, string>,
	context: ResourceContext | undefined,
	baseCwd: string,
): Promise<GhRecord> {
	const window = pageWindow(query);
	const lastPage = window.page + Math.ceil((window.skip + window.limit) / window.perPage) - 1;
	const items: GhRecord[] = [];
	let template: GhRecord = {};
	let remoteHasMore = false;
	for (let page = window.page; page <= lastPage; page++) {
		const value = await githubApi(endpoint(info, path, pageQuery(query, page, window.perPage)), context, baseCwd);
		if (value && typeof value === "object" && !Array.isArray(value)) {
			template = { ...template, ...(value as GhRecord) };
			items.push(...listValue((value as GhRecord)[field]));
			remoteHasMore = listValue((value as GhRecord)[field]).length >= window.perPage;
		} else {
			remoteHasMore = false;
		}
		if (listValue((value as GhRecord)?.[field]).length < window.perPage) break;
	}
	const selected = items.slice(window.skip, window.skip + window.limit);
	const hasMore = remoteHasMore || items.length > window.skip + window.limit;
	return {
		...template,
		[field]: selected,
		page: window.page,
		perPage: window.perPage,
		offset: window.offset,
		limit: window.limit,
		hasMore,
		...(hasMore ? { next: nextPageUri(ref, window.offset + window.limit, window.perPage) } : {}),
	};
}
function pagedTextPayload(ref: ResourceRef, text: string, query: Record<string, string>): Record<string, unknown> {
	const lines = text.split(/\r?\n/);
	const offset = queryInteger(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
	const limit = queryInteger(query.limit, 100, 1, 1000);
	const selected = lines.slice(offset, offset + limit);
	const hasMore = offset + selected.length < lines.length;
	return {
		text: selected.join("\n"),
		offset,
		limit,
		hasMore,
		...(hasMore
			? {
					next: formatViewUri(ref, { ...query, offset: String(offset + selected.length) }),
				}
			: {}),
	};
}

async function readGitHubView(
	ref: ResourceRef,
	scheme: "pr" | "issue",
	targetValue: GitHubTarget,
	view: string,
	query: Record<string, string>,
	context: ResourceContext | undefined,
	baseCwd: string,
): Promise<ReadResult> {
	const { record, info } = await loadBaseRecord(ref, scheme, targetValue, context, baseCwd);
	const number = targetValue.number!;
	switch (view) {
		case "body": {
			const body = stringValue(record.body) ?? "";
			if (query.offset === undefined && query.limit === undefined)
				return viewResource(ref, body, "github-body", record);
			const lines = body.split(/\r?\n/);
			const offset = queryInteger(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
			const limit = queryInteger(query.limit, 100, 1, 1000);
			const selected = lines.slice(offset, offset + limit);
			return viewResource(
				ref,
				{
					text: selected.join("\n"),
					offset,
					limit,
					hasMore: offset + selected.length < lines.length,
					...(offset + selected.length < lines.length
						? {
								next: formatViewUri(ref, { ...query, offset: String(offset + selected.length) }),
							}
						: {}),
				},
				"github-body-page",
				record,
			);
		}
		case "labels":
			return readPagedView(ref, info, `issues/${number}/labels`, query, "github-labels", context, baseCwd);
		case "assignees": {
			const window = pageWindow(query);
			return viewResource(ref, pagedPayload(ref, listValue(record.assignees), window), "github-assignees", record);
		}
		case "comments":
			return readPagedView(ref, info, `issues/${number}/comments`, query, "github-comments", context, baseCwd);
		case "timeline":
			return readPagedView(ref, info, `issues/${number}/timeline`, query, "github-timeline", context, baseCwd);
		case "pulls":
			return readPagedView(ref, info, `issues/${number}/pulls`, query, "github-linked-pulls", context, baseCwd);
		case "blocked-by":
			return readPagedView(
				ref,
				info,
				`issues/${number}/dependencies/blocked_by`,
				query,
				"github-blocked-by",
				context,
				baseCwd,
			);
		case "blocking":
			return readPagedView(
				ref,
				info,
				`issues/${number}/dependencies/blocking`,
				query,
				"github-blocking",
				context,
				baseCwd,
			);
		case "dependencies": {
			const blockedByResult = await readPagedView(
				ref,
				info,
				`issues/${number}/dependencies/blocked_by`,
				query,
				"github-blocked-by",
				context,
				baseCwd,
			);
			const blockingResult = await readPagedView(
				ref,
				info,
				`issues/${number}/dependencies/blocking`,
				query,
				"github-blocking",
				context,
				baseCwd,
			);
			const blockedByPage = parseRecord(blockedByResult.content);
			const blockingPage = parseRecord(blockingResult.content);
			const blockedBy = listValue(blockedByPage.items);
			const blocking = listValue(blockingPage.items);
			const next = stringValue(blockedByPage.next) ?? stringValue(blockingPage.next);
			return viewResource(
				ref,
				{
					blockedBy,
					blocking,
					blockedByPage,
					blockingPage,
					hasMore: blockedByPage.hasMore === true || blockingPage.hasMore === true,
					...(next ? { next } : {}),
				},
				"github-dependencies",
				record,
			);
		}
		case "diff": {
			const content = await gh(["pr", "diff", number], targetValue, context, baseCwd);
			return viewResource(
				ref,
				query.offset === undefined && query.limit === undefined ? content : pagedTextPayload(ref, content, query),
				"pull-request-diff",
				record,
			);
		}
		case "patch": {
			const content = String(
				await githubApi(endpoint(info, `pulls/${number}`), context, baseCwd, {
					accept: "Accept: application/vnd.github.patch",
				}),
			);
			return viewResource(
				ref,
				query.offset === undefined && query.limit === undefined ? content : pagedTextPayload(ref, content, query),
				"pull-request-patch",
				record,
			);
		}
		case "files":
			return readPagedView(ref, info, `pulls/${number}/files`, query, "pull-request-files", context, baseCwd);
		case "commits":
			return readPagedView(ref, info, `pulls/${number}/commits`, query, "pull-request-commits", context, baseCwd);
		case "reviews":
			return readPagedView(ref, info, `pulls/${number}/reviews`, query, "pull-request-reviews", context, baseCwd);
		case "checks": {
			const sha = stringValue(record.headSha);
			if (!sha)
				throw new ResourceError("validation_failed", `Pull request has no head SHA: ${formatResourceUri(ref)}`);
			const checkRuns = await readPagedGitHubObject(
				ref,
				info,
				`commits/${sha}/check-runs`,
				"check_runs",
				query,
				context,
				baseCwd,
			);
			const status = await readPagedGitHubObject(
				ref,
				info,
				`commits/${sha}/status`,
				"statuses",
				query,
				context,
				baseCwd,
			);
			const next = stringValue(checkRuns.next) ?? stringValue(status.next);
			return viewResource(
				ref,
				{
					checkRuns,
					status,
					hasMore: checkRuns.hasMore === true || status.hasMore === true,
					...(next ? { next } : {}),
				},
				"pull-request-checks",
				record,
			);
		}
		case "threads": {
			const window = pageWindow(query);
			const data = await githubGraphql(
				PULL_REQUEST_THREADS_QUERY,
				{
					owner: info.owner,
					name: info.name,
					number: Number(number),
					first: window.perPage,
					after: query.after ?? null,
				},
				context,
				baseCwd,
			);
			const pullRequest =
				data.repository && typeof data.repository === "object"
					? (data.repository as GhRecord).pullRequest
					: undefined;
			const threads =
				pullRequest && typeof pullRequest === "object" ? (pullRequest as GhRecord).reviewThreads : undefined;
			const nodes = threads && typeof threads === "object" ? listValue((threads as GhRecord).nodes) : [];
			const pageInfo = threads && typeof threads === "object" ? (threads as GhRecord).pageInfo : undefined;
			const hasNext = Boolean(pageInfo && typeof pageInfo === "object" && (pageInfo as GhRecord).hasNextPage);
			const cursor =
				pageInfo && typeof pageInfo === "object" ? stringValue((pageInfo as GhRecord).endCursor) : undefined;
			return viewResource(
				ref,
				{
					items: nodes,
					total: threads && typeof threads === "object" ? (threads as GhRecord).totalCount : nodes.length,
					hasMore: hasNext,
					...(hasNext && cursor ? { next: formatViewUri(ref, { ...query, after: cursor }) } : {}),
				},
				"pull-request-threads",
				record,
			);
		}
		case "issues": {
			const data = await githubGraphql(
				PULL_REQUEST_CLOSING_ISSUES_QUERY,
				{ owner: info.owner, name: info.name, number: Number(number) },
				context,
				baseCwd,
			);
			const pullRequest =
				data.repository && typeof data.repository === "object"
					? (data.repository as GhRecord).pullRequest
					: undefined;
			const references =
				pullRequest && typeof pullRequest === "object"
					? (pullRequest as GhRecord).closingIssuesReferences
					: undefined;
			const closing = references && typeof references === "object" ? listValue((references as GhRecord).nodes) : [];
			const timeline = await githubApi(
				`${endpoint(info, `issues/${number}/timeline`)}?per_page=100`,
				context,
				baseCwd,
			);
			const linked = listValue(timeline)
				.filter((event) => String(event.event ?? "") === "cross-referenced")
				.map((event) => {
					const source = event.source;
					return source && typeof source === "object" ? (source as GhRecord).issue : undefined;
				})
				.filter((item): item is GhRecord => Boolean(item) && typeof item === "object");
			const nodes = [...new Map([...closing, ...linked].map((item) => [String(item.number), item])).values()];
			return viewResource(
				ref,
				{
					...(references && typeof references === "object" ? references : {}),
					nodes: nodes.map((item) => ({ ...item, uri: relatedResourceUri(ref, item, "issue") ?? item.url })),
				},
				"pull-request-issues",
				record,
			);
		}
		case "version":
			return viewResource(ref, { version: resourceVersion(record) }, "github-version", record);
		default:
			throw new ResourceError("unsupported_view", `Unsupported GitHub view "${view}" for ${formatResourceUri(ref)}`);
	}
}
function githubCapabilities(ref: ResourceRef): ResourceCapabilities {
	const scheme = commandForScheme(ref.scheme);
	const views = [
		"capabilities",
		"version",
		"body",
		"comments",
		"timeline",
		"labels",
		"assignees",
		"dependencies",
		"blocked-by",
		"blocking",
	];
	if (scheme === "issue") views.push("pulls");
	if (scheme === "pr") views.push("diff", "patch", "files", "commits", "checks", "reviews", "threads", "issues");
	return {
		providerVersion: "github-resource-v1",
		views,
		fields: [
			"title",
			"body",
			"state",
			"state_reason",
			"labels",
			"assignees",
			"milestone",
			"comments",
			"dependencies",
			...(scheme === "pr" ? ["base", "draft", "reviewers", "reviews", "threads", "merge"] : []),
		],
	};
}
export function githubResourceProvider(baseCwd: string): ResourceProvider {
	return {
		async read(ref, context) {
			const scheme = commandForScheme(ref.scheme);
			const targetValue = target(ref);
			if (scheme === "action") {
				if (!targetValue.number)
					throw new ResourceError("invalid_path", `Workflow resource needs an ID: ${formatResourceUri(ref)}`);
				if (targetValue.variant !== "log")
					throw new ResourceError(
						"unsupported_view",
						`Unsupported workflow view: ${targetValue.variant ?? "default"}`,
					);
				const [content, metadata, info] = await Promise.all([
					gh(["run", "view", targetValue.number, "--log"], targetValue, context, baseCwd),
					gh(["run", "view", targetValue.number, "--json", ACTION_VIEW_FIELDS], targetValue, context, baseCwd),
					repositoryInfo(targetValue, context, baseCwd),
				]);
				const record = parseRecord(metadata);
				record.repository = `${info.owner}/${info.name}`;
				record.logTail = actionLogTail(content);
				return { resource: resourceFor(ref, record, "workflow-log", content), content };
			}
			const { view: fragmentView, query } = viewParts(ref);
			const view = fragmentView ?? targetValue.variant;
			if (view === "capabilities") return viewResource(ref, githubCapabilities(ref), "github-capabilities");
			if (!targetValue.number) {
				throw new ResourceError(
					"invalid_path",
					`GitHub collections are listed with find or search, not read: ${formatResourceUri(ref)}`,
				);
			}
			if (view) return readGitHubView(ref, scheme, targetValue, view, query, context, baseCwd);
			const loaded = await loadBaseRecord(ref, scheme, targetValue, context, baseCwd);
			if (scheme === "pr") await enrichPullRequest(loaded.record, targetValue, context, baseCwd);
			const content = jsonContent(loaded.record);
			return { resource: resourceFor(ref, loaded.record, scheme, content), content };
		},
		async search(request): Promise<SearchHit[]> {
			if (!request.scope || !["pr", "issue", "action"].includes(request.scope.scheme)) return [];
			const scheme = commandForScheme(request.scope.scheme);
			const targetValue = target(request.scope);
			if (scheme === "action") {
				const limit = Math.max(1, Math.min(100, request.limit ?? 50));
				const info = await repositoryInfo(targetValue, request.context, baseCwd);
				const records = parseRecords(
					await gh(listArgs(scheme, limit, request.query), targetValue, request.context, baseCwd),
				);
				return records
					.filter((record) => matchesQuery(record, request.query))
					.slice(0, limit)
					.map((record) => {
						const id = String(record.number ?? record.databaseId ?? record.id);
						record.repository = `${info.owner}/${info.name}`;
						const itemRef = workflowItemRef(request.scope!, id);
						return {
							...resourceFor(itemRef, record, scheme),
							snippet: typeof record.name === "string" ? record.name : undefined,
							score: 1,
						};
					});
			}
			const listed = request.query
				? await searchGitHubRecords(
						{ scope: request.scope, query: request.query, limit: request.limit, context: request.context },
						scheme,
						targetValue,
						baseCwd,
					)
				: await listGitHubRecords(
						request.scope,
						scheme,
						targetValue,
						request.context,
						baseCwd,
						viewParts(request.scope).query,
					);
			const scope = collectionScopeRef(request.scope!);
			return listed.records.slice(0, Math.max(1, Math.min(100, request.limit ?? 50))).map((record) => {
				const id = String(record.number ?? record.databaseId ?? record.id);
				const itemRef = collectionItemRef(scope, id);
				return {
					...resourceFor(itemRef, { ...record, repository: `${listed.info.owner}/${listed.info.name}` }, scheme),
					snippet: typeof record.title === "string" ? record.title : undefined,
					score: 1,
				};
			});
		},
		async find(ref, context) {
			const scheme = commandForScheme(ref.scheme);
			const targetValue = target(ref);
			if (scheme === "action") {
				const info = await repositoryInfo(targetValue, context, baseCwd);
				const records = parseRecords(await gh(listArgs(scheme, 100, ""), targetValue, context, baseCwd));
				return records.map((record) =>
					resourceFor(
						workflowItemRef(ref, String(record.databaseId ?? record.id)),
						{ ...record, repository: `${info.owner}/${info.name}` },
						scheme,
					),
				);
			}
			const listed = await listGitHubRecords(ref, scheme, targetValue, context, baseCwd, viewParts(ref).query, true);
			const scope = collectionScopeRef(ref);
			return listed.records.map((record) =>
				resourceFor(
					collectionItemRef(scope, String(record.number)),
					{ ...record, repository: `${listed.info.owner}/${listed.info.name}` },
					scheme,
				),
			);
		},
		async capabilities(ref) {
			if (!["pr", "issue"].includes(ref.scheme))
				throw new ResourceError("unsupported_action", `Capabilities are not supported: ${formatResourceUri(ref)}`);
			return githubCapabilities(ref);
		},
	};
}
